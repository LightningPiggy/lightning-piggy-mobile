/** Rolling admission budget, using local receipt time rather than sender timestamps.
 * Only accepted ids are retained (at most 50); rejected payloads are never stored. */
export const ORDER_WINDOW_MS = 24 * 60 * 60 * 1000;
export interface OrderBudget {
  accepted: { id: string; sender: string; at: number; stored?: boolean }[];
  dropped: number;
  droppedSince: number;
}
export function admitOrder(
  budget: OrderBudget,
  sender: string,
  id: string,
  now: number,
): { allowed: boolean; budget: OrderBudget } {
  const accepted = budget.accepted.filter((entry) => entry.at > now - ORDER_WINDOW_MS);
  const pk = sender.toLowerCase();
  const duplicate = accepted.some((entry) => entry.id === id && entry.sender === pk);
  const allowed =
    !duplicate &&
    accepted.length < 50 &&
    accepted.filter((entry) => entry.sender === pk).length < 5;
  const reset = now - budget.droppedSince >= ORDER_WINDOW_MS;
  return {
    allowed,
    budget: {
      accepted: allowed ? [...accepted, { id, sender: pk, at: now }] : accepted,
      dropped: Math.min(Number.MAX_SAFE_INTEGER, (reset ? 0 : budget.dropped) + (allowed ? 0 : 1)),
      droppedSince: reset ? now : budget.droppedSince,
    },
  };
}
