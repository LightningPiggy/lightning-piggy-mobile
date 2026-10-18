import { useMemo, useState } from 'react';
import type { OrderChipStatus } from '../components/OrderStatusChip';
import {
  countOrderStatuses,
  filterOrdersByStatus,
  type OrderStatusFilter,
} from '../utils/orderStatusFilter';

/** Reset synchronously when the set of statuses changes, before rendering stale results. */
export function useOrderStatusFilter<T>(
  items: readonly T[],
  statusOf: (item: T) => OrderChipStatus,
) {
  const counts = useMemo(() => countOrderStatuses(items, statusOf), [items, statusOf]);
  const statusesKey = counts.map(({ status }) => status).join(',');
  const [selection, setSelection] = useState({ statusesKey, status: 'all' as OrderStatusFilter });
  if (selection.statusesKey !== statusesKey) {
    setSelection({ statusesKey, status: 'all' });
  }
  const selected = selection.statusesKey === statusesKey ? selection.status : 'all';
  const filtered = useMemo(
    () => filterOrdersByStatus(items, statusOf, selected),
    [items, statusOf, selected],
  );
  return {
    counts,
    selected,
    filtered,
    onSelect: (status: OrderStatusFilter) => setSelection({ statusesKey, status }),
  };
}
