import { countOrderStatuses, filterOrdersByStatus } from './orderStatusFilter';
import type { OrderChipStatus } from '../components/OrderStatusChip';

const statusOf = (item: { status: OrderChipStatus }) => item.status;
const orders: { status: OrderChipStatus; id: number }[] = [
  { status: 'cancelled', id: 1 },
  { status: 'paid', id: 2 },
  { status: 'needsInvoice', id: 3 },
  { status: 'invoiceSent', id: 4 },
  { status: 'invoiceSent', id: 5 },
];

test('counts only present statuses in lifecycle order without mutating the list', () => {
  expect(countOrderStatuses(orders, statusOf)).toEqual([
    { status: 'needsInvoice', count: 1 },
    { status: 'invoiceSent', count: 2 },
    { status: 'paid', count: 1 },
    { status: 'cancelled', count: 1 },
  ]);
  expect(orders[0].id).toBe(1);
});

test('All preserves the loaded list; filtering preserves order and identity', () => {
  expect(filterOrdersByStatus(orders, statusOf, 'all')).toBe(orders);
  expect(filterOrdersByStatus(orders, statusOf, 'invoiceSent')).toEqual([orders[3], orders[4]]);
  expect(filterOrdersByStatus(orders, statusOf, 'shipped')).toEqual([]);
});

test('handles empty and single-status lists and buyer lifecycle statuses', () => {
  expect(countOrderStatuses([], statusOf)).toEqual([]);
  expect(countOrderStatuses([orders[0], orders[0]], statusOf)).toEqual([
    { status: 'cancelled', count: 2 },
  ]);
  const buyer = ['completed', 'shipped', 'paid', 'awaitingInvoice', 'payNow'] as const;
  expect(countOrderStatuses(buyer, (status) => status).map((item) => item.status)).toEqual([
    'payNow',
    'awaitingInvoice',
    'paid',
    'shipped',
    'completed',
  ]);
});

test('expired invoices follow needs-invoice before sent invoices', () => {
  const statuses = ['invoiceSent', 'invoiceExpired', 'needsInvoice', 'paid'] as const;
  expect(countOrderStatuses(statuses, (status) => status).map((item) => item.status)).toEqual([
    'needsInvoice',
    'invoiceExpired',
    'invoiceSent',
    'paid',
  ]);
  expect(filterOrdersByStatus(statuses, (status) => status, 'invoiceExpired')).toEqual([
    'invoiceExpired',
  ]);
});
