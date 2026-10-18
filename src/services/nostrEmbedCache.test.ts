import type { Event } from 'nostr-tools';
import {
  __resetEmbedCacheForTests,
  peekEmbed,
  resolveEmbed,
  type EmbedRef,
} from './nostrEmbedCache';

const mockQuery = jest.fn();
const mockRevision = jest.fn();
const mockPrune = jest.fn();
const mockValid = jest.fn((e: Event) => e.sig !== 'bad');

jest.mock('./nostrPool', () => ({
  pool: {},
  trackRelays: jest.fn(),
  pruneIdleRelays: () => mockPrune(),
}));
jest.mock('./relayQuery', () => ({
  querySyncAbortable: (...args: unknown[]) => mockQuery(...args),
}));
// Keep the former per-product dependency mocked for the old-code regression run.
jest.mock('./marketListingsService', () => ({
  fetchListingRevision: (...args: unknown[]) => mockRevision(...args),
}));
jest.mock('./nostrEmbedProducts', () => ({
  reconcileEmbedProducts: (...args: unknown[]) => mockRevision(...args),
}));
jest.mock('../utils/eventSignature', () => ({
  hasValidSignature: (e: Event) => mockValid(e),
}));
jest.mock('../utils/marketListings', () => ({
  parseMarketListing: (e: Event) => ({ id: `p-${e.id}`, listing: { event: e } }),
}));

const PK = 'a'.repeat(64);
const id = (c: string) => c.repeat(64);
const ev = (over: Partial<Event>): Event => ({
  id: id('1'),
  pubkey: PK,
  kind: 1,
  created_at: 100,
  content: 'hi',
  tags: [],
  sig: 'ok',
  ...over,
});
const eventRef = (eid: string, relays: string[] = []): EmbedRef => ({
  type: 'event',
  id: eid,
  relays,
  raw: '',
});
const addrRef = (kind: number, identifier: string): EmbedRef => ({
  type: 'address',
  kind,
  pubkey: PK,
  identifier,
  relays: [],
  raw: '',
});

beforeEach(() => {
  jest.useFakeTimers();
  __resetEmbedCacheForTests();
  mockQuery.mockReset();
  mockRevision.mockReset().mockResolvedValue(new Map());
  mockPrune.mockClear();
  mockValid.mockClear();
});
afterEach(() => jest.useRealTimers());

async function settle<T>(p: Promise<T>): Promise<T> {
  await jest.advanceTimersByTimeAsync(100);
  return p;
}

it('batches concurrent event refs into one bounded ids query', async () => {
  mockQuery.mockResolvedValue([ev({ id: id('1') }), ev({ id: id('2') })]);
  const a = resolveEmbed(eventRef(id('1')), ['wss://read']);
  const b = resolveEmbed(eventRef(id('2'), ['wss://hint']), ['wss://read']);
  const [ra, rb] = await settle(Promise.all([a, b]));
  expect(mockQuery).toHaveBeenCalledTimes(1);
  const [, relays, filter, opts] = mockQuery.mock.calls[0];
  expect(relays).toEqual(['wss://read', 'wss://hint']);
  expect(filter).toEqual({ ids: [id('1'), id('2')], limit: 2 });
  expect(opts.maxWait).toBeGreaterThan(0);
  expect(ra.event?.id).toBe(id('1'));
  expect(rb.event?.id).toBe(id('2'));
});

it('serves repeats from the cache and de-dupes in-flight requests', async () => {
  mockQuery.mockResolvedValue([ev({ id: id('1') })]);
  const first = resolveEmbed(eventRef(id('1')), ['wss://read']);
  const again = resolveEmbed(eventRef(id('1')), ['wss://read']);
  const [a, b] = await settle(Promise.all([first, again]));
  expect(a).toBe(b);
  expect(peekEmbed(`e:${id('1')}`)?.event?.id).toBe(id('1'));
  await settle(resolveEmbed(eventRef(id('1')), ['wss://read']));
  expect(mockQuery).toHaveBeenCalledTimes(1);
});

it('rejects bad signatures and events that do not match the ref', async () => {
  mockQuery.mockResolvedValue([ev({ id: id('1'), sig: 'bad' }), ev({ id: id('9') })]);
  const r = await settle(resolveEmbed(eventRef(id('1')), ['wss://read']));
  expect(r.event).toBeNull();
});

it('caches misses only briefly', async () => {
  mockQuery.mockResolvedValue([]);
  await settle(resolveEmbed(eventRef(id('3')), ['wss://read']));
  expect(peekEmbed(`e:${id('3')}`)).toEqual({ event: null });
  jest.setSystemTime(Date.now() + 3 * 60 * 1000);
  expect(peekEmbed(`e:${id('3')}`)).toBeUndefined();
});

it('re-fetches addressable events after a while but keeps notes', async () => {
  mockQuery.mockResolvedValueOnce([ev({ id: id('8') })]);
  await settle(resolveEmbed(eventRef(id('8')), ['wss://read']));
  mockQuery.mockResolvedValueOnce([ev({ id: id('9'), kind: 30023, tags: [['d', 'a']] })]);
  await settle(resolveEmbed(addrRef(30023, 'a'), ['wss://read']));
  jest.setSystemTime(Date.now() + 11 * 60 * 1000);
  expect(peekEmbed(`e:${id('8')}`)?.event?.id).toBe(id('8'));
  expect(peekEmbed(`a:30023:${PK}:a`)).toBeUndefined();
});

it('picks the newest revision of an addressed article', async () => {
  const d = (v: string) => [['d', v]];
  mockQuery.mockResolvedValue([
    ev({ id: id('4'), kind: 30023, created_at: 100, tags: d('post') }),
    ev({ id: id('5'), kind: 30023, created_at: 200, tags: d('post') }),
    ev({ id: id('6'), kind: 30023, created_at: 300, tags: d('other') }),
  ]);
  const r = await settle(resolveEmbed(addrRef(30023, 'post'), ['wss://read']));
  expect(mockQuery.mock.calls[0][2]).toEqual({
    kinds: [30023],
    authors: [PK],
    '#d': ['post'],
    limit: 3,
  });
  expect(r.event?.id).toBe(id('5'));
});

it('applies the seller deletions to an embedded product', async () => {
  const listing = ev({ id: id('7'), kind: 30402, tags: [['d', 'mug']] });
  mockQuery.mockResolvedValue([listing]);
  mockRevision.mockResolvedValue(new Map([[listing.id, null]])); // withdrawn
  const r = await settle(resolveEmbed(addrRef(30402, 'mug'), ['wss://read']));
  expect(mockRevision).toHaveBeenCalledWith([listing], ['wss://read'], 5000, expect.anything());
  expect(r.product).toBeNull();
});

it('reconciles twenty products in one batch instead of twenty independent revisions', async () => {
  const listings = Array.from({ length: 20 }, (_, i) =>
    ev({ id: `${i}`.padStart(64, '0'), kind: 30402, tags: [['d', `item-${i}`]] }),
  );
  mockQuery.mockResolvedValue(listings);
  await settle(
    Promise.all(listings.map((e, i) => resolveEmbed(addrRef(30402, `item-${i}`), ['wss://read']))),
  );
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockRevision).toHaveBeenCalledTimes(1);
  expect(mockRevision).toHaveBeenCalledWith(listings, ['wss://read'], 5000, expect.anything());
});

it('prunes idle connections after every hinted batch, including failed queries', async () => {
  mockQuery.mockRejectedValue(new Error('offline'));
  await settle(resolveEmbed(eventRef(id('1'), ['wss://hint-1']), ['wss://read']));
  await settle(resolveEmbed(eventRef(id('2'), ['wss://hint-2']), ['wss://read']));
  expect(mockPrune).toHaveBeenCalledTimes(2);
});

it('delivers ordinary embeds while a product query and seller reconciliation are pending', async () => {
  const note = ev({ id: id('1') });
  const listing = ev({ id: id('7'), kind: 30402, tags: [['d', 'mug']] });
  let finishQuery!: (events: Event[]) => void;
  let finishProducts!: (products: Map<string, null>) => void;
  mockQuery.mockImplementation((_pool, _relays, filter) =>
    filter.ids
      ? Promise.resolve([note])
      : new Promise((resolve) => {
          finishQuery = resolve;
        }),
  );
  mockRevision.mockImplementation(
    () =>
      new Promise((resolve) => {
        finishProducts = resolve;
      }),
  );
  const receiveNote = jest.fn();
  const receiveProduct = jest.fn();
  const ordinary = resolveEmbed(eventRef(note.id), ['wss://read']).then(receiveNote);
  const product = resolveEmbed(addrRef(30402, 'mug'), ['wss://read']).then(receiveProduct);
  await jest.advanceTimersByTimeAsync(100);
  expect(receiveNote).toHaveBeenCalledWith({ event: note });
  expect(peekEmbed(`e:${note.id}`)).toEqual({ event: note });
  expect(receiveProduct).not.toHaveBeenCalled();
  finishQuery([listing]);
  await jest.advanceTimersByTimeAsync(0);
  expect(receiveProduct).not.toHaveBeenCalled();
  expect(mockPrune).not.toHaveBeenCalled();
  finishProducts(new Map([[listing.id, null]]));
  await jest.advanceTimersByTimeAsync(0);
  await Promise.all([ordinary, product]);
  expect(receiveProduct).toHaveBeenCalledWith({ event: listing, product: null });
  expect(mockPrune).toHaveBeenCalledTimes(1);
});

it('cancels a queued reader without querying or caching a miss', async () => {
  const controller = new AbortController();
  const result = resolveEmbed(eventRef(id('1')), ['wss://read'], controller.signal);
  controller.abort();
  await settle(result);
  expect(mockQuery).not.toHaveBeenCalled();
  expect(peekEmbed(`e:${id('1')}`)).toBeUndefined();
});

it('keeps a shared query until its last focused reader leaves, then aborts', async () => {
  mockQuery.mockImplementation(
    (_pool, _relays, _filter, { signal }) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve([]));
      }),
  );
  const a = new AbortController();
  const b = new AbortController();
  const first = resolveEmbed(eventRef(id('1')), ['wss://read'], a.signal);
  const second = resolveEmbed(eventRef(id('1')), ['wss://read'], b.signal);
  await jest.advanceTimersByTimeAsync(60);
  const signal = mockQuery.mock.calls[0][3].signal;
  a.abort();
  expect(signal.aborted).toBe(false);
  b.abort();
  expect(signal.aborted).toBe(true);
  await settle(Promise.all([first, second]));
  expect(peekEmbed(`e:${id('1')}`)).toBeUndefined();
});

it('retries a cached miss after relay plan changes while retaining positive cache entries', async () => {
  mockQuery.mockResolvedValue([]);
  await settle(resolveEmbed(eventRef(id('3')), []));
  mockQuery.mockResolvedValue([ev({ id: id('3') })]);
  expect((await resolveEmbed(eventRef(id('3')), ['wss://read'])).event).toBeNull();
  const recovered = await settle(resolveEmbed(eventRef(id('3')), ['wss://read'], undefined, true));
  expect(recovered.event?.id).toBe(id('3'));
  const count = mockQuery.mock.calls.length;
  await settle(resolveEmbed(eventRef(id('3')), ['wss://other'], undefined, true));
  expect(mockQuery).toHaveBeenCalledTimes(count);
});

it('drops previous read relays for uncached and retried embeds when the plan becomes empty', async () => {
  mockQuery.mockResolvedValue([]);
  await settle(resolveEmbed(eventRef(id('1')), ['wss://disabled']));
  mockQuery.mockClear();

  expect(await settle(resolveEmbed(eventRef(id('2')), []))).toEqual({ event: null });
  expect(await settle(resolveEmbed(eventRef(id('1')), [], undefined, true))).toEqual({
    event: null,
  });
  expect(mockQuery).not.toHaveBeenCalled();

  await settle(resolveEmbed(eventRef(id('3'), ['wss://hint']), []));
  expect(mockQuery).toHaveBeenCalledTimes(1);
  expect(mockQuery.mock.calls[0][1]).toEqual(['wss://hint']);
});

it('routes simultaneous refs by their own relay plans, including an empty plan and hints', async () => {
  mockQuery.mockImplementation(async (_pool, relays, filter) =>
    relays.includes('wss://first') ? [ev({ id: filter.ids[0] })] : [],
  );
  const first = resolveEmbed(eventRef(id('1')), ['wss://first']);
  const second = resolveEmbed(eventRef(id('2')), ['wss://second']);
  const empty = resolveEmbed(eventRef(id('3')), []);
  const hinted = resolveEmbed(eventRef(id('4'), ['wss://hint']), []);
  const results = await settle(Promise.all([first, second, empty, hinted]));
  expect(results.map((r) => r.event?.id ?? null)).toEqual([id('1'), null, null, null]);
  expect(mockQuery.mock.calls.map((c) => [c[1], c[2].ids])).toEqual([
    [['wss://first'], [id('1')]],
    [['wss://second'], [id('2')]],
    [['wss://hint'], [id('3'), id('4')]],
  ]);
});

it('does not deduplicate the same ref across different in-flight relay plans', async () => {
  let finishFirst!: (events: Event[]) => void;
  mockQuery.mockImplementation((_pool, relays) =>
    relays.includes('wss://first')
      ? new Promise((resolve) => (finishFirst = resolve))
      : Promise.resolve([ev({ id: id('1') })]),
  );
  const first = resolveEmbed(eventRef(id('1')), ['wss://first']);
  await jest.advanceTimersByTimeAsync(60);
  const second = resolveEmbed(eventRef(id('1')), ['wss://second']);
  await jest.advanceTimersByTimeAsync(100);
  expect(mockQuery).toHaveBeenCalledTimes(2);
  expect((await second).event?.id).toBe(id('1'));
  finishFirst([]);
  await settle(first);
  expect(peekEmbed(`e:${id('1')}`)?.event?.id).toBe(id('1'));
});
