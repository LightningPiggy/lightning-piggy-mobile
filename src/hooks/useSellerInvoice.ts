import { hasInvoiceSettlementProof } from '../services/nwcInvoiceSettlement';
import { useFocusEffect } from '@react-navigation/native';
import { AppState } from 'react-native';
import { useTranslation } from '../contexts/LocaleContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { useWallet } from '../contexts/WalletContext';
import { lookupInvoice } from '../services/nwcService';
import { sendNip17Rumor, Nip17SendError } from '../services/nip17RumorSend';
import {
  loadSellerInvoices,
  sellerInvoiceKey,
  patchSellerInvoice,
  recordSellerInvoice,
  subscribeSellerInvoices,
  type SellerInvoiceRecord,
} from '../services/sellerInvoiceStore';
import { saveSellerReceiveWallet } from '../services/sellerReceiveWallet';
import { amountSatsFromBolt11, paymentHashFromBolt11 } from '../utils/bolt11';
import { extractInvoice } from '../utils/messageContent';
import { sellerRecordIsCurrent } from '../utils/shopOrderStatus';
import { shortOrderId } from '../utils/marketOrder';
import { buildPaymentRequestRumor, buildStatusUpdateRumor } from '../utils/sellerOrderMessages';

// Shared across mounted cards and navigation remounts, scoped to one order/account.
const invoiceActions = new Map<string, Promise<void>>();
async function serializeInvoiceAction(key: string, action: () => Promise<void>): Promise<void> {
  const previous = invoiceActions.get(key) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(action);
  invoiceActions.set(key, run);
  try {
    await run;
  } finally {
    if (invoiceActions.get(key) === run) invoiceActions.delete(key);
  }
}

/** Translatable reason an invoice action failed (`sellerOrders.errors.<code>`). */
export type SellerInvoiceErrorCode =
  | 'noWallet'
  | 'invoiceFailed'
  | 'amountMismatch'
  | 'shopChanged'
  | 'sendFailed'
  | 'notSignedIn';

export class SellerInvoiceError extends Error {
  constructor(
    readonly code: SellerInvoiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SellerInvoiceError';
  }
}

/** Paid-detection cadence for an unpaid invoice while its card is mounted. */
const CHECK_EVERY_MS = 15_000;
const MAX_AUTO_CHECKS = 20;

export interface SendInvoiceInput {
  walletId: string;
  amountSats: number;
  /** Save `walletId` as the shop's "Receive payments to" wallet. */
  remember: boolean;
  /** Explicit wallet-check warning consent, bound to the invoice being replaced. */
  allowUnknownInvoice?: string;
}

export interface UseSellerInvoice {
  /** The invoice I sent for this order from this device, if any. */
  record: SellerInvoiceRecord | null;
  sending: boolean;
  checking: boolean;
  unpaidInvoice: string | null;
  unknownInvoice: string | null;
  sendInvoice: (input: SendInvoiceInput) => Promise<void>;
  /** Ask the wallet the invoice was made on whether it's paid. */
  checkPaid: () => Promise<boolean | null>;
  /** Tell the buyer the order is paid (kind-16 type-3 `confirmed`). */
  markPaid: () => Promise<void>;
}

/**
 * Seller actions for one incoming order: create the invoice on the wallet
 * the seller CHOSE (never implicitly the active one), send it as a Gamma
 * kind-16 type-2 payment request over NIP-17, then watch THAT wallet for
 * payment and confirm with a type-3 status update.
 */
export function useSellerInvoice(
  buyerPubkey: string | null,
  orderId: string | null,
  existingBolt11?: string,
  existingInvoiceAt = 0,
): UseSellerInvoice {
  const { pubkey, signerType, relays } = useNostr();
  const t = useTranslation();
  const { makeInvoiceForWallet } = useWallet();
  const [recordState, setRecordState] = useState<{
    owner: string | null;
    record: SellerInvoiceRecord | null;
  }>({ owner: null, record: null });
  const record = recordState.owner === pubkey ? recordState.record : null;
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [checking, setChecking] = useState(false);
  const [unpaidRecord, setUnpaidRecord] = useState<SellerInvoiceRecord | null>(null);
  const [unknownRecord, setUnknownRecord] = useState<SellerInvoiceRecord | null>(null);
  const identityRef = useRef({ pubkey, buyerPubkey, orderId });
  identityRef.current = { pubkey, buyerPubkey, orderId };
  const lifecycleRef = useRef({ mounted: false, generation: 0 });
  useEffect(() => {
    const lifecycle = lifecycleRef.current;
    lifecycle.mounted = true;
    return () => {
      lifecycle.mounted = false;
      lifecycle.generation += 1;
    };
  }, [pubkey, buyerPubkey, orderId]);
  const active = Boolean(pubkey && buyerPubkey && orderId);

  useEffect(() => {
    if (!active || !pubkey || !orderId) return;
    let cancelled = false;
    const load = () =>
      void loadSellerInvoices(pubkey)
        .then((records) => {
          if (!cancelled)
            setRecordState({
              owner: pubkey,
              record: records[sellerInvoiceKey(buyerPubkey!, orderId)] ?? null,
            });
        })
        .catch(() => undefined);
    load();
    const unsubscribe = subscribeSellerInvoices(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [active, pubkey, buyerPubkey, orderId]);

  const send = useCallback(
    (rumor: Parameters<typeof sendNip17Rumor>[0]['rumor']) =>
      sendNip17Rumor({
        senderPubkey: pubkey,
        signerType,
        relays,
        rumor,
        recipientPubkey: buyerPubkey ?? '',
      }),
    [pubkey, signerType, relays, buyerPubkey],
  );

  const sendInvoice = useCallback(
    async ({ walletId, amountSats, remember, allowUnknownInvoice }: SendInvoiceInput) => {
      if (!pubkey || !buyerPubkey || !orderId) {
        throw new SellerInvoiceError('notSignedIn', 'Sign in to invoice orders');
      }
      if (!walletId) throw new SellerInvoiceError('noWallet', 'Choose a wallet');
      if (!Number.isSafeInteger(amountSats) || amountSats <= 0)
        throw new SellerInvoiceError('amountMismatch', 'Invalid invoice amount');
      const generation = lifecycleRef.current.generation;
      const stillCurrent = () =>
        lifecycleRef.current.mounted &&
        lifecycleRef.current.generation === generation &&
        identityRef.current.pubkey === pubkey &&
        identityRef.current.buyerPubkey === buyerPubkey &&
        identityRef.current.orderId === orderId;
      if (sendingRef.current)
        throw new SellerInvoiceError('sendFailed', 'Invoice action in progress');
      sendingRef.current = true;
      setSending(true);
      try {
        await serializeInvoiceAction(
          `${pubkey.toLowerCase()}:${sellerInvoiceKey(buyerPubkey, orderId)}`,
          async () => {
            if (!stillCurrent()) throw new SellerInvoiceError('notSignedIn', 'Order closed');
            const records = await loadSellerInvoices(pubkey);
            const previous = records[sellerInvoiceKey(buyerPubkey, orderId)];
            if (!stillCurrent()) throw new SellerInvoiceError('notSignedIn', 'Account changed');
            if (
              existingBolt11 &&
              !sellerRecordIsCurrent(previous, {
                bolt11: existingBolt11,
                at: existingInvoiceAt,
                expiresAt: 0,
              })
            )
              throw new SellerInvoiceError('invoiceFailed', 'Original invoice wallet is unknown');
            const expiresAt = previous ? extractInvoice(previous.bolt11)?.expiresAt : null;
            const retry =
              previous?.deliveryPending &&
              !previous.paidAt &&
              !previous.confirmedAt &&
              (expiresAt == null || expiresAt * 1000 > Date.now());
            if (previous && !retry) {
              if (
                previous.paidAt ||
                previous.confirmedAt ||
                expiresAt == null ||
                expiresAt * 1000 > Date.now()
              )
                throw new SellerInvoiceError(
                  'invoiceFailed',
                  'Existing invoice cannot be replaced',
                );
              if (!previous.walletId || !previous.paymentHash)
                throw new SellerInvoiceError('invoiceFailed', 'Original invoice wallet is unknown');
              // Recheck settlement even after the seller acknowledges the unknown-outcome warning.
              const settlement = await lookupInvoice(previous.walletId, previous.paymentHash, {
                replyTimeoutMs: 5000,
              });
              if (!stillCurrent()) throw new SellerInvoiceError('notSignedIn', 'Account changed');
              if (settlement?.paid && hasInvoiceSettlementProof(settlement, previous.paymentHash)) {
                await patchSellerInvoice(pubkey, orderId, buyerPubkey, {
                  paidAt: Date.now(),
                  settlementVersion: 2,
                  settledAt: settlement.settledAt,
                  preimage: settlement.preimage,
                });
              }
              if (
                settlement?.paid !== false &&
                !(settlement?.paid === null && allowUnknownInvoice === previous.bolt11)
              )
                throw new SellerInvoiceError(
                  'invoiceFailed',
                  'Previous invoice is paid or settlement is unknown',
                );
              if (previous.amountSats !== amountSats)
                throw new SellerInvoiceError(
                  'amountMismatch',
                  'Replacement must preserve the approved amount',
                );
            }
            let invoice = retry ? previous : undefined;
            if (invoice && invoice.amountSats !== amountSats)
              throw new SellerInvoiceError(
                'amountMismatch',
                'Retry must preserve the approved amount',
              );
            if (!invoice) {
              let bolt11: string;
              try {
                bolt11 = await makeInvoiceForWallet(
                  walletId,
                  amountSats,
                  t('sellerOrders.orderNumber', { id: shortOrderId(orderId) }),
                );
              } catch (e) {
                throw new SellerInvoiceError(
                  'invoiceFailed',
                  (e as Error)?.message ?? 'make_invoice',
                );
              }
              // Persist even after unmount: a reopened order must reuse this payable invoice.
              // Never send an invoice that charges anything but the total shown.
              if (amountSatsFromBolt11(bolt11) !== amountSats) {
                throw new SellerInvoiceError(
                  'amountMismatch',
                  'Wallet returned a different amount',
                );
              }
              const paymentHash = paymentHashFromBolt11(bolt11);
              if (!paymentHash)
                throw new SellerInvoiceError('invoiceFailed', 'Invoice has no hash');
              invoice = {
                orderId,
                buyerPubkey,
                walletId,
                paymentHash,
                bolt11,
                amountSats,
                sentAt: Date.now(),
                deliveryPending: true,
                replacesBolt11: existingBolt11 ?? previous?.bolt11,
              };
              // The buyer must never receive a payable invoice without its wallet record.
              await recordSellerInvoice(pubkey, invoice);
            }
            if (!stillCurrent()) throw new SellerInvoiceError('notSignedIn', 'Account changed');
            const { bolt11 } = invoice;
            const rumor = buildPaymentRequestRumor({
              sellerPubkey: pubkey,
              buyerPubkey,
              orderId,
              amountSats,
              bolt11,
              expiresAt: extractInvoice(bolt11)?.expiresAt ?? null,
              note: t('sellerOrders.invoiceSent'),
              createdAt: Math.floor(invoice.sentAt / 1000),
            });
            try {
              await send(rumor);
            } catch (e) {
              throw new SellerInvoiceError(
                e instanceof Nip17SendError && e.code === 'notSignedIn'
                  ? 'notSignedIn'
                  : 'sendFailed',
                (e as Error)?.message ?? 'send failed',
              );
            }
            if (!stillCurrent()) throw new SellerInvoiceError('notSignedIn', 'Account changed');
            await patchSellerInvoice(pubkey, orderId, buyerPubkey, { deliveryPending: false });
            if (remember)
              await saveSellerReceiveWallet(pubkey, invoice.walletId).catch(() => undefined);
          },
        );
      } finally {
        sendingRef.current = false;
        if (lifecycleRef.current.mounted) setSending(false);
      }
    },
    [
      pubkey,
      buyerPubkey,
      orderId,
      existingBolt11,
      existingInvoiceAt,
      makeInvoiceForWallet,
      send,
      t,
    ],
  );

  const recordRef = useRef(record);
  const currentRecord =
    active && record?.buyerPubkey === buyerPubkey && record?.orderId === orderId ? record : null;
  recordRef.current = currentRecord;
  const checkPaid = useCallback(async (): Promise<boolean | null> => {
    const current = recordRef.current;
    if (!pubkey || !current) return null;
    if (current.paidAt) return true;
    setChecking(true);
    setUnpaidRecord(null);
    setUnknownRecord(null);
    try {
      // THE wallet that made the invoice — not whichever wallet is active.
      const result = await lookupInvoice(current.walletId, current.paymentHash, {
        replyTimeoutMs: 5000,
      });
      if (result?.paid && hasInvoiceSettlementProof(result, current.paymentHash)) {
        await patchSellerInvoice(pubkey, current.orderId, current.buyerPubkey, {
          paidAt: Date.now(),
          settlementVersion: 2,
          settledAt: result.settledAt,
          preimage: result.preimage,
        });
        return true;
      }
      if (result?.paid === false) setUnpaidRecord(current);
      if (result?.paid === null) setUnknownRecord(current);
      return result?.paid === false ? false : null;
    } finally {
      setChecking(false);
    }
  }, [pubkey]);

  // Poll only while this order is visible and the app is active.
  const unpaidHash = currentRecord && !currentRecord.paidAt ? currentRecord.paymentHash : null;
  useFocusEffect(
    useCallback(() => {
      if (!unpaidHash) return;
      let checks = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      let resume: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        clearInterval(timer);
        clearTimeout(resume);
        timer = undefined;
      };
      const poll = () => {
        if (checks >= MAX_AUTO_CHECKS) return;
        checks++;
        void checkPaid().catch(() => undefined);
        if (checks >= MAX_AUTO_CHECKS) stop();
      };
      const start = () => {
        if (AppState.currentState !== 'active' || checks >= MAX_AUTO_CHECKS) return;
        poll();
        if (checks < MAX_AUTO_CHECKS) timer = setInterval(poll, CHECK_EVERY_MS);
      };
      start();
      const subscription = AppState.addEventListener('change', (state) => {
        stop();
        if (state === 'active') resume = setTimeout(start, 3000);
      });
      return () => {
        stop();
        subscription.remove();
      };
    }, [unpaidHash, checkPaid]),
  );

  const markPaid = useCallback(async () => {
    if (!pubkey || !buyerPubkey || !orderId) {
      throw new SellerInvoiceError('notSignedIn', 'Sign in to update orders');
    }
    setSending(true);
    try {
      await send(
        buildStatusUpdateRumor({
          sellerPubkey: pubkey,
          buyerPubkey,
          orderId,
          status: 'confirmed',
          note: t('orderStatus.paid'),
        }),
      ).catch((e) => {
        throw new SellerInvoiceError('sendFailed', (e as Error)?.message ?? 'send failed');
      });
      if (recordRef.current) {
        await patchSellerInvoice(pubkey, orderId, buyerPubkey, { confirmedAt: Date.now() });
      }
    } finally {
      setSending(false);
    }
  }, [pubkey, buyerPubkey, orderId, send, t]);

  const unpaidInvoice =
    recordState.owner === pubkey && currentRecord === unpaidRecord && !currentRecord?.paidAt
      ? (currentRecord?.bolt11 ?? null)
      : null;
  return {
    record: currentRecord,
    unpaidInvoice,
    unknownInvoice:
      recordState.owner === pubkey && currentRecord === unknownRecord && !currentRecord?.paidAt
        ? (currentRecord?.bolt11 ?? null)
        : null,
    sending,
    checking,
    sendInvoice,
    checkPaid,
    markPaid,
  };
}
