import * as boltzService from '../services/boltzService';
import { isSwapServerTimeoutError } from '../services/boltzApi';
import { createAbortError, throwIfAborted } from '../services/nwcErrors';
import { paymentHashFromBolt11 } from './bolt11';
import {
  payAndClaimReverseSwap,
  persistReverseSwap,
  type PayInvoiceFn,
  type ReverseSwapStage,
} from './reverseSwapPayClaim';

/** Every stage of a Send-screen reverse swap, in order: create the swap, then
 *  `payAndClaimReverseSwap`'s pay+lockup → claim → cleanup. */
export type ReverseSwapSendStage = 'createSwap' | ReverseSwapStage;

export { SwapSettlingError, isSwapSettlingError } from './reverseSwapPayClaim';

export interface ReverseSwapParams {
  walletId: string;
  /** On-chain BTC address the swapped funds are claimed to. */
  destinationAddress: string;
  /** Exactly what the destination receives; every fee is paid on top (#1175). */
  recipientSats: number;
  approvedQuote?: boltzService.SwapFees;
  signal: AbortSignal;
  /** Usually WalletContext's `payInvoiceForWallet`. */
  payInvoice: PayInvoiceFn;
  onReplyTimeout: () => void;
  onPaymentDispatched?: () => void;
  onStage?: (stage: ReverseSwapSendStage) => void;
  /** Overrides the create-and-persist stage budget (tests). */
  createTimeoutMs?: number;
}

/** Budget for creating + persisting the swap: the create request's own
 *  timeout plus headroom for the secure-store writes that must finish before
 *  paying. Past this the send fails visibly instead of spinning. */
export const REVERSE_SWAP_CREATE_STAGE_TIMEOUT_MS = 45_000;

export class SwapCreateTimeoutError extends Error {
  constructor() {
    super("The swap server didn't finish setting up the swap in time. Nothing was sent.");
    this.name = 'SwapCreateTimeoutError';
  }
}

/** The swap server never finished creating the swap: nothing was sent. */
export function isSwapCreateTimeout(error: unknown): boolean {
  return error instanceof SwapCreateTimeoutError || isSwapServerTimeoutError(error);
}

/**
 * Run `create` with a deadline and the caller's cancel. If either fires first
 * we reject and never return the swap, so the caller can't go on to pay it —
 * even when `create` settles later. The inner signal stops a late result
 * from STARTING to persist; a deadline that fires mid-persist can still leave
 * a record, which is harmless: recovery never pays, and the swap expires.
 */
function withCreateDeadline<T>(
  create: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(createAbortError());
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      settle();
    };
    const cancel = (error: Error) =>
      finish(() => {
        controller.abort();
        reject(error);
      });
    const onAbort = () => cancel(createAbortError());
    const timer = setTimeout(() => cancel(new SwapCreateTimeoutError()), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    create(controller.signal).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** What a completed send delivered and what it cost. */
export interface ReverseSwapReceipt {
  claimTxId: string;
  /** What the claim paid the destination. */
  recipientSats: number;
  /** The Lightning invoice the wallet paid (excluding any routing fee). */
  paidSats: number;
  /** The hold invoice's payment hash: identifies the wallet's Lightning leg,
   *  which can stay pending at the wallet after the claim (#1179). */
  paymentHash: string | null;
}

/**
 * Run a Boltz reverse swap (Lightning → on-chain): create the swap against
 * the approved quote, persist its secrets for crash recovery BEFORE paying,
 * then pay the hold invoice while watching for the lockup and claim as soon
 * as it's verified (see `payAndClaimReverseSwap` for the ordering and the
 * #891 error contract). Swap creation / persistence failures propagate as-is
 * — nothing has been paid yet.
 */
export async function executeReverseSwap(params: ReverseSwapParams): Promise<ReverseSwapReceipt> {
  const { walletId, destinationAddress, recipientSats, signal, payInvoice, onReplyTimeout } =
    params;
  params.onStage?.('createSwap');
  // Bounded: an unanswered create left the Send overlay spinning on "Creating
  // Boltz swap" forever (2026-11-01). Nothing is paid until this resolves, so
  // a timeout is a clean pre-commit failure; a swap Boltz created anyway just
  // expires unpaid.
  const persisted = await withCreateDeadline(
    async (createSignal) => {
      const swap = await boltzService
        .createReverseSwap(
          destinationAddress,
          recipientSats,
          params.approvedQuote,
          'recipient',
          createSignal,
        )
        .catch((error: unknown) => {
          throw isSwapServerTimeoutError(error) ? new SwapCreateTimeoutError() : error;
        });
      throwIfAborted(createSignal);
      return persistReverseSwap(swap, destinationAddress);
    },
    params.createTimeoutMs ?? REVERSE_SWAP_CREATE_STAGE_TIMEOUT_MS,
    signal,
  );
  const { swap } = persisted;
  const claim = await payAndClaimReverseSwap({
    persisted,
    walletId,
    payInvoice,
    signal,
    onReplyTimeout,
    onPaymentDispatched: params.onPaymentDispatched,
    onStage: params.onStage,
  });
  return {
    claimTxId: claim.txId,
    recipientSats: claim.outputSats,
    paidSats: swap.invoiceAmount ?? 0,
    paymentHash: paymentHashFromBolt11(swap.invoice),
  };
}
