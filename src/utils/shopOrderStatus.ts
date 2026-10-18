// Seller-side order status, on top of the shared direction-aware thread
// derivation (utils/orderThreads, role 'seller'). PURE — no React, no I/O.
//
// Shared by the in-chat order card (what to offer next: Send invoice / Mark
// paid) and My shop → Orders (status chip + "needs invoice" count).
//
//   needsInvoice — buyer's type-1 order received, no type-2 from me yet
//   invoiceSent  — I sent a payment request, not yet paid
//   paid         — my wallet saw the invoice settle, I sent a `confirmed` /
//                  `processing` / `completed` status, or the buyer's kind-17
//                  receipt proves payment of MY invoice (a bare receipt is
//                  only a claim)
//   shipped      — I sent a type-4 shipping update (display only)
//   cancelled    — either side sent a `cancelled` status
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { SellerInvoiceRecord } from '../services/sellerInvoiceStore';
import { expiresAtFromBolt11, paymentHashFromBolt11 } from './bolt11';
import type { ParsedOrderEvent } from './orderEvents';
import { PAID_STATUSES, orderThreads, type OrderRowInput, type OrderThread } from './orderThreads';

export type ShopOrderStatus =
  | 'needsInvoice'
  | 'invoiceExpired'
  | 'invoiceSent'
  | 'paid'
  | 'shipped'
  | 'cancelled';

/** An order I received, with what's happened since. */
export type SellerOrderThread = OrderThread;
export type { OrderRowInput };

/** Seller-side threads (orders I RECEIVED) for one conversation. */
export function sellerOrderThreads(rows: readonly OrderRowInput[]): Map<string, SellerOrderThread> {
  return orderThreads(rows, 'seller');
}

/** Whether a Lightning preimage hashes to `paymentHash` (proof of payment). */
export function preimageMatches(preimage: string | undefined, paymentHash: string | null): boolean {
  if (!preimage || !paymentHash || !/^[0-9a-f]{64}$/i.test(preimage)) return false;
  try {
    return bytesToHex(sha256(hexToBytes(preimage.toLowerCase()))) === paymentHash.toLowerCase();
  } catch {
    return false;
  }
}

/** The buyer's receipt proves payment of MY invoice: same bolt11, and a
 * preimage hashing to its payment hash. `effectiveBolt11` is the invoice this
 * device considers current (a durable record can outlive a missing or stale
 * relay self-copy); it defaults to the thread's invoice. */
export function receiptProvesPayment(
  thread: Pick<SellerOrderThread, 'invoice' | 'receipt'>,
  invoicePaymentHash: string | null,
  effectiveBolt11?: string | null,
): boolean {
  const receipt = thread.receipt;
  const bolt11 = effectiveBolt11 ?? thread.invoice?.bolt11;
  if (!receipt?.payment || !bolt11) return false;
  const sameInvoice =
    receipt.payment.value
      .trim()
      .toLowerCase()
      .replace(/^lightning:/, '') === bolt11.toLowerCase();
  return sameInvoice && preimageMatches(receipt.payment.preimage, invoicePaymentHash);
}

/** The invoice a seller should verify against: the durable record when it is
 * current, otherwise the thread's relay self-copy. */
export function effectiveSellerInvoice(
  record:
    | Pick<SellerInvoiceRecord, 'bolt11' | 'sentAt' | 'replacesBolt11' | 'paymentHash'>
    | null
    | undefined,
  invoice: SellerOrderThread['invoice'],
): { bolt11: string; paymentHash: string | null } | null {
  if (record && sellerRecordIsCurrent(record, invoice)) {
    return { bolt11: record.bolt11, paymentHash: record.paymentHash };
  }
  return invoice
    ? { bolt11: invoice.bolt11, paymentHash: paymentHashFromBolt11(invoice.bolt11) }
    : null;
}

/** Prefer a durable replacement while the relay still exposes the old self-copy. */
export function sellerRecordIsCurrent(
  record: Pick<SellerInvoiceRecord, 'bolt11' | 'sentAt' | 'replacesBolt11'> | null | undefined,
  invoice: SellerOrderThread['invoice'],
): boolean {
  return Boolean(
    record &&
    (!invoice ||
      record.bolt11 === invoice.bolt11 ||
      record.replacesBolt11 === invoice.bolt11 ||
      (invoice.at > 0 && record.sentAt > invoice.at * 1000)),
  );
}

/** The chip for an order I received. `walletPaid` = my wallet saw it settle. */
export function shopOrderStatus(
  thread: SellerOrderThread | undefined,
  opts: {
    walletPaid?: boolean;
    receiptVerified?: boolean;
    nowMs?: number;
    invoiceRecord?: Pick<SellerInvoiceRecord, 'bolt11' | 'paidAt' | 'confirmedAt' | 'paymentHash'> &
      Partial<Pick<SellerInvoiceRecord, 'sentAt' | 'replacesBolt11'>>;
  } = {},
): ShopOrderStatus {
  if (thread?.cancelled) return 'cancelled';
  if (thread?.shipping === 'shipped' || thread?.shipping === 'delivered') return 'shipped';
  if (
    opts.walletPaid ||
    opts.invoiceRecord?.paidAt ||
    opts.invoiceRecord?.confirmedAt ||
    opts.receiptVerified ||
    (thread?.status !== undefined && PAID_STATUSES.has(thread.status))
  ) {
    return 'paid';
  }
  // A delivered buyer wrap may have no seller self-copy. Keep the durable
  // local invoice usable until the payment request appears in the thread.
  const expiresAt =
    opts.invoiceRecord &&
    sellerRecordIsCurrent(
      { ...opts.invoiceRecord, sentAt: opts.invoiceRecord.sentAt ?? 0 },
      thread?.invoice,
    )
      ? (expiresAtFromBolt11(opts.invoiceRecord.bolt11) ??
        (opts.invoiceRecord.bolt11 === thread?.invoice?.bolt11 ? thread.invoice.expiresAt : null))
      : (thread?.invoice?.expiresAt ?? null);
  if (thread?.invoice || opts.invoiceRecord)
    return expiresAt !== null && expiresAt * 1000 <= (opts.nowMs ?? Date.now())
      ? 'invoiceExpired'
      : 'invoiceSent';
  return 'needsInvoice';
}

/** How many orders still need an invoice (the My shop badge). */
export function needsInvoiceCount(statuses: Iterable<ShopOrderStatus>): number {
  let count = 0;
  for (const status of statuses) if (status === 'needsInvoice') count += 1;
  return count;
}

/** One row for My shop → Orders. */
export interface ShopOrderEntry {
  orderId: string;
  buyerPubkey: string;
  placedAt: number;
  status: ShopOrderStatus;
  order: ParsedOrderEvent;
  /** Row to scroll the buyer conversation to (the order card). */
  jumpToRowId?: string;
}

/**
 * Every order received in the given buyer conversations, newest first, with
 * its status chip. `paidOrderIds` = orders whose invoice my wallet saw settle
 * (services/sellerInvoiceStore `paidAt`). Callers keep only orders for their
 * own listings (sellerOrderQuote.orderOwnership) before display.
 */
export function shopOrderEntries(
  conversations: ReadonlyMap<string, readonly OrderRowInput[]>,
  paidOrderIds: ReadonlySet<string> = new Set(),
): ShopOrderEntry[] {
  const entries: ShopOrderEntry[] = [];
  for (const [buyerPubkey, rows] of conversations) {
    for (const thread of sellerOrderThreads(rows).values()) {
      const hash = thread.invoice ? paymentHashFromBolt11(thread.invoice.bolt11) : null;
      entries.push({
        orderId: thread.orderId,
        buyerPubkey,
        placedAt: thread.placedAt,
        order: thread.placed,
        jumpToRowId: thread.placedRowId,
        status: shopOrderStatus(thread, {
          walletPaid: paidOrderIds.has(thread.orderId),
          receiptVerified: receiptProvesPayment(thread, hash),
        }),
      });
    }
  }
  return entries.sort((a, b) => b.placedAt - a.placedAt || a.orderId.localeCompare(b.orderId));
}
