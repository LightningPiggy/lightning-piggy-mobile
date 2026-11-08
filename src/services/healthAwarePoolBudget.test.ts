import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { withRelayHealth } from './healthAwarePool';
import { withResumableSubscriptions } from './resumablePool';
import { subscribeRelayWithBudget } from './relayReqSubscription';
import { createGroupSubscriptionMux } from './marmotGroupSubscriptions';

jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  RELAY_CONNECT_TIMEOUT_MS: 5000,
  noteNetworkActivity: jest.fn(),
  recordRelayFailure: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  recordRelayPublish: jest.fn(),
  recordRelaySuccess: jest.fn(),
  selectHealthyRelays: (relays: string[]) => relays,
}));

type Requests = Parameters<AbstractSimplePool['subscribeMap']>[0];
type Params = Parameters<AbstractSimplePool['subscribeMap']>[1];
class FakePool {
  relays = new Map();
  active = new Map<number, { requests: Requests; params: Params }>();
  peak = new Map<string, number>();
  serial = 0;
  relay = { connected: true, onnotice: jest.fn() };
  ensureRelay(url: string) {
    return Promise.resolve({
      ...this.relay,
      url,
      subscribe: (
        filters: Requests[number]['filter'][],
        params: Parameters<Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>['subscribe']>[1],
      ) =>
        FakePool.prototype.subscribeMap.call(
          this,
          filters.map((filter) => ({ url, filter })),
          {
            ...params,
            onclose: (errors) => params.onclose?.(errors[0]),
          },
        ),
    });
  }
  subscribeMap(requests: Requests, params: Params) {
    const id = ++this.serial;
    this.active.set(id, { requests, params });
    for (const url of new Set(requests.map((r) => r.url))) {
      const count = [...this.active.values()].filter((v) =>
        v.requests.some((r) => r.url === url),
      ).length;
      this.peak.set(url, Math.max(count, this.peak.get(url) ?? 0));
    }
    return {
      close: (reason = 'closed') => {
        if (!this.active.delete(id)) return;
        queueMicrotask(() => params.onclose?.([reason]));
      },
    };
  }
  close() {}
  destroy() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake implements the transport surface under test
const BudgetPool = withRelayHealth(FakePool as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin is an abstract constructor
const makePool = () => new (BudgetPool as any)() as FakePool & AbstractSimplePool;
const urls = ['wss://relay.primal.net/', 'wss://relay.snort.social/'];
const filters = Array.from({ length: 20 }, (_, i) => ({
  kinds: [445],
  '#h': [`group${i}`],
  limit: 500,
}));
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));
afterEach(() => jest.useRealTimers());

test('startup peak per relay: 27 before, 7 after merging 20 groups with legacy/cache/DM owners', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  const before = new FakePool();
  const after = makePool();
  const mux = createGroupSubscriptionMux((url, filters, next) =>
    after.subscribeMap(
      filters.map((filter) => ({ url, filter })),
      { onevent: next },
    ),
  );
  const owners = filters.map((filter) => {
    urls.forEach((url) => before.subscribeMap([{ url, filter }], {}));
    return mux(urls, [filter], { next: jest.fn() });
  });
  jest.runOnlyPendingTimers();
  for (const kind of [39000, 39001, 1, 5, 4, 1059, 16]) {
    for (const pool of [before, after]) {
      pool.subscribeMap(
        urls.map((url) => ({ url, filter: { kinds: [kind], limit: 100 } })),
        {},
      );
    }
  }
  await tick();
  expect([...before.peak.values()]).toEqual([27, 27]);
  expect([...after.peak.values()]).toEqual([7, 7]);
  owners.forEach((o) => o.unsubscribe());
  after.destroy();
});

test('CLOSED limit rejection retries without notifying the owner; cancellation prevents resurrection', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  const pool = makePool();
  const onclose = jest.fn();
  const sub = pool.subscribeMap(
    [{ url: urls[0], filter: { kinds: [1059], '#p': ['me'], limit: 100 } }],
    { onclose },
  );
  await tick();
  const refused = [...pool.active.values()][0];
  pool.active.clear(); // relay sent CLOSED
  refused.params.onclose?.(['rate-limited: too many concurrent REQs']);
  await tick();
  expect(onclose).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  await tick();
  expect(pool.active.size).toBe(1);
  sub.close();
  await tick();
  jest.advanceTimersByTime(30000);
  expect(pool.active.size).toBe(0);
  pool.destroy();
});

test('id-less NOTICE from the connected relay re-arms the inbox first under a reduced budget', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  const pool = makePool();
  await pool.ensureRelay(urls[0]);
  for (let i = 0; i < 12; i++)
    pool.subscribeMap([{ url: urls[0], filter: { kinds: [1], limit: 100 } }], {});
  const inbox = pool.subscribeMap([{ url: urls[0], filter: { kinds: [1059], limit: 100 } }], {});
  await tick();
  expect(pool.peak.get(urls[0])).toBe(7);
  const relay = await pool.ensureRelay(urls[0]);
  relay.onnotice?.('ERROR: too many concurrent REQs');
  await tick();
  jest.advanceTimersByTime(1000);
  await tick();
  expect(pool.active.size).toBeLessThanOrEqual(9);
  expect([...pool.active.values()].some((s) => s.requests[0].filter.kinds?.includes(1059))).toBe(
    true,
  );
  inbox.close();
  pool.destroy();
});

test('one-shot EOSE closes each relay immediately, and queued deadlines and shutdown settle owners', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  const pool = makePool();
  const onclose = jest.fn();
  pool.subscribeEose(
    urls,
    { kinds: [0], authors: ['a', 'b'], limit: 2 },
    { onclose, maxWait: 100 },
  );
  await tick();
  const first = [...pool.active.values()][0];
  first.params.oneose?.();
  await tick();
  await tick();
  await tick();
  expect(pool.active.size).toBe(1);
  expect(onclose).not.toHaveBeenCalled();
  [...pool.active.values()][0].params.oneose?.();
  await tick();
  expect(pool.active.size).toBe(0);
  expect(onclose).toHaveBeenCalledTimes(1);

  for (let i = 0; i < 10; i++)
    pool.subscribeMap([{ url: urls[0], filter: { kinds: [1059], limit: 100 } }], {});
  const expired = jest.fn();
  pool.subscribeEose([urls[0]], { kinds: [1], limit: 10 }, { maxWait: 100, onclose: expired });
  // The fallback now yields through the receive queue before notifying the owner.
  await jest.advanceTimersByTimeAsync(5200);
  expect(expired).toHaveBeenCalledTimes(1);
  const shutdown = jest.fn();
  pool.subscribeEose([urls[0]], { kinds: [1], limit: 10 }, { onclose: shutdown });
  pool.close(urls);
  await tick();
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(pool.active.size).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('aborting a queued REQ cancels it without opening and each socket has its own budget', async () => {
  const pool = makePool();
  const otherPool = makePool();
  for (let i = 0; i < 10; i++)
    pool.subscribeMap([{ url: urls[0], filter: { kinds: [1059], limit: 100 } }], {});
  const abort = new AbortController();
  const onclose = jest.fn();
  pool.subscribeMap([{ url: urls[0], filter: { kinds: [1], limit: 100 } }], {
    abort: abort.signal,
    onclose,
  });
  otherPool.subscribeMap([{ url: urls[0], filter: { kinds: [1], limit: 100 } }], {});
  await tick();
  expect(otherPool.active.size).toBe(1);
  abort.abort();
  expect(onclose).toHaveBeenCalledWith(['aborted'], ['wss://relay.primal.net/']);
  pool.destroy();
  otherPool.destroy();
  await tick();
  expect(pool.active.size).toBe(0);
});

test('raw Market/contact/reaction reads share the cap and retry without turning CLOSED into EOSE', async () => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  const pool = makePool();
  const rawRelay = {
    url: urls[0],
    subscribe(
      filters: Requests[number]['filter'][],
      params: {
        oneose?: () => void;
        onclose?: (reason: string) => void;
      },
    ) {
      return FakePool.prototype.subscribeMap.call(
        pool,
        filters.map((filter) => ({ url: urls[0], filter })),
        {
          ...params,
          onclose: (errors) => params.onclose?.(errors[0]),
        },
      );
    },
  } as unknown as Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>;
  for (let i = 0; i < 10; i++)
    pool.subscribeMap([{ url: urls[0], filter: { kinds: [1], limit: 100 } }], {});
  const onclose = jest.fn();
  const oneose = jest.fn();
  const inbox = subscribeRelayWithBudget(pool, rawRelay, [{ kinds: [1059], limit: 100 }], {
    onclose,
    oneose,
  });
  await tick();
  expect(pool.active.size).toBe(8);
  expect(pool.peak.get(urls[0])).toBe(8);
  const refused = [...pool.active.values()].find((s) =>
    s.requests[0].filter.kinds?.includes(1059),
  )!;
  for (const [id, entry] of pool.active) if (entry === refused) pool.active.delete(id);
  refused.params.onclose?.(['ERROR: too many concurrent REQs']);
  await tick();
  expect(onclose).not.toHaveBeenCalled();
  expect(oneose).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1000);
  await tick();
  expect([...pool.active.values()].some((s) => s.requests[0].filter.kinds?.includes(1059))).toBe(
    true,
  );
  inbox.close();
  expect(onclose).toHaveBeenCalledTimes(1);
  pool.destroy();
  await tick();
  expect(pool.active.size).toBe(0);
});

test('the production composition (resumable over health) passes each close reason its relay (#1402)', async () => {
  // Same layering as nostrPool's pool: withResumableSubscriptions(withRelayHealth(...)).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin over the fake transport
  const Composed = withResumableSubscriptions(withRelayHealth(FakePool as any));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin is an abstract constructor
  const pool = new (Composed as any)() as FakePool &
    AbstractSimplePool & {
      querySyncFilters: (
        urls: string[],
        filters: { kinds: number[]; limit: number }[],
        maxWait: number,
        options: { abort: AbortSignal; onClose: (reasons: string[], urls?: string[]) => void },
      ) => Promise<unknown>;
    };
  const abort = new AbortController();
  const onClose = jest.fn();
  const read = pool.querySyncFilters([urls[0]], [{ kinds: [10050], limit: 1 }], 1_000, {
    abort: abort.signal,
    onClose,
  });
  await tick();
  abort.abort();
  await read.catch(() => undefined);
  expect(onClose).toHaveBeenCalledWith(['aborted'], [urls[0]]);
  pool.destroy();
});
