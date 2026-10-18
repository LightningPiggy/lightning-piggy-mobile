// Gamma order lifecycle per order id, derived from stored order rows
// (encrypted DM store: wireKind 16/17 rows whose content is order JSON).
// Direction-aware: the same rows read from the BUYER's side (my placed orders
// — My orders) or the SELLER's side (orders I received — My shop → Orders).
// PURE — no React, no I/O (coverage scope: src/utils).
//
// Roles per Gamma market-spec §4: the buyer authors the type-1 order and the
// kind-17 receipt; the merchant authors the type-2 payment request and the
// type-3 / type-4 updates (either side may send a type-3 `cancelled`).
import { parseStoredOrder, payableBolt11, type ParsedOrderEvent } from './orderEvents';
import { matchesExpectedOrderAmount } from './orderInvoiceAmount';
import { expiresAtFromBolt11 } from './bolt11';

export type OrderRole = 'buyer' | 'seller';

/** A stored order row in one conversation. */
export interface OrderRowInput {
  fromMe: boolean;
  /** Stored content — order JSON (see orderEvents.serializeOrder). */
  text: string;
  wireKind?: number;
  createdAt: number;
  /** Stored row id (the conversation can jump to it). */
  id?: string;
}

export interface OrderThread {
  orderId: string;
  role: OrderRole;
  /** The type-1 order (the first one for this id from the buyer side). */
  placed: ParsedOrderEvent;
  placedAt: number;
  /** Row id of the placed order, when known. */
  placedRowId?: string;
  /** The merchant's latest payment request matching the buyer-approved amount. */
  invoice?: { bolt11: string; amountSats?: number; at: number; rowId?: string; expiresAt: number };
  /** All merchant requests matching the buyer-approved amount, including reissues. */
  invoices: NonNullable<OrderThread['invoice']>[];
  /** The buyer's latest kind-17 receipt. */
  receipt?: ParsedOrderEvent;
  /** The merchant's latest status (type 3). */
  status?: string;
  /** Either side sent a type-3 `cancelled`. */
  cancelled: boolean;
  /** The merchant's latest shipping status (type 4). */
  shipping?: string;
}

/** Statuses a merchant sends once payment is in. */
export const PAID_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'processing', 'completed']);

/**
 * Index one conversation's order rows into per-order threads for `role`:
 * `buyer` keeps orders I placed, `seller` keeps orders I received.
 */
export function orderThreads(
  rows: readonly OrderRowInput[],
  role: OrderRole,
): Map<string, OrderThread> {
  const parsed = rows
    .filter((r) => r.wireKind === 16 || r.wireKind === 17)
    .map((r) => ({ row: r, order: parseStoredOrder(r.text) }))
    .filter((x): x is { row: OrderRowInput; order: ParsedOrderEvent } => x.order !== null)
    .sort((a, b) => a.row.createdAt - b.row.createdAt);
  // The buyer side of a row: mine when I'm the buyer, theirs when I'm selling.
  const byBuyer = (row: OrderRowInput) => (role === 'buyer' ? row.fromMe : !row.fromMe);

  const threads = new Map<string, OrderThread>();
  for (const { row, order } of parsed) {
    if (order.type === 'order' && byBuyer(row) && !threads.has(order.orderId)) {
      threads.set(order.orderId, {
        orderId: order.orderId,
        role,
        placed: order,
        placedAt: row.createdAt,
        placedRowId: row.id,
        cancelled: false,
        invoices: [],
      });
    }
  }
  for (const { row, order } of parsed) {
    const thread = threads.get(order.orderId);
    if (!thread) continue;
    const fromBuyer = byBuyer(row);
    if (order.type === 'payment' && !fromBuyer) {
      const bolt11 = payableBolt11(order);
      const expiresAt = bolt11 ? expiresAtFromBolt11(bolt11) : null;
      if (
        bolt11 &&
        expiresAt !== null &&
        (role === 'seller' || matchesExpectedOrderAmount(bolt11, thread.placed.amountSats))
      ) {
        thread.invoice = {
          bolt11,
          amountSats: order.amountSats,
          at: row.createdAt,
          rowId: row.id,
          expiresAt,
        };
        thread.invoices.push(thread.invoice);
      }
    } else if (order.type === 'receipt' && fromBuyer) {
      thread.receipt = order;
    } else if (order.type === 'status' && order.status) {
      if (order.status === 'cancelled') thread.cancelled = true;
      if (!fromBuyer) thread.status = order.status;
    } else if (order.type === 'shipping' && order.status && !fromBuyer) {
      thread.shipping = order.status;
    }
  }
  return threads;
}

/** Buyer-side chip for My orders. */
export type BuyerOrderStatus =
  | 'awaitingInvoice'
  | 'invoiceExpired'
  | 'payNow'
  | 'paid'
  | 'shipped'
  | 'completed'
  | 'cancelled';

/**
 * Where my order stands. `invoicePaid` = my wallet paid the seller's invoice
 * (a settled outgoing payment with its payment hash).
 */
export function buyerOrderStatus(
  thread: OrderThread,
  opts: { invoicePaid?: boolean; nowMs?: number } = {},
): BuyerOrderStatus {
  if (thread.cancelled) return 'cancelled';
  if (thread.status === 'completed' || thread.shipping === 'delivered') return 'completed';
  if (thread.shipping === 'shipped') return 'shipped';
  if (
    opts.invoicePaid ||
    thread.receipt !== undefined ||
    (thread.status !== undefined && PAID_STATUSES.has(thread.status))
  ) {
    return 'paid';
  }
  if (thread.invoice)
    return thread.invoice.expiresAt * 1000 > (opts.nowMs ?? Date.now())
      ? 'payNow'
      : 'invoiceExpired';
  return 'awaitingInvoice';
}

/** One row of My orders. */
export interface BuyerOrderEntry {
  orderId: string;
  sellerPubkey: string;
  placedAt: number;
  status: BuyerOrderStatus;
  order: ParsedOrderEvent;
  /** Row to scroll the conversation to: the invoice when there's one to
   * pay, else the placed order. */
  jumpToRowId?: string;
  /** Allows a focused view to refresh when its payment request expires. */
  paymentExpiresAt?: number;
  /** Validated invoice for the market detail, never a chat card. */
  paymentRequest?: ParsedOrderEvent;
}

/**
 * My orders across seller conversations, newest first. `isInvoicePaid`
 * answers from wallet history (settled outgoing payment with the invoice's hash).
 */
export function buyerOrderEntries(
  conversations: ReadonlyMap<string, readonly OrderRowInput[]>,
  isInvoicePaid: (bolt11: string) => boolean = () => false,
  nowMs = Date.now(),
): BuyerOrderEntry[] {
  const entries: BuyerOrderEntry[] = [];
  for (const [sellerPubkey, rows] of conversations) {
    for (const thread of orderThreads(rows, 'buyer').values()) {
      const status = buyerOrderStatus(thread, {
        invoicePaid: thread.invoices.some((invoice) => isInvoicePaid(invoice.bolt11)),
        nowMs,
      });
      entries.push({
        orderId: thread.orderId,
        sellerPubkey,
        placedAt: thread.placedAt,
        status,
        order: thread.placed,
        paymentExpiresAt: status === 'payNow' ? thread.invoice?.expiresAt : undefined,
        ...(thread.invoice && status === 'payNow'
          ? {
              paymentRequest: {
                kind: 16,
                type: 'payment' as const,
                orderId: thread.orderId,
                items: [],
                message: '',
                amountSats: thread.invoice.amountSats,
                payment: { method: 'lightning', value: thread.invoice.bolt11 },
              },
            }
          : {}),
        jumpToRowId:
          status === 'payNow' ? (thread.invoice?.rowId ?? thread.placedRowId) : thread.placedRowId,
      });
    }
  }
  return entries.sort((a, b) => b.placedAt - a.placedAt || a.orderId.localeCompare(b.orderId));
}

/** How many of my orders have an invoice waiting to be paid (header badge). */
export function payNowCount(entries: readonly Pick<BuyerOrderEntry, 'status'>[]): number {
  return entries.filter((e) => e.status === 'payNow').length;
}

/** Group stored rows (any conversation) by conversation partner. */
export function groupRowsByConversation<R extends OrderRowInput & { conversation: string }>(
  rows: readonly R[],
): Map<string, R[]> {
  const out = new Map<string, R[]>();
  for (const row of rows) {
    const list = out.get(row.conversation);
    if (list) list.push(row);
    else out.set(row.conversation, [row]);
  }
  return out;
}
