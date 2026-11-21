import { AppState } from 'react-native';
import type { NostrWebLNProvider } from '@getalby/sdk';
import { pinNip04IfNoInfoEvent } from './nwcEncryption';
import { patchRelayPublish } from './nwcRelayPublishPatch';

/**
 * A WebLN `listTransactions` row. NOT a raw NIP-47 row: the wrapper has
 * already converted `amount` (and `fees_paid`) from msats to whole sats.
 */
export type BackgroundTransaction = Awaited<
  ReturnType<NostrWebLNProvider['listTransactions']>
>['transactions'][number];

/** Rows read this pass; `complete` is false when a later page failed or ran out of time. */
export interface BackgroundRead {
  rows: BackgroundTransaction[];
  complete: boolean;
}

export const PAGE_SIZE = 20;
export const MAX_PAGES = 5;
// No later page starts once paging has run this long (the SDK waits up to 10 s per reply; the deadline is 25 s).
const PAGE_BUDGET_MS = 15_000;

// Unknown times count as newer, so a page of them is followed rather than cut short.
function isNewerThan(tx: BackgroundTransaction, floor: number): boolean {
  const time = tx?.settled_at ?? tx?.created_at;
  return !Number.isSafeInteger(time) || time >= floor;
}

/** A read-only request on a private connection; never replace the UI's client. */
export async function readBackgroundPayments(
  walletId: string,
  url: string,
  signal: AbortSignal,
  pageFloor: number,
): Promise<BackgroundRead> {
  if (AppState.currentState === 'active' || signal.aborted) return { rows: [], complete: false };
  // Load the SDK only for an opted-in background request, not during headless task registration.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NostrWebLNProvider } = require('@getalby/sdk') as typeof import('@getalby/sdk');
  const provider = new NostrWebLNProvider({ nostrWalletConnectUrl: url });
  // Same no-wait-for-OK patch as nwcService.connect — without it an LNbits
  // Nostrclient relay (no NIP-20 OK) would hold every list_transactions
  // publish until the deadline below and the poll would never notify.
  // Silent on failure: the deadline + next pass cover it, and we never log
  // the SDK error (it can carry relay/wallet details).
  patchRelayPublish(provider, () => {});
  const cacheKey = `background:${walletId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let timedOut = false;
  let complete = true;
  const rows: BackgroundTransaction[] = [];
  const close = () => {
    try {
      provider.close();
    } catch {
      /* already disconnected */
    }
  };
  let cancel: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      cancelled = true;
      close();
      reject(new Error('Background wallet request cancelled or timed out'));
    };
    timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, 25_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') cancel();
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        try {
          if (cancelled) throw new Error('Cancelled');
          await provider.enable();
          if (cancelled) throw new Error('Cancelled');
          await pinNip04IfNoInfoEvent(provider, cacheKey);
          if (cancelled) throw new Error('Cancelled');
          // No `from`: some wallets filter creation time, missing invoices made
          // earlier but settled now. Select by settlement time in the worker.
          // Same public WebLN wrapper nwcService.listTransactions uses.

          // Small pages every minute (#1860): the next only while a whole page is newer than the floor.
          const pagesStartedAt = Date.now();
          let previousFirst: string | undefined;
          for (let page = 0; page < MAX_PAGES; page++) {
            if (cancelled) throw new Error('Cancelled');
            if (page > 0 && Date.now() - pagesStartedAt > PAGE_BUDGET_MS) {
              complete = false;
              break;
            }
            let batch: BackgroundTransaction[];
            try {
              const result = await provider.listTransactions({
                type: 'incoming',
                unpaid: false,
                limit: PAGE_SIZE,
                offset: page * PAGE_SIZE,
              });
              batch = Array.isArray(result.transactions) ? result.transactions : [];
            } catch (error) {
              // A later page failing keeps the newer rows already read.
              if (page === 0 || cancelled) throw error;
              complete = false;
              break;
            }
            if (cancelled) throw new Error('Cancelled');
            // A wallet that ignores `offset` returns the same page again.
            if (page > 0 && batch[0]?.payment_hash && batch[0].payment_hash === previousFirst)
              break;
            previousFirst = batch[0]?.payment_hash;
            rows.push(...batch);
            if (batch.length < PAGE_SIZE || !batch.every((tx) => isNewerThan(tx, pageFloor))) break;
          }
          return { rows: rows.slice(), complete };
        } finally {
          // enable/probe can settle after cancellation; close any late socket.
          if (cancelled) {
            close();
          }
        }
      })(),
    ]);
  } catch (error) {
    // Out of time on a later page: the pages already read hold the newest receipts.
    if (timedOut && rows.length > 0 && !signal.aborted)
      return { rows: rows.slice(), complete: false };
    throw error;
  } finally {
    appStateSubscription.remove();
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    close();
  }
}
