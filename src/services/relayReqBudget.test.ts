import { setRelayAuthAccount } from './relayAuth';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { RelayReqBudget, reqPriority, liveReqCap, type ReqOptions } from './relayReqBudget';
import { withRelayHealth } from './healthAwarePool';
import { createGroupSubscriptionMux } from './marmotGroupSubscriptions';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import type { Event } from 'nostr-tools/pure';
import { hydrateVerifiedEventCache } from './nostrVerifyCache';

jest.mock('./nostrVerifyCache', () => ({
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));

jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  RELAY_CONNECT_TIMEOUT_MS: 5000,
  noteNetworkActivity: jest.fn(),
  recordRelayFailure: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  recordRelayPublish: jest.fn(),
  recordRelaySuccess: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
}));

function fake(max = 10) {
  const budget = new RelayReqBudget('wss://primal', max);
  const active = new Set<string>();
  const starts: string[] = [];
  let peak = 0;
  const add = (name: string, priority: number, mode: ReqOptions['mode'] = 'live') =>
    budget.add(
      priority,
      () => {
        active.add(name);
        starts.push(name);
        peak = Math.max(peak, active.size);
        return {
          close: () => {
            active.delete(name);
          },
        };
      },
      () => {},
      { mode, label: name },
    );
  return { budget, active, add, starts, peak: () => peak };
}

type Relay = Awaited<ReturnType<AbstractSimplePool['ensureRelay']>>;
type Params = Parameters<Relay['subscribe']>[1];
class FakePool {
  relays = new Map();
  active = new Map<number, Params>();
  serial = 0;
  relay = {
    url: 'wss://primal/',
    connected: true,
    onnotice: undefined,
    onclose: undefined,
    subscribe: (_filters: unknown, params: Params) => {
      const id = ++this.serial;
      this.active.set(id, params);
      return {
        close: (reason = 'closed') => {
          if (!this.active.delete(id)) return;
          params.onclose?.(reason);
        },
      };
    },
  };
  ensureRelay() {
    return Promise.resolve(this.relay);
  }
  close() {}
  destroy() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake transport has only the surface under test
const BudgetPool = withRelayHealth(FakePool as any);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mixin constructor is abstract
const makePool = () => new (BudgetPool as any)() as FakePool & AbstractSimplePool;
const url = 'wss://primal/';
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

test('deadlock regression: ten long-lived owners leave three slots for one-shots', () => {
  const f = fake();
  for (let i = 0; i < 10; i++) f.add(`live-${i}`, 0);
  f.add('welcome', 1, 'oneshot');
  expect(f.active.has('welcome')).toBe(true);
  expect([...f.active].filter((name) => name.startsWith('live-'))).toHaveLength(7);
  f.add('profile', 2, 'oneshot');
  f.add('reaction', 2, 'oneshot');
  expect(f.active.size).toBe(10);
  expect(f.peak()).toBe(10);
  f.budget.dispose();
});

test('inbox first, then Welcome/group-state one-shots ahead of background FIFO', () => {
  const f = fake(4);
  const holders = Array.from({ length: 4 }, (_, i) => f.add(`held-${i}`, 2, 'oneshot'));
  f.add('profile', 2, 'oneshot');
  f.add('reaction', 2, 'oneshot');
  f.add('group-state', 1, 'oneshot');
  f.add('welcome', 1, 'oneshot');
  f.add('inbox', 0);
  holders.forEach((h) => h.close());
  expect(f.starts.slice(4)).toEqual(['inbox', 'group-state', 'welcome', 'profile']);
  f.budget.dispose();
  expect(reqPriority([{ kinds: [445, 1059] }])).toBe(0);
  expect(reqPriority([{ kinds: [30443] }])).toBe(1);
});

test('watchdog logs one stall with holder labels and force-releases hung one-shots at 20s', async () => {
  const log = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const f = fake();
  for (let i = 0; i < 7; i++) f.add(`live-${i}`, 0);
  for (let i = 0; i < 3; i++) f.add(`profile-${i}`, 2, 'oneshot');
  f.add('welcome', 1, 'oneshot');
  jest.advanceTimersByTime(16000);
  expect(log.mock.calls.filter(([line]) => String(line).includes('budget stall'))).toHaveLength(1);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('oldest=welcome 15s holders:'));
  // A queued owner's own deadline is bounded too; a newer request survives.
  f.add('fresh-welcome', 1, 'oneshot');
  await jest.advanceTimersByTimeAsync(4000);
  expect(f.active.has('fresh-welcome')).toBe(true);
  expect([...f.active].some((name) => name.startsWith('profile'))).toBe(false);
  expect(f.peak()).toBe(10);
  f.budget.dispose();
});

test.each(['eose', 'error', 'timeout', 'socket close'])(
  '%s releases a one-shot slot and settles the owner',
  async (signal) => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const pool = makePool();
    const onclose = jest.fn();
    pool.subscribeEose([url], { kinds: [0], limit: 1 }, { onclose, maxWait: 100 });
    await tick();
    expect(pool.active.size).toBe(1);
    const params = [...pool.active.values()][0];
    if (signal === 'eose') params.oneose?.();
    if (signal === 'error') {
      pool.active.clear();
      params.onclose?.('relay error');
    }
    if (signal === 'timeout') jest.advanceTimersByTime(5100);
    if (signal === 'socket close') {
      const relay = await pool.ensureRelay(url);
      relay.onclose?.();
    }
    await tick();
    expect(pool.active.size).toBe(0);
    expect(onclose).toHaveBeenCalledTimes(1);
    pool.destroy();
    expect(jest.getTimerCount()).toBe(0);
  },
);

test('raw one-shot EOSE releases its slot without relying on caller cleanup', async () => {
  const pool = makePool();
  const relay = await pool.ensureRelay(url);
  const onclose = jest.fn();
  const budgeted = pool as typeof pool & {
    subscribeRelay: (relay: Relay, filters: unknown[], params: Params) => unknown;
  };
  budgeted.subscribeRelay(relay, [{ kinds: [0], limit: 1 }], { onclose });
  [...pool.active.values()][0].oneose?.();
  expect(pool.active.size).toBe(0);
  expect(onclose).toHaveBeenCalledTimes(1);
  pool.destroy();
});

test('201 merged groups use one multi-h REQ and rebuild after closing the old REQ', async () => {
  const pool = makePool();
  const originalSubscribe = pool.relay.subscribe;
  const transport = jest.spyOn(pool.relay, 'subscribe').mockImplementation((filters, params) => {
    const request = filters as Filter[];
    if (
      request.length > 20 ||
      new TextEncoder().encode(JSON.stringify(['REQ', 'sub:1', ...request])).length > 64 * 1024
    )
      throw new Error('REQ exceeds relay limits');
    return originalSubscribe(filters, params);
  });
  const mux = createGroupSubscriptionMux((url, filters, next) =>
    pool.subscribeMap(
      filters.map((filter) => ({ url, filter })),
      { onevent: next },
    ),
  );
  const owners = Array.from({ length: 201 }, (_, i) =>
    mux([url], [{ kinds: [445], '#h': [String(i)], limit: 500 }], {}),
  );
  jest.advanceTimersByTime(0);
  await tick();
  expect(pool.active.size).toBe(1);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0]).toEqual([
    {
      kinds: [445],
      '#h': Array.from({ length: 201 }, (_, i) => String(i)),
      limit: 100,
      since: Math.floor(Date.now() / 1000) - 60,
    },
  ]);
  const oldIds = [...pool.active.keys()];
  owners[0].unsubscribe();
  jest.advanceTimersByTime(0);
  await tick();
  expect(pool.active.size).toBe(1);
  expect(oldIds.every((id) => !pool.active.has(id))).toBe(true);
  expect(transport.mock.calls.every(([filters]) => (filters as Filter[]).length <= 20)).toBe(true);
  owners.forEach((o) => o.unsubscribe());
  expect(pool.active.size).toBe(0);
  pool.destroy();
});

test('NOTICE and CLOSED retries use backoff; cancellation prevents resurrection', () => {
  const f = fake(2);
  const inbox = f.add('inbox', 0);
  const other = f.add('profile', 2, 'oneshot');
  f.budget.notice('ERROR: too many concurrent REQs');
  expect(f.active.size).toBe(0);
  other.close();
  jest.advanceTimersByTime(1000);
  expect(f.active).toEqual(new Set(['inbox']));
  inbox.retry();
  inbox.close();
  jest.advanceTimersByTime(30000);
  expect(f.active.size).toBe(0);
  f.budget.dispose();
});

test('smaller limits enforce the cap and at limit one a one-shot temporarily pauses the inbox', () => {
  const f = fake();
  f.add('inbox', 0);
  f.add('group', 1);
  f.add('feed', 2);
  f.budget.setMax(1);
  expect(f.active).toEqual(new Set(['inbox']));
  const shot = f.add('welcome', 1, 'oneshot');
  expect(f.active).toEqual(new Set(['welcome']));
  shot.close();
  expect(f.active).toEqual(new Set(['inbox']));
  f.budget.dispose();
  expect([1, 2, 3, 4, 10].map(liveReqCap)).toEqual([1, 2, 2, 2, 7]);
});

test('a thrown start releases the reserved slot', () => {
  const f = fake(1);
  const disposed = jest.fn();
  f.budget.add(
    1,
    () => {
      throw new Error('subscribe failed');
    },
    disposed,
    { mode: 'oneshot', label: 'welcome' },
  );
  expect(f.budget.open).toBe(0);
  expect(disposed).toHaveBeenCalledWith('Error: subscribe failed');
  f.budget.dispose();
});

test('an abandoned query times out before connection, and a late connect cannot open a REQ', async () => {
  const pool = makePool();
  let connected!: (relay: FakePool['relay']) => void;
  jest.spyOn(FakePool.prototype, 'ensureRelay').mockImplementation(
    () =>
      new Promise((resolve) => {
        connected = resolve;
      }),
  );
  const onclose = jest.fn();
  pool.subscribeEose([url], { kinds: [0], limit: 1 }, { maxWait: 100, onclose });
  await jest.advanceTimersByTimeAsync(5100);
  expect(onclose).toHaveBeenCalledTimes(1);
  connected(pool.relay);
  await tick();
  expect(pool.active.size).toBe(0);
  pool.destroy();
});

test('cancellation during AUTH prevents its eventual completion from opening a second REQ', async () => {
  const pool = makePool();
  let authenticated!: () => void;
  const auth = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        authenticated = resolve;
      }),
  );
  const secret = new Uint8Array(32).fill(5);
  const pubkey = getPublicKey(secret);
  setCurrentUserPubkey(pubkey);
  setRelayAuthAccount({
    pubkey,
    signerType: 'nsec',
    ownRelays: [],
    sign: async (event) => finalizeEvent(event, secret),
  });
  Object.assign(pool.relay, {
    auth,
    challenge: 'test-challenge',
    connectionPromise: Promise.resolve(),
  });
  const sub = pool.subscribeMap([{ url, filter: { kinds: [1], limit: 10 } }], {});
  await tick();
  const params = [...pool.active.values()][0];
  pool.active.clear();
  params.onclose?.('auth-required: challenge');
  await tick();
  expect(auth).toHaveBeenCalledTimes(1);
  sub.close();
  authenticated();
  await tick();
  setRelayAuthAccount(null);
  setCurrentUserPubkey(null);
  expect(pool.active.size).toBe(0);
  expect(pool.serial).toBe(1);
  pool.destroy();
});

test('one-shot terminal completion removes its abort listener', async () => {
  const pool = makePool();
  const abort = new AbortController();
  const remove = jest.spyOn(abort.signal, 'removeEventListener');
  const params = { abort: abort.signal, maxWait: 100 };
  pool.subscribeEose([url], { kinds: [0], limit: 1 }, params);
  await tick();
  [...pool.active.values()][0].oneose?.();
  await tick();
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  pool.destroy();
});

// The inbox must not monopolise the live cap on small-limit relays.
test.each([2, 3, 4])('limit %i runs inbox and groups while allowing one-shots', (max) => {
  const f = fake(max);
  f.add('inbox', reqPriority([{ kinds: [1059] }]));
  f.add('group', reqPriority([{ kinds: [445] }]));
  expect(f.active).toEqual(new Set(['inbox', 'group']));
  jest.advanceTimersByTime(30000);
  expect(f.active).toEqual(new Set(['inbox', 'group']));
  const shotCount = Math.max(1, max - 2);
  const shots = Array.from({ length: shotCount }, (_, i) =>
    f.add(`group-state-${i}`, 1, 'oneshot'),
  );
  expect(f.active.has('inbox')).toBe(true);
  expect([...f.active].filter((name) => name.startsWith('group-state'))).toHaveLength(shotCount);
  expect(f.active.size).toBe(max);
  shots.forEach((shot) => shot.close());
  expect(f.active).toEqual(new Set(['inbox', 'group']));
  expect(f.peak()).toBe(max);
  f.budget.dispose();
});

test.each([2, 3, 4])('limit %i arms merged Marmot groups alongside the inbox', async (max) => {
  const pool = makePool();
  (
    pool as typeof pool & { setRelaySubscriptionLimit(url: string, max: number): void }
  ).setRelaySubscriptionLimit(url, max);
  const inbox = pool.subscribeMap([{ url, filter: { kinds: [1059], limit: 100 } }], {});
  const mux = createGroupSubscriptionMux((url, filters, next) =>
    pool.subscribeMap(
      filters.map((filter) => ({ url, filter })),
      { onevent: next },
    ),
  );
  const owners = Array.from({ length: 20 }, (_, i) =>
    mux([url], [{ kinds: [445], '#h': [String(i)], limit: 500 }], {}),
  );
  jest.advanceTimersByTime(0);
  await tick();
  expect(pool.active.size).toBe(2);
  const onevent = jest.fn();
  pool.subscribeEose([url], { kinds: [445], '#h': ['0'], limit: 1 }, { onevent, maxWait: 100 });
  await tick();
  expect(pool.active.size).toBeLessThanOrEqual(max);
  const shot = [...pool.active.values()].find((params) => params.eoseTimeout !== undefined)!;
  expect(shot).toBeDefined();
  shot.onevent?.({
    id: 'state',
    pubkey: 'p',
    sig: 's',
    kind: 445,
    created_at: 1,
    tags: [],
    content: '',
  });
  expect(onevent).toHaveBeenCalledTimes(1);
  shot.oneose?.();
  await tick();
  expect(pool.active.size).toBe(2);
  owners.forEach((owner) => owner.unsubscribe());
  inbox.close();
  pool.destroy();
  expect(jest.getTimerCount()).toBe(0);
});

test.each([500, 100])(
  'pool resume recovers quiet commits behind 1,001 busy events with relay clamp %i',
  async (clamp) => {
    const pool = makePool();
    (
      pool as typeof pool & { setRelaySubscriptionLimit(url: string, max: number): void }
    ).setRelaySubscriptionLimit(url, 2);
    jest.setSystemTime(1_000_000);
    const stored: Event[] = [];
    const groupReplays: Filter[][] = [];
    let peak = 0;
    const transportSubscribe = pool.relay.subscribe;
    jest.spyOn(pool.relay, 'subscribe').mockImplementation((input, params) => {
      const sub = transportSubscribe(input, params);
      peak = Math.max(peak, pool.active.size);
      const filters = input as Filter[];
      if (filters.some((filter) => filter['#h'])) groupReplays.push(filters);
      for (const filter of filters) {
        stored
          .filter((event) => matchFilter(filter, event))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, Math.min(filter.limit ?? 500, clamp))
          .forEach((event) => params.onevent?.(event));
      }
      if (params.eoseTimeout !== undefined) queueMicrotask(() => params.oneose?.());
      return sub;
    });
    const inbox = pool.subscribeMap([{ url, filter: { kinds: [1059], limit: 100 } }], {});
    const mux = createGroupSubscriptionMux(
      (url, filters, next, onReqOpen, onClose) =>
        pool.subscribeMap(
          filters.map((filter) => ({ url, filter })),
          { onevent: next, onReqOpen, onclose: onClose } as Parameters<
            typeof pool.subscribeMap
          >[1] & { onReqOpen: () => void },
        ),
      (urls, filter, signal) =>
        (
          pool as unknown as {
            querySyncFilters: (
              urls: string[],
              filters: Filter[],
              wait: number,
              opts: { abort: AbortSignal },
            ) => Promise<Event[]>;
          }
        ).querySyncFilters(urls, [filter], 6000, { abort: signal }),
    );
    const busy = jest.fn();
    const quiet = jest.fn();
    const owners = [
      mux([url], [{ kinds: [445], '#h': ['busy'], since: 100, limit: 500 }], { next: busy }),
      mux([url], [{ kinds: [445], '#h': ['quiet'], since: 100, limit: 500 }], { next: quiet }),
    ];
    jest.advanceTimersByTime(0);
    for (let turn = 0; turn < 20; turn++) await jest.advanceTimersByTimeAsync(10);
    expect(pool.active.size).toBe(2);
    const originalGroup = [...pool.active.values()].find(
      (params) => (params as Params & { onReqOpen?: () => void }).onReqOpen !== undefined,
    )!;
    const initialLiveCount = groupReplays.filter((filters) =>
      filters.some((filter) => filter['#h']?.length === 2),
    ).length;
    const blocker = pool.subscribeMap([{ url, filter: { kinds: [0], limit: 1 } }], {
      reqOptions: { mode: 'oneshot', label: 'blocker' },
    } as never);
    await tick();
    expect([...pool.active.values()]).not.toContain(originalGroup);
    expect(
      groupReplays.filter((filters) => filters.some((filter) => filter['#h']?.length === 2)),
    ).toHaveLength(initialLiveCount);
    const commit: Event = {
      id: 'quiet-commit',
      pubkey: 'p',
      sig: 's',
      kind: 445,
      tags: [['h', 'quiet']],
      created_at: 101,
      content: 'missed MLS commit',
    };
    stored.push(
      commit,
      ...Array.from({ length: 1001 }, (_, i) => ({
        ...commit,
        id: `busy-${i}`,
        tags: [['h', 'busy']],
        created_at: 102 + i,
      })),
    );
    expect(quiet).not.toHaveBeenCalled();
    blocker.close();
    for (let turn = 0; turn < 100 && busy.mock.calls.length < 1001; turn++)
      await jest.advanceTimersByTimeAsync(10);
    expect(quiet).toHaveBeenCalledTimes(1);
    expect(quiet).toHaveBeenCalledWith(commit);
    expect(
      groupReplays.filter((filters) => filters.some((filter) => filter['#h']?.length === 2)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      groupReplays.filter((filters) => filters.some((filter) => filter['#h']?.length === 1)).length,
    ).toBeGreaterThan(2);
    expect(busy).toHaveBeenCalledTimes(1001);
    expect(pool.active.size).toBe(2);
    expect(peak).toBe(2);
    owners.forEach((owner) => owner.unsubscribe());
    inbox.close();
    pool.destroy();
    expect(pool.active.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  },
);

test('an expired queued request never starts while receive cleanup is pending', async () => {
  let hydrated!: () => void;
  jest.mocked(hydrateVerifiedEventCache).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        hydrated = resolve;
      }),
  );
  const budget = new RelayReqBudget(url, 1);
  const holder = budget.add(1, () => ({ close: jest.fn() }), jest.fn(), {
    mode: 'oneshot',
    label: 'holder',
  });
  const start = jest.fn(() => ({ close: jest.fn() }));
  const disposed = jest.fn();
  budget.add(2, start, disposed, { mode: 'oneshot', label: 'queued', timeoutMs: 1000 });
  await jest.advanceTimersByTimeAsync(1000);
  holder.close();
  expect(start).not.toHaveBeenCalled();
  expect(disposed).not.toHaveBeenCalled();
  hydrated();
  await jest.advanceTimersByTimeAsync(10);
  expect(disposed).toHaveBeenCalledWith('query deadline');
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  expect(budget.open).toBe(0);
  budget.dispose();
  expect(jest.getTimerCount()).toBe(0);
});

test('a requeued one-shot retains its original deadline after a limit reduction', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const budget = new RelayReqBudget(url, 2);
  const disposed = jest.fn();
  const start = jest.fn(() => ({ close: jest.fn() }));
  budget.add(2, start, disposed, { mode: 'oneshot', label: 'interrupted', timeoutMs: 3000 });
  budget.add(2, () => ({ close: jest.fn() }), jest.fn(), {
    mode: 'oneshot',
    label: 'holder',
    timeoutMs: 10_000,
  });
  await jest.advanceTimersByTimeAsync(1000);
  budget.restrictMax(1);
  expect(budget.open).toBe(1);
  expect(disposed).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(2000);
  expect(disposed).toHaveBeenCalledWith('query deadline');
  expect(disposed).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledTimes(1);
  budget.dispose();
  expect(jest.getTimerCount()).toBe(0);
});

test('a refused first REQ or a NOTICE with one REQ open still leaves room for inbox and groups', () => {
  const f = fake(10);
  const inbox = f.add('inbox', 0);
  inbox.retry(); // CLOSED rate-limited: while it was the only open REQ
  jest.advanceTimersByTime(1000);
  f.add('group', 1);
  expect(f.active).toEqual(new Set(['inbox', 'group']));
  f.budget.notice('rate-limited: slow down');
  expect(f.active.size).toBe(0);
  jest.advanceTimersByTime(30_000);
  expect(f.active).toEqual(new Set(['inbox', 'group']));
  // An explicit NIP-11 limit below the floor is still honoured.
  f.budget.setMax(1);
  expect(f.active).toEqual(new Set(['inbox']));
  inbox.retry();
  jest.advanceTimersByTime(60_000);
  expect(f.active).toEqual(new Set(['inbox']));
  f.budget.dispose();
});
