// Routing waits (bounded) for an account's stored groups before treating a
// sender as a stranger (#1830) — but only once: a stuck load must not cost a
// fresh timeout for every wrap in a batch.
import {
  areKnownGroupsLoaded,
  setKnownGroups,
  whenKnownGroupsLoaded,
} from './groupRoutingRegistry';

const OWNER = 'f'.repeat(64);
const OTHER = 'e'.repeat(64);

afterEach(() => {
  jest.useRealTimers();
  setKnownGroups([]);
});

it('resolves once the owner groups load', async () => {
  setKnownGroups([], OWNER, false);
  expect(areKnownGroupsLoaded(OWNER)).toBe(false);
  const pending = whenKnownGroupsLoaded(OWNER, 5_000);
  setKnownGroups([], OWNER, true);
  await expect(pending).resolves.toBe(true);
});

it('waits once: after a timeout, later waits for that owner return at once', async () => {
  jest.useFakeTimers();
  setKnownGroups([], OWNER, false);
  const first = whenKnownGroupsLoaded(OWNER, 5_000);
  await jest.advanceTimersByTimeAsync(5_000);
  await expect(first).resolves.toBe(false);
  // Re-set as still not loaded (a groups state change): no new wait.
  setKnownGroups([], OWNER, false);
  let settled = false;
  void whenKnownGroupsLoaded(OWNER, 5_000).then(() => (settled = true));
  await jest.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
  setKnownGroups([], OWNER, true);
  await expect(whenKnownGroupsLoaded(OWNER, 5_000)).resolves.toBe(true);
});

it('another account gets its own wait', async () => {
  jest.useFakeTimers();
  setKnownGroups([], OWNER, false);
  const first = whenKnownGroupsLoaded(OWNER, 5_000);
  await jest.advanceTimersByTimeAsync(5_000);
  await first;
  setKnownGroups([], OTHER, false);
  let settled = false;
  void whenKnownGroupsLoaded(OTHER, 5_000).then(() => (settled = true));
  await jest.advanceTimersByTimeAsync(1_000);
  expect(settled).toBe(false);
  setKnownGroups([], OTHER, true);
  await jest.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);
});
