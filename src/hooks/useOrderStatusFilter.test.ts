import { act, renderHook } from '@testing-library/react-native';
import { useOrderStatusFilter } from './useOrderStatusFilter';
import type { OrderChipStatus } from '../components/OrderStatusChip';

const statusOf = (status: OrderChipStatus) => status;

test('resets to All on status-set changes, retaining selection for count-only changes', () => {
  let items: OrderChipStatus[] = ['needsInvoice', 'invoiceSent'];
  const { result, rerender } = renderHook(() => useOrderStatusFilter(items, statusOf));
  act(() => result.current.onSelect('invoiceSent'));
  expect(result.current.filtered).toEqual(['invoiceSent']);
  items = ['needsInvoice', 'invoiceSent', 'invoiceSent'];
  rerender({});
  expect(result.current.selected).toBe('invoiceSent');
  expect(result.current.filtered).toHaveLength(2);
  items = ['needsInvoice', 'paid'];
  rerender({});
  expect(result.current.selected).toBe('all');
  expect(result.current.filtered).toBe(items);
  act(() => result.current.onSelect('paid'));
  items = ['needsInvoice', 'paid', 'cancelled'];
  rerender({});
  expect(result.current.selected).toBe('all');
});
