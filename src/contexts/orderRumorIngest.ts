import { getOutgoingOrderRows, hasIncomingOrder } from '../services/dmDb';
import { parseStoredOrder, parseOrderEvent, type OrderEventInput } from '../utils/orderEvents';

// Only called on decoded NIP-17 rumors, never public kind-16/17 events.
// Bound the unsolicited-order exception independently of ordinary DM policy.
export const ORDER_RUMOR_MAX_CHARS = 32_768;
export const ORDER_RUMOR_RATE_LIMIT = 120;
const WINDOW_MS = 60_000;
const windows = new Map<string, { start: number; count: number }>();

export function isBoundedOrderRumor(rumor: OrderEventInput): boolean {
  if (rumor.kind !== 16 && rumor.kind !== 17) return false;
  if (!Array.isArray(rumor.tags) || rumor.tags.length > 256) return false;
  let size = rumor.content.length;
  for (const tag of rumor.tags) {
    if (!Array.isArray(tag) || tag.length > 32) return false;
    for (const value of tag) {
      if (typeof value !== 'string') return false;
      size += value.length;
      if (size > ORDER_RUMOR_MAX_CHARS) return false;
    }
  }
  return size <= ORDER_RUMOR_MAX_CHARS && parseOrderEvent(rumor) !== null;
}

/** Shared live/backfill budget per account; rejected wraps remain retryable. */
export function admitUnfollowedOrder(owner: string, now = Date.now()): boolean {
  let window = windows.get(owner);
  if (!window || now - window.start >= WINDOW_MS) {
    window = { start: now, count: 0 };
    if (windows.size >= 8 && !windows.has(owner)) {
      windows.delete(windows.keys().next().value!);
    }
    windows.set(owner, window);
  }
  if (window.count >= ORDER_RUMOR_RATE_LIMIT) return false;
  window.count++;
  return true;
}

const droppedLifecycleCounts = new Map<string, number>();

export function getDroppedOrderLifecycleCount(owner: string): number {
  return droppedLifecycleCounts.get(owner) ?? 0;
}

/** Lifecycle updates must come from the counterparty of a stored placed order.
 * Incoming type-1 orders still belong to the seller flow; our own echoes are
 * locally authored. Apply this independently of follows and Messages policy. */
export async function admitOrderLifecycle(
  owner: string,
  partner: string,
  fromMe: boolean,
  rumor: OrderEventInput,
): Promise<boolean> {
  const order = parseOrderEvent(rumor);
  if (fromMe || order?.type === 'order') return true;
  // A seller receives receipts/cancellations from the buyer who placed the order.
  // This role-specific exception never admits merchant payment/shipping updates.
  if (order?.type === 'receipt' || (order?.type === 'status' && order.status === 'cancelled')) {
    if (await hasIncomingOrder(owner, partner, order.orderId)) return true;
  }
  if (order) {
    const placed = await getOutgoingOrderRows(owner, partner, [order.orderId]);
    if (
      placed.some((row) => {
        const original = parseStoredOrder(row.content);
        return (
          row.fromMe &&
          row.sender === owner &&
          row.conversation === partner &&
          original?.type === 'order' &&
          original.orderId === order.orderId
        );
      })
    )
      return true;
  }
  if (droppedLifecycleCounts.size >= 8 && !droppedLifecycleCounts.has(owner)) {
    droppedLifecycleCounts.delete(droppedLifecycleCounts.keys().next().value!);
  }
  droppedLifecycleCounts.set(owner, getDroppedOrderLifecycleCount(owner) + 1);
  return false;
}
