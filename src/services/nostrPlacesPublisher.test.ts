// Tests for the runtime publish/subscribe wrappers in nostrPlacesPublisher.
// The nostr-tools pool is mocked so we can assert filter shapes (incl. the
// 30-day `since` window added in #1029) without a real relay connection.

// Hoist mocks before imports (jest.mock is hoisted automatically by babel-jest;
// the vars are captured via the factory closures).
const mockSubscribeMany = jest.fn();
const mockSubscribeMap = jest.fn();
const mockClose = jest.fn();

jest.mock('./nostrService', () => ({
  pool: {
    subscribeMany: (...a: unknown[]) => mockSubscribeMany(...a),
    subscribeMap: (...a: unknown[]) => mockSubscribeMap(...a),
  },
  DEFAULT_RELAYS: ['wss://default.example'],
  publishSignedEvent: jest.fn(),
}));

jest.mock('./devEventDenylist', () => ({
  isDevLeftover: () => false,
}));

jest.mock('./nostrPlacesService', () => ({
  GC_LISTING_KIND: 37516,
  GC_FOUND_LOG_KIND: 7516,
  GC_COMMENT_KIND: 1111,
  parseCache: (e: unknown) => e,
  parseFoundLogEvent: (e: unknown) => e,
}));

jest.mock('./geocacheRelays', () => ({
  GC_RELAYS: ['wss://gc.example'],
}));

// eslint-disable-next-line import/first
import {
  fetchFoundLogsByAuthors,
  subscribeComments,
  subscribeFoundLogs,
  subscribeFoundLogsByAuthors,
  subscribeNearbyCaches,
  subscribeNearbyEvents,
  subscribeRecentCaches,
  subscribeRecentFoundLogs,
} from './nostrPlacesPublisher';

beforeEach(() => {
  jest.clearAllMocks();
  mockSubscribeMany.mockReturnValue({ close: mockClose });
  mockSubscribeMap.mockReturnValue({ close: mockClose });
});

// ---------------------------------------------------------------------------
// subscribeRecentCaches — 30-day since window (#1029 Fix 2)
// ---------------------------------------------------------------------------

describe('subscribeRecentCaches', () => {
  it('includes a since field approximately 30 days in the past', () => {
    const before = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    subscribeRecentCaches(jest.fn());
    const after = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    expect(mockSubscribeMany).toHaveBeenCalledTimes(1);
    const [, filterArg] = mockSubscribeMany.mock.calls[0] as [unknown, { since: number }];
    // Allow ±5 s tolerance for the tick between `before` and `after`
    // (keeps the assertion deterministic under CI load).
    expect(filterArg.since).toBeGreaterThanOrEqual(before - 5);
    expect(filterArg.since).toBeLessThanOrEqual(after + 5);
  });

  it('retains the default limit of 200', () => {
    subscribeRecentCaches(jest.fn());
    const [, filterArg] = mockSubscribeMany.mock.calls[0] as [unknown, { limit: number }];
    expect(filterArg.limit).toBe(200);
  });

  it('targets kind 37516', () => {
    subscribeRecentCaches(jest.fn());
    const [, filterArg] = mockSubscribeMany.mock.calls[0] as [unknown, { kinds: number[] }];
    expect(filterArg.kinds).toEqual([37516]);
  });

  it('forwards parsed events to the callback', () => {
    const onEvent = jest.fn();
    subscribeRecentCaches(onEvent);
    const [, , handlers] = mockSubscribeMany.mock.calls[0] as [
      unknown,
      unknown,
      { onevent: (e: unknown) => void },
    ];
    const fake = { id: 'c1', kind: 37516, pubkey: 'pk', created_at: 1, tags: [], content: '' };
    handlers.onevent(fake);
    // parseCache is mocked to return the event as-is.
    expect(onEvent).toHaveBeenCalledWith(fake);
  });

  it('returns a teardown that closes the underlying subscription', () => {
    const close = subscribeRecentCaches(jest.fn());
    close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// subscribeRecentFoundLogs — 30-day since window (#1029 Fix 2)
// ---------------------------------------------------------------------------

describe('subscribeRecentFoundLogs', () => {
  it('includes a since field approximately 30 days in the past', () => {
    const before = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    subscribeRecentFoundLogs(jest.fn());
    const after = Math.floor(Date.now() / 1000) - 30 * 24 * 3600;
    expect(mockSubscribeMany).toHaveBeenCalledTimes(1);
    const [, filterArg] = mockSubscribeMany.mock.calls[0] as [unknown, { since: number }];
    // Allow ±5 s tolerance for the tick between `before` and `after`
    // (keeps the assertion deterministic under CI load).
    expect(filterArg.since).toBeGreaterThanOrEqual(before - 5);
    expect(filterArg.since).toBeLessThanOrEqual(after + 5);
  });

  it('retains the default limit of 200', () => {
    subscribeRecentFoundLogs(jest.fn());
    const [, filterArg] = mockSubscribeMany.mock.calls[0] as [unknown, { limit: number }];
    expect(filterArg.limit).toBe(200);
  });

  it('targets kind 7516', () => {
    subscribeRecentFoundLogs(jest.fn());
    const [, filterArg] = mockSubscribeMany.mock.calls[0] as [unknown, { kinds: number[] }];
    expect(filterArg.kinds).toEqual([7516]);
  });

  it('forwards parsed events to the callback', () => {
    const onEvent = jest.fn();
    subscribeRecentFoundLogs(onEvent);
    const [, , handlers] = mockSubscribeMany.mock.calls[0] as [
      unknown,
      unknown,
      { onevent: (e: unknown) => void },
    ];
    const fake = { id: 'l1', kind: 7516, pubkey: 'finder', created_at: 2, tags: [], content: '' };
    handlers.onevent(fake);
    expect(onEvent).toHaveBeenCalledWith(fake);
  });

  it('returns a teardown that closes the underlying subscription', () => {
    const close = subscribeRecentFoundLogs(jest.fn());
    close();
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('both recent subs have independent since values (separate subscription time)', () => {
    subscribeRecentCaches(jest.fn());
    subscribeRecentFoundLogs(jest.fn());
    expect(mockSubscribeMany).toHaveBeenCalledTimes(2);
    const cachesSince = (mockSubscribeMany.mock.calls[0] as [unknown, { since: number }])[1].since;
    const logsSince = (mockSubscribeMany.mock.calls[1] as [unknown, { since: number }])[1].since;
    // Both should be within a few seconds of each other (test runs in <1 s).
    // Each is independently computed via RECENT_SINCE_SECS() at call time.
    // ±10 s is generous enough to be stable under CI load.
    expect(Math.abs(cachesSince - logsSince)).toBeLessThan(10);
  });
});

// ---------------------------------------------------------------------------
// Per-cache and per-author subscriptions — bounded backfill (#1789)
// ---------------------------------------------------------------------------

describe('found-log and comment subscription bounds', () => {
  it('caps a cache’s found-log backfill at 500 without a time window', () => {
    subscribeFoundLogs('37516:abc:d', jest.fn());
    const filter = mockSubscribeMany.mock.calls[0][1];
    expect(filter).toEqual({ kinds: [7516], '#a': ['37516:abc:d'], limit: 500 });
  });

  it('caps a cache’s comment backfill at 500 without a time window', () => {
    subscribeComments('37516:abc:d', jest.fn());
    const filter = mockSubscribeMany.mock.calls[0][1];
    expect(filter.limit).toBe(500);
    expect(filter.since).toBeUndefined();
  });

  it('sends one bounded REQ for a small author set', () => {
    subscribeFoundLogsByAuthors(['me'], jest.fn());
    expect(mockSubscribeMany).toHaveBeenCalledTimes(1);
    expect(mockSubscribeMany.mock.calls[0][1]).toEqual({
      kinds: [7516],
      authors: ['me'],
      limit: 500,
    });
  });

  it('opens nothing for an empty author set', () => {
    subscribeFoundLogsByAuthors([], jest.fn())();
    expect(mockSubscribeMany).not.toHaveBeenCalled();
  });
});

describe('fetchFoundLogsByAuthors (Friends’ finds, #1789)', () => {
  type MapCall = [
    { url: string; filter: Record<string, unknown> }[],
    {
      reqOptions: { mode: string };
      onevent: (e: { id: string; created_at: number }) => void;
      onclose: (reasons: string[]) => void;
    },
  ];
  const calls = (): MapCall[] => mockSubscribeMap.mock.calls as MapCall[];
  const pubkeys = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => i.toString(16).padStart(64, '0'));

  it('sends one one-shot REQ per relay for a normal-sized author set', () => {
    fetchFoundLogsByAuthors(pubkeys(300), jest.fn(), ['wss://a.example'], 200);
    expect(mockSubscribeMany).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
    const [requests, params] = calls()[0];
    // One filter per relay → one physical REQ (one budget slot) per relay,
    // released at EOSE.
    expect(params.reqOptions.mode).toBe('oneshot');
    expect(requests.map((r) => r.url)).toEqual(['wss://a.example', 'wss://gc.example']);
    expect(requests[0].filter).toEqual({ kinds: [7516], authors: pubkeys(300), limit: 200 });
  });

  it('sends a 2,000-author set as 4 sequential one-shot chunks, one at a time', () => {
    const authors = pubkeys(2000);
    fetchFoundLogsByAuthors(authors, jest.fn(), ['wss://a.example'], 200);
    const sent: string[] = [];
    for (let i = 0; i < 4; i++) {
      // Only the chunk in flight is open: the next is not sent until every
      // relay has closed this one.
      expect(calls()).toHaveLength(i + 1);
      const [requests, params] = calls()[i];
      expect(params.reqOptions.mode).toBe('oneshot');
      expect(new Set(requests.map((r) => r.url)).size).toBe(requests.length);
      const chunk = requests[0].filter.authors as string[];
      expect(chunk.length).toBe(500);
      sent.push(...chunk);
      params.onclose(['closed automatically on eose']);
    }
    expect(calls()).toHaveLength(4);
    expect(sent).toEqual(authors);
  });

  it('only asks later chunks for logs newer than the current limit-th newest', () => {
    fetchFoundLogsByAuthors(pubkeys(1000), jest.fn(), ['wss://a.example'], 3);
    const [, first] = calls()[0];
    for (const created_at of [100, 400, 300, 200])
      first.onevent({ id: `e${created_at}`, created_at });
    first.onclose([]);
    // Newest 3 so far: 400, 300, 200 → nothing older than 200 can make the cut.
    expect(calls()[1][0][0].filter).toMatchObject({ limit: 3, since: 200 });
  });

  it('does not tighten `since` until `limit` logs are in hand', () => {
    fetchFoundLogsByAuthors(pubkeys(1000), jest.fn(), ['wss://a.example'], 3);
    calls()[0][1].onevent({ id: 'e1', created_at: 100 });
    calls()[0][1].onclose([]);
    expect(calls()[1][0][0].filter.since).toBeUndefined();
  });

  it('closing cancels the chunk in flight and the rest', () => {
    const onEvent = jest.fn();
    const close = fetchFoundLogsByAuthors(pubkeys(1000), onEvent, ['wss://a.example']);
    close();
    expect(mockClose).toHaveBeenCalledTimes(1);
    calls()[0][1].onevent({ id: 'late', created_at: 1 });
    calls()[0][1].onclose([]);
    expect(onEvent).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
  });
});

describe('Explore nearby backfill budgets', () => {
  it('bounds merchant-map cache listings without excluding old active listings', () => {
    const close = subscribeNearbyCaches(['gcpvj'], jest.fn());
    expect(mockSubscribeMany.mock.calls[0][1]).toMatchObject({ limit: 200, '#g': ['gcpvj'] });
    expect(mockSubscribeMany.mock.calls[0][1].since).toBeUndefined();
    close();
  });
  it('bounds both geographic and topical event backfills', () => {
    const close = subscribeNearbyEvents(['gcp'], jest.fn());
    expect(mockSubscribeMany).toHaveBeenCalledTimes(2);
    for (const [, filter] of mockSubscribeMany.mock.calls) {
      expect(filter.limit).toBe(200);
      // An upcoming event can have been announced long ago.
      expect(filter.since).toBeUndefined();
    }
    close();
    expect(mockClose).toHaveBeenCalledTimes(2);
  });
});

describe('nearby cache completion', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function subscribe() {
    const onEose = jest.fn();
    const onEvent = jest.fn();
    const close = subscribeNearbyCaches(['gcpvj'], onEvent, undefined, {}, onEose);
    const handlers = mockSubscribeMany.mock.calls[0][2] as {
      oneose: () => void;
      onclose: (reasons: string[]) => void;
      onevent: (e: unknown) => void;
    };
    return { onEose, onEvent, close, handlers };
  }

  it('waits for the pool aggregate EOSE (including partial relay closure)', async () => {
    const { onEose, handlers, close } = subscribe();
    expect(onEose).not.toHaveBeenCalled();
    handlers.oneose();
    await Promise.resolve();
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: false });
    jest.advanceTimersByTime(8000);
    handlers.oneose();
    await Promise.resolve();
    expect(onEose).toHaveBeenCalledTimes(1);
    close();
  });

  it('reports total failure despite the pool calling EOSE before close', async () => {
    const { onEose, handlers, close } = subscribe();
    handlers.oneose();
    handlers.onclose(['connection failed']);
    await Promise.resolve();
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: true });
    close();
  });

  it('completes at eight seconds even if the pool never responds', () => {
    const { onEose, close } = subscribe();
    jest.advanceTimersByTime(7999);
    expect(onEose).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: false });
    close();
  });

  it('keeps delivering late events after timeout without completing twice', async () => {
    const { onEose, onEvent, handlers, close } = subscribe();
    jest.advanceTimersByTime(8000);
    const event = { id: 'late', pubkey: 'hider' };
    handlers.onevent(event);
    expect(onEvent).toHaveBeenCalledWith(event);
    handlers.oneose();
    handlers.onclose(['closed']);
    await Promise.resolve();
    expect(onEose).toHaveBeenCalledTimes(1);
    close();
  });

  it('does not report total failure if data arrived before closure', () => {
    const { onEose, handlers, close } = subscribe();
    handlers.onevent({ id: 'cache', pubkey: 'hider' });
    handlers.onclose(['closed']);
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: false });
    close();
  });

  it('cancels both pending EOSE and timeout on teardown and ignores late events', async () => {
    const { onEose, onEvent, handlers, close } = subscribe();
    handlers.oneose();
    close();
    handlers.onclose(['closed']);
    handlers.onevent({ pubkey: 'hider' });
    await Promise.resolve();
    jest.advanceTimersByTime(8000);
    expect(onEose).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('completes an empty prefix query without opening relays', () => {
    const onEose = jest.fn();
    subscribeNearbyCaches([], jest.fn(), undefined, {}, onEose)();
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: false });
    expect(mockSubscribeMany).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

// Exercise the real SDK's relay aggregation too: a pool-level EOSE is not
// allowed to hide a still-pending relay, and total close precedes its microtask.
describe('nearby completion with real relay aggregation', () => {
  const relays = ['wss://first.example', 'wss://second.example'];
  let children: { oneose: () => void; onclose: (reason: string) => void }[];

  beforeEach(() => {
    const { SimplePool } = jest.requireActual('nostr-tools/pool');
    const realPool = new SimplePool();
    children = [];
    realPool.ensureRelay = async () => ({
      subscribe: (_filters: unknown, handlers: (typeof children)[number]) => {
        children.push(handlers);
        return { close: () => handlers.onclose('closed by caller') };
      },
    });
    mockSubscribeMany.mockImplementation((...args) => realPool.subscribeMany(...args));
  });
  afterEach(() => mockSubscribeMany.mockReset());

  it('waits for every queried relay, treating partial closure as settled', async () => {
    const onEose = jest.fn();
    const close = subscribeNearbyCaches(['gcpvj'], jest.fn(), relays, {}, onEose);
    await Promise.resolve();
    // Caller relays plus the geo-cache backbone from withGcRelays.
    expect(children).toHaveLength(3);
    children[0].oneose();
    children[1].onclose('connection failed');
    await Promise.resolve();
    expect(onEose).not.toHaveBeenCalled();
    children[2].oneose();
    await Promise.resolve();
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: false });
    close();
  });

  it('detects every relay closing before EOSE with the SDK callback ordering', async () => {
    const onEose = jest.fn();
    const close = subscribeNearbyCaches(['gcpvj'], jest.fn(), relays, {}, onEose);
    await Promise.resolve();
    children.forEach((child) => child.onclose('connection failed'));
    await Promise.resolve();
    expect(onEose).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledWith({ allRelaysFailed: true });
    close();
  });
});
