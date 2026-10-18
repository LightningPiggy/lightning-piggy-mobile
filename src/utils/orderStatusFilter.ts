import type { OrderChipStatus } from '../components/OrderStatusChip';

export type OrderStatusFilter = 'all' | OrderChipStatus;

// Actionable orders lead, followed by the remaining lifecycle stages.
const LIFECYCLE: readonly OrderChipStatus[] = [
  'needsInvoice',
  'invoiceExpired',
  'payNow',
  'awaitingInvoice',
  'invoiceSent',
  'paid',
  'shipped',
  'completed',
  'cancelled',
];

export function countOrderStatuses<T>(items: readonly T[], statusOf: (item: T) => OrderChipStatus) {
  const counts = new Map<OrderChipStatus, number>();
  for (const item of items) {
    const status = statusOf(item);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return LIFECYCLE.filter((status) => counts.has(status)).map((status) => ({
    status,
    count: counts.get(status)!,
  }));
}

export function filterOrdersByStatus<T>(
  items: readonly T[],
  statusOf: (item: T) => OrderChipStatus,
  selected: OrderStatusFilter,
): readonly T[] {
  return selected === 'all' ? items : items.filter((item) => statusOf(item) === selected);
}
