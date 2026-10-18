import { admitOrder, ORDER_WINDOW_MS, type OrderBudget } from './orderRateLimit';
const empty = (): OrderBudget => ({ accepted: [], dropped: 0, droppedSince: 100 });
it('admits five per sender, counts excess without retaining payloads', () => {
  let budget = empty();
  for (let i = 0; i < 8; i++) {
    const result = admitOrder(budget, 'BUYER', String(i), 100);
    expect(result.allowed).toBe(i < 5);
    budget = result.budget;
  }
  expect(budget.accepted).toHaveLength(5);
  expect(budget.dropped).toBe(3);
  expect(budget.accepted.every((entry) => entry.sender === 'buyer')).toBe(true);
});
it('caps the global rolling day at fifty and releases slots only after 24 hours', () => {
  let budget = empty();
  for (let i = 0; i < 50; i++) {
    const result = admitOrder(budget, `sender${Math.floor(i / 5)}`, String(i), 100 + i);
    expect(result.allowed).toBe(true);
    budget = result.budget;
  }
  expect(admitOrder(budget, 'new', 'excess', 200).allowed).toBe(false);
  expect(admitOrder(budget, 'new', 'excess', 99 + ORDER_WINDOW_MS).allowed).toBe(false);
  const next = admitOrder(budget, 'new', 'new', 100 + ORDER_WINDOW_MS);
  expect(next.allowed).toBe(true);
  expect(next.budget.accepted).toHaveLength(50);
});
it('does not admit the same rumor under a second gift wrap', () => {
  const first = admitOrder(empty(), 'buyer', 'rumor', 100);
  const duplicate = admitOrder(first.budget, 'buyer', 'rumor', 101);
  expect(duplicate.allowed).toBe(false);
  expect(duplicate.budget.accepted).toHaveLength(1);
  expect(duplicate.budget.dropped).toBe(1);
});
it('preserves limits and drop counts across serialized state restoration', () => {
  let budget = empty();
  for (let i = 0; i < 6; i++) budget = admitOrder(budget, 'buyer', String(i), 100).budget;
  const restored: OrderBudget = JSON.parse(JSON.stringify(budget));
  const result = admitOrder(restored, 'buyer', 'after restart', 200);
  expect(result.allowed).toBe(false);
  expect(result.budget.dropped).toBe(2);
});
