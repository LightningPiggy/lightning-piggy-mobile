import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { SimplePool } from 'nostr-tools/pool';
import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { querySyncAbortable } from './relayQuery';
import { withRelayHealth } from './healthAwarePool';
import { paceRelayReceive } from './nostrRelayReceiveQueue';
import {
  __resetVerifiedEventCache,
  flushVerifiedEventCache,
  hydrateVerifiedEventCache,
  verifyEventCached,
} from './nostrVerifyCache';

jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
class BudgetPool extends withRelayHealth(SimplePool) {}

// Model a slow uncached receive backlog without blocking the test runner.
jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: () => ({
    maybeYield: () => new Promise<void>((resolve) => setTimeout(resolve, 400)),
    dispose: jest.fn(),
  }),
}));
jest.mock('./nostrVerifyCache', () => ({
  ...jest.requireActual('./nostrVerifyCache'),
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));

const key = new Uint8Array(32).fill(7);
const message = (data: unknown[]) => ({ data: JSON.stringify(data) }) as MessageEvent;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  __resetVerifiedEventCache();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function inboxQuery(params: { signal?: AbortSignal; rejectOnTimeout?: boolean } = {}) {
  const verify = jest.fn(verifyEventCached);
  const relay = new AbstractRelay('wss://inbox/', {
    verifyEvent: (event): event is VerifiedEvent => verify(event),
  });
  jest.spyOn(relay, 'send').mockResolvedValue();
  paceRelayReceive(relay);
  const pool = new BudgetPool();
  jest.spyOn(pool, 'ensureRelay').mockResolvedValue(relay);
  const result = querySyncAbortable(
    pool,
    ['wss://inbox/'],
    { kinds: [1059] },
    { maxWait: 8000, ...params },
  );
  await jest.advanceTimersByTimeAsync(0);
  const sub = [...relay.openSubs.values()][0];
  const events = Array.from({ length: 30 }, (_, i) =>
    finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: `wrap-${i}` }, key),
  );
  for (const event of events) relay._onmessage(message(['EVENT', sub.id, event]));
  return { relay, sub, events, result, verify };
}

it.each([false, true])(
  'drains all 30 pre-deadline inbox events before completion, never awaiting persistence (wire EOSE: %s)',
  async (wireEose) => {
    // Verify-cache writes run in the background (scheduled by
    // verifyEventCached): completion never waits on one.
    const { relay, sub, events, result, verify } = await inboxQuery();
    if (wireEose) relay._onmessage(message(['EOSE', sub.id]));
    const completed = jest.fn();
    void result.then(completed);
    await jest.advanceTimersByTimeAsync(8000);
    expect(verify.mock.calls.length).toBeGreaterThan(0);
    expect(verify.mock.calls.length).toBeLessThan(30);
    expect(completed).not.toHaveBeenCalled();
    // Traffic received after the deadline cannot extend the snapshot.
    relay._onmessage(
      message([
        'EVENT',
        sub.id,
        finalizeEvent({ kind: 1059, created_at: 1, tags: [], content: 'late' }, key),
      ]),
    );
    await jest.advanceTimersByTimeAsync(8000);
    expect(verify).toHaveBeenCalledTimes(30);
    expect((await result).map((event) => event.id)).toEqual(events.map((event) => event.id));
    expect(flushVerifiedEventCache).not.toHaveBeenCalled();
    expect(relay.openSubs.size).toBe(0);
    relay.close();
  },
);

it('explicit abort closes immediately even while deadline completion awaits the backlog', async () => {
  const controller = new AbortController();
  const { relay, result, verify } = await inboxQuery({ signal: controller.signal });
  await jest.advanceTimersByTimeAsync(8000);
  controller.abort();
  const partial = await result;
  expect(partial.length).toBeGreaterThan(0);
  expect(partial.length).toBeLessThan(30);
  expect(relay.openSubs.size).toBe(0);
  const verifiedAtAbort = verify.mock.calls.length;
  await jest.advanceTimersByTimeAsync(10_000);
  expect(verify).toHaveBeenCalledTimes(verifiedAtAbort);
  relay.close();
});

it('preserves strict timeout rejection after draining pre-deadline events', async () => {
  const { relay, result, verify } = await inboxQuery({ rejectOnTimeout: true });
  const assertion = expect(result).rejects.toThrow('Relay query timed out before EOSE');
  await jest.advanceTimersByTimeAsync(16_000);
  await assertion;
  expect(verify).toHaveBeenCalledTimes(30);
  expect(relay.openSubs.size).toBe(0);
  relay.close();
});

it('keeps pending receive work alive at the budget deadline and rejects instead of resolving empty', async () => {
  let hydrated!: () => void;
  jest.mocked(hydrateVerifiedEventCache).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        hydrated = resolve;
      }),
  );
  const { relay, result, verify } = await inboxQuery({ rejectOnTimeout: true });
  const completed = jest.fn();
  const assertion = expect(result).rejects.toThrow('Relay query timed out before EOSE');
  void result.then(completed, completed);
  await jest.advanceTimersByTimeAsync(8000);
  expect(verify).not.toHaveBeenCalled();
  expect(completed).not.toHaveBeenCalled();
  expect(relay.openSubs.size).toBe(1);
  hydrated();
  await jest.advanceTimersByTimeAsync(16_000);
  await assertion;
  expect(verify).toHaveBeenCalledTimes(30);
  expect(completed).toHaveBeenCalledTimes(1);
  expect(relay.openSubs.size).toBe(0);
  relay.close();
});
