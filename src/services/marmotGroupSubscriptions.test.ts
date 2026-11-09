import {
  chunkGroupFilters,
  createGroupSubscriptionMux,
  mergedGroupFilters,
  ROUTE_RETRY_BASE_MS,
  ROUTE_RETRY_MAX_MS,
  ROUTE_STABLE_MS,
} from './marmotGroupSubscriptions';
import type { Event } from 'nostr-tools/pure';
import { matchFilter, type Filter } from 'nostr-tools/filter';
import { RelayReqBudget } from './relayReqBudget';

test('20 groups on primal and snort use one multi-h filter per relay', () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const open = jest.fn((_url, _filter, _next) => ({ close: jest.fn() }));
  const subscribe = createGroupSubscriptionMux(open);
  const owners = Array.from({ length: 20 }, (_, i) =>
    subscribe(
      ['wss://relay.primal.net', 'wss://relay.snort.social'],
      [{ kinds: [445], '#h': [`group${i}`], limit: 500, since: 100 + i }],
      { next: jest.fn() },
    ),
  );
  jest.runOnlyPendingTimers();
  expect(open).toHaveBeenCalledTimes(2);
  for (const [, filters] of open.mock.calls) {
    expect(filters).toEqual([
      {
        kinds: [445],
        '#h': Array.from({ length: 20 }, (_, i) => `group${i}`),
        since: 940,
        limit: 100,
      },
    ]);
  }
  owners.forEach((o) => o.unsubscribe());
  jest.runOnlyPendingTimers();
  expect(open.mock.results.every((r) => r.value.close.mock.calls.length === 1)).toBe(true);
  jest.useRealTimers();
});

test('dispatches only to the matching group and drops ambiguous h tags', () => {
  jest.useFakeTimers({ now: 1_000_000 });
  let next!: (e: Event) => void;
  const subscribe = createGroupSubscriptionMux((_url, _filter, cb) => {
    next = cb;
    return { close: jest.fn() };
  });
  const a = jest.fn();
  const b = jest.fn();
  const owners = [
    subscribe(['wss://primal'], [{ kinds: [445], '#h': ['a'], limit: 500 }], { next: a }),
    subscribe(['wss://primal'], [{ kinds: [445], '#h': ['b'], limit: 500 }], { next: b }),
  ];
  jest.runOnlyPendingTimers();
  next({ kind: 445, tags: [['h', 'a']], created_at: 100 } as Event);
  next({
    kind: 445,
    tags: [
      ['h', 'a'],
      ['h', 'b'],
    ],
    created_at: 100,
  } as Event);
  expect(a).toHaveBeenCalledTimes(1);
  expect(b).not.toHaveBeenCalled();
  owners.forEach((o) => o.unsubscribe());
  jest.useRealTimers();
});

test('live filters discard historical cursors and summed limits', () => {
  jest.useFakeTimers({ now: 1_000_000 });
  expect(
    mergedGroupFilters([
      { kinds: [445], '#h': ['a'], since: 100, limit: 500 },
      { kinds: [445], '#h': ['b'], limit: 500 },
    ]),
  ).toEqual([{ kinds: [445], '#h': ['a', 'b'], since: 940, limit: 100 }]);
  jest.useRealTimers();
});

const wireBytes = (filters: Filter[]) =>
  new TextEncoder().encode(JSON.stringify(['REQ', 'sub:1234567890', ...filters])).length;

test.each([
  [41, 4],
  [201, 10],
  [257, 4],
])('%i groups at limit %i all receive live events after budget rotation', (count, max) => {
  jest.useFakeTimers({ now: 1_000_000 });
  const budget = new RelayReqBudget('wss://primal/', max);
  const active = new Set<(event: Event) => void>();
  const requests: Filter[][] = [];
  const stored: Event[] = [];
  let physical = 0;
  let peak = 0;
  const subscribe = createGroupSubscriptionMux((_url, filters, next) =>
    budget.add(
      1,
      () => {
        expect(filters.every((f) => f['#h']!.length <= 256)).toBe(true);
        expect(wireBytes(filters)).toBeLessThanOrEqual(64 * 1024);
        requests.push(filters);
        peak = Math.max(peak, ++physical);
        const deliver = (event: Event) => {
          if (filters.some((filter) => matchFilter(filter, event))) next(event);
        };
        active.add(deliver);
        filters.forEach((filter) =>
          stored
            .filter((event) => matchFilter(filter, event))
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, filter.limit)
            .forEach(next),
        );
        return {
          close: () => {
            active.delete(deliver);
            physical--;
          },
        };
      },
      undefined,
      { mode: 'live', label: 'live-group' },
    ),
  );
  const inbox = budget.add(0, () => {
    peak = Math.max(peak, ++physical);
    return { close: () => void physical-- };
  });
  const observers = Array.from({ length: count }, () => jest.fn());
  const owners = observers.map((next, i) =>
    subscribe(
      ['wss://primal'],
      [{ kinds: [445], '#h': [`group${i}`], since: 100 + i, limit: 500 }],
      { next },
    ),
  );
  const events = observers.map(
    (_, i) =>
      ({
        id: `event${i}`,
        kind: 445,
        tags: [['h', `group${i}`]],
        created_at: 1000 + i,
        pubkey: 'p',
        sig: 's',
        content: '',
      }) as Event,
  );
  jest.advanceTimersByTime(0);
  expect(requests.length).toBeLessThanOrEqual(2);
  expect(requests.flat().flatMap((f) => f['#h'])).toHaveLength(count);
  expect(requests.flat()).toHaveLength(count > 256 ? 2 : 1);
  events.forEach((event) => active.forEach((deliver) => deliver(event)));
  observers.forEach((next, i) => expect(next).toHaveBeenCalledWith(events[i]));
  // A one-shot rotates the merged owner at a two-slot budget.
  budget.setMax(2);
  const shot = budget.add(
    1,
    () => {
      peak = Math.max(peak, ++physical);
      return { close: () => void physical-- };
    },
    undefined,
    { mode: 'oneshot', label: 'group-state' },
  );
  expect(active.size).toBe(0);
  shot.close();
  stored.push(...events.map((e) => ({ ...e, id: `live-${e.id}` })));
  stored.forEach((event) => active.forEach((deliver) => deliver(event)));
  observers.forEach((next, i) => {
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenLastCalledWith(stored[i]);
  });
  // The older merged cursor must not dispatch stale events to newer logical owners.
  const stale = { ...events[count - 1], id: 'stale', created_at: 100 };
  active.forEach((deliver) => deliver(stale));
  expect(observers[count - 1]).toHaveBeenCalledTimes(2);
  expect(peak).toBeLessThanOrEqual(max);
  owners[0].unsubscribe();
  jest.advanceTimersByTime(0);
  expect(active.size).toBe(1);
  expect(requests.at(-1)!.flatMap((f) => f['#h'])).not.toContain('group0');
  owners.forEach((owner) => owner.unsubscribe());
  inbox.close();
  budget.dispose();
  expect(physical).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('splits live filters by serialized UTF-8 size', () => {
  // A fixed clock: `since` is stamped from Date.now() inside the merge, and a
  // second boundary crossed before the assertion re-read it would fail (#1815).
  jest.useFakeTimers({ now: 1_000_000 });
  const filters = mergedGroupFilters(
    Array.from({ length: 40 }, (_, i) => ({
      kinds: [445],
      '#h': [`${i}-${'é'.repeat(1000)}`],
      since: 100 + i,
      limit: 500,
    })),
  );
  const chunks = chunkGroupFilters(filters);
  expect(chunks).toHaveLength(2);
  expect(chunks.every((chunk) => wireBytes(chunk) <= 64 * 1024)).toBe(true);
  expect(filters.flatMap((f) => f['#h'])).toHaveLength(40);
  expect(filters.every((f) => f.limit === 100)).toBe(true);
  expect(filters.every((f) => f.since === 940)).toBe(true);
  jest.useRealTimers();
});

test('oversized routing sets rotate REQs on one group slot alongside a limit-4 inbox', () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const budget = new RelayReqBudget('wss://primal/', 4);
  const ids = Array.from({ length: 40 }, (_, i) => `${i}-${'é'.repeat(1000)}`);
  const observers = ids.map(() => jest.fn());
  const seen = new Set<string>();
  let physical = 0;
  let peak = 0;
  const inbox = budget.add(0, () => {
    peak = Math.max(peak, ++physical);
    return { close: () => void physical-- };
  });
  const subscribe = createGroupSubscriptionMux((_url, filters, next) =>
    budget.add(
      1,
      () => {
        peak = Math.max(peak, ++physical);
        expect(wireBytes(filters)).toBeLessThanOrEqual(64 * 1024);
        for (const h of filters.flatMap((filter) => filter['#h']!)) {
          seen.add(h);
          next({ kind: 445, tags: [['h', h]], created_at: 1000 } as Event);
        }
        return { close: () => void physical-- };
      },
      undefined,
      { mode: 'live', label: 'live-group' },
    ),
  );
  const owners = ids.map((h, i) =>
    subscribe(['wss://primal'], [{ kinds: [445], '#h': [h], since: 100, limit: 500 }], {
      next: observers[i],
    }),
  );
  jest.advanceTimersByTime(30_000);
  expect(seen.size).toBe(ids.length);
  observers.forEach((next) => expect(next.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(peak).toBe(2);
  owners.forEach((owner) => owner.unsubscribe());
  inbox.close();
  budget.dispose();
  expect(physical).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('rejects an indivisible oversized filter rather than opening an oversized REQ', () => {
  expect(chunkGroupFilters([])).toEqual([]);
  const oversized = [{ kinds: [445], '#h': ['é'.repeat(32768)] }];
  expect(() => mergedGroupFilters(oversized)).toThrow(
    'Marmot group filter exceeds REQ message-size limit',
  );
  expect(() => chunkGroupFilters(oversized)).toThrow(
    'Marmot group filter exceeds REQ message-size limit',
  );
});

test('socket reconnect re-arms live routing and independently recovers each group; cleanup does not reconnect', async () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const request = jest.fn().mockResolvedValue([]);
  const close = jest.fn();
  const open = jest.fn((_url, _filters, _next, onOpen, _onClose) => {
    onOpen();
    return { close };
  });
  const recovered = jest.fn();
  const subscribe = createGroupSubscriptionMux(open, request, recovered);
  const owner = subscribe(['wss://r'], [{ kinds: [445], '#h': ['a'], since: 100, limit: 500 }], {});
  await jest.advanceTimersByTimeAsync(10);
  expect(request).toHaveBeenCalledTimes(2);
  expect(recovered).not.toHaveBeenCalled(); // the initial arm is not a reconnect
  jest.setSystemTime(1_120_000);
  open.mock.calls[0][4]();
  await jest.advanceTimersByTimeAsync(1010);
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[1][1][0]).toMatchObject({ since: 1061, limit: 100 });
  expect(request).toHaveBeenCalledTimes(3);
  expect(recovered).toHaveBeenCalledTimes(1);
  expect(
    request.mock.calls.every(([, filter]) => filter.since === 100 && filter['#h'].length === 1),
  ).toBe(true);
  owner.unsubscribe();
  open.mock.calls[1][4]();
  await jest.advanceTimersByTimeAsync(2000);
  expect(open).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('subscribe starts independent history even while the physical live REQ is queued', async () => {
  jest.useFakeTimers();
  const request = jest.fn().mockResolvedValue([]);
  const subscribe = createGroupSubscriptionMux(() => ({ close: jest.fn() }), request);
  const owner = subscribe(
    ['wss://r'],
    [{ kinds: [445], '#h': ['quiet'], since: 100, limit: 500 }],
    {},
  );
  await jest.advanceTimersByTimeAsync(10);
  expect(request).toHaveBeenCalledWith(
    ['wss://r/'],
    { kinds: [445], '#h': ['quiet'], since: 100, limit: 500 },
    expect.any(AbortSignal),
  );
  owner.unsubscribe();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('a relay that CLOSEs the group REQ right after it is sent keeps backing off (no 1 s recovery loop)', () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const open = jest.fn(
    (
      _url: string,
      _filters: Filter[],
      _next: (e: Event) => void,
      onOpen: () => void,
      onClose: () => void,
    ) => {
      // The socket is up and the REQ goes out, then the relay refuses it.
      onOpen();
      setTimeout(onClose, 5);
      return { close: jest.fn() };
    },
  );
  const subscribe = createGroupSubscriptionMux(open);
  const owner = subscribe(['wss://full.example'], [{ kinds: [445], '#h': ['a'], limit: 500 }], {
    next: jest.fn(),
  });
  jest.advanceTimersByTime(60_000);
  // Backoff grows exactly as for a dead socket: about seven arms a minute, not sixty.
  expect(open.mock.calls.length).toBeLessThanOrEqual(7);
  owner.unsubscribe();
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

test('a relay whose socket keeps failing re-arms with exponential backoff, reset by a successful arm', () => {
  jest.useFakeTimers({ now: 1_000_000 });
  let failing = true;
  const open = jest.fn(
    (
      _url: string,
      _filters: Filter[],
      _next: (e: Event) => void,
      onOpen: () => void,
      onClose: () => void,
    ) => {
      // A dead relay fails its connect attempt shortly after each arm.
      if (failing) setTimeout(onClose, 1);
      else onOpen();
      return { close: jest.fn() };
    },
  );
  const subscribe = createGroupSubscriptionMux(open);
  const owner = subscribe(['wss://dead.example'], [{ kinds: [445], '#h': ['a'], limit: 500 }], {
    next: jest.fn(),
  });
  jest.advanceTimersByTime(60_000);
  // 1 s, 2 s, 4 s, 8 s, 16 s, 32 s: seven attempts in a minute, not sixty.
  expect(open.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(open.mock.calls.length).toBeLessThanOrEqual(7);
  jest.advanceTimersByTime(10 * 60_000);
  expect(open.mock.calls.length).toBeLessThanOrEqual(7 + 10);
  // The relay comes back: the next arm opens, stays up, and the backoff resets.
  failing = false;
  jest.advanceTimersByTime(ROUTE_RETRY_MAX_MS + 10);
  const opened = open.mock.calls.length;
  expect(opened).toBeGreaterThan(7);
  jest.advanceTimersByTime(ROUTE_STABLE_MS);
  failing = true;
  open.mock.calls[opened - 1][4]();
  jest.advanceTimersByTime(ROUTE_RETRY_BASE_MS + 10);
  expect(open.mock.calls.length).toBe(opened + 1);
  owner.unsubscribe();
  jest.runOnlyPendingTimers();
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});
