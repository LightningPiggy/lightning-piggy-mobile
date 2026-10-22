import { setCurrentUserPubkey } from './nostrActiveAccount';
import { forgetAppRelayPrefs, loadAppRelayPrefs, setAppRelayEnabled } from './appRelayPrefs';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { TEST_RELAY_URL } from '../config/testRelayLockdown';
import { MARKET_RELAYS } from '../utils/marketListingsQuery';
import { buildShopTemplate } from '../utils/marketSellerTestFixtures';
import {
  resolveCurrentRevision,
  SellerFetchError,
  StaleRevisionError,
} from '../utils/marketSellerRevision';
import { nostrVerifyEvent } from './nostrCrypto';
import { __resetVerifiedEventCache } from './nostrVerifyCache';
import { acquireMarketListingsPool } from './marketListingsPool';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import {
  fetchSellerEvents,
  fetchLatestRevision,
  queryQuorum,
  verifiedOwnEvents,
  loadHiddenListings,
  loadSellerCache,
  persistSellerSnapshot,
  publishSellerEvent,
  saveHiddenListings,
  sellerRelays,
} from './marketSellerService';
import {
  addSellerEvents,
  forgetSellerAccount,
  resetSellerStore,
  restoreSellerAccount,
  reviveSellerAccount,
  sellerStoreState,
  setSellerHidden,
} from './sellerEventStore';
import { querySyncAbortable } from './relayQuery';
import { publishSignedEvent } from './nostrService';
import { pool } from './nostrPool';
import {
  buildDeletionTemplate,
  buildListingTemplate,
  buildShippingZoneTemplate,
  coordinateOf,
  type EventTemplate,
} from '../utils/marketSellerEvents';

jest.mock('./nostrService', () => ({
  pool: {},
  trackRelays: jest.fn(),
  DEFAULT_RELAYS: ['wss://default.example'],
  publishSignedEvent: jest.fn((...args: unknown[]) =>
    jest.requireActual('./nostrEventPublish').publishSignedEvent(...args),
  ),
}));
jest.mock('./nostrPool', () => ({ pool: { publish: jest.fn() }, trackRelays: jest.fn() }));
jest.mock('./marketListingsPool', () => ({
  acquireMarketListingsPool: jest.fn(() => ({ pool: { structureOnly: true }, release: jest.fn() })),
}));
jest.mock('./nostrCrypto', () => {
  const actual = jest.requireActual('./nostrCrypto');
  // Exercise real signatures without starting the facade's 60-second perf timer.
  const pure = jest.requireActual('nostr-tools/pure');
  return {
    ...actual,
    nostrGetEventHash: pure.getEventHash,
    nostrVerifyEvent: jest.fn(pure.verifyEvent),
  };
});
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));

const key = new Uint8Array(32).fill(9);
const pubkey = getPublicKey(key);
const sign = (t: EventTemplate, created_at = 100): Event =>
  finalizeEvent({ ...t, created_at }, key);
const listing = (d: string, created_at = 100) =>
  sign(
    buildListingTemplate({
      draft: {
        dTag: d,
        title: `TEST ${d}`,
        description: '',
        images: [],
        price: '1',
        currency: 'GBP',
        quantity: '',
        categories: [],
        shipping: [],
      },
      pubkey,
      nowSeconds: created_at,
    }),
    created_at,
  );

beforeEach(async () => {
  __resetVerifiedEventCache();
  resetSellerStore();
  jest.clearAllMocks();
  await AsyncStorage.clear();
});

describe('sellerRelays', () => {
  it('keeps secure write relays distinct, dedupes and falls back to defaults', () => {
    const relays = Array.from({ length: 10 }, (_, i) => ({
      url: `wss://r${i}.example`,
      read: true,
      write: true,
    }));
    expect(sellerRelays(relays)).toEqual(relays.slice(0, 8).map((r) => r.url));
    expect(
      sellerRelays([
        { url: 'wss://w.example', read: false, write: true },
        { url: 'wss://w.example', read: false, write: true },
        { url: 'ws://insecure.example', read: false, write: true },
        { url: 'wss://read-only.example', read: true, write: false },
      ]),
    ).toEqual(['wss://w.example']);
    expect(sellerRelays([])).toEqual(['wss://default.example']);
  });
});

describe('fetchSellerEvents', () => {
  it('runs bounded, fail-closed queries and keeps only verified own events', async () => {
    const mine = listing('a');
    const theirs = finalizeEvent(
      { kind: 30402, created_at: 1, content: '', tags: [['d', 'x']] },
      new Uint8Array(32).fill(1),
    );
    const note = sign({ kind: 1, content: 'gm', tags: [] });
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, _relays, filter) =>
      Promise.resolve(filter.kinds[0] === 30402 ? [mine, theirs, note] : []),
    );
    await expect(fetchSellerEvents({ pubkey, relays: ['wss://r.example'] })).resolves.toEqual([
      mine,
    ]);
    const calls = (querySyncAbortable as jest.Mock).mock.calls;
    // Kind 5 is shared with other features: market deletions are their own
    // `#k`-filtered query so they can't crowd the shop or listings out.
    expect(calls.filter((c) => c[1][0] === MARKET_RELAYS[0]).map((c) => c[2])).toEqual([
      { kinds: [30405, 30406], authors: [pubkey], limit: 100 },
      { kinds: [30402], authors: [pubkey], limit: 300 },
      { kinds: [5], authors: [pubkey], '#k': ['30402', '30406', '30405'], limit: 200 },
    ]);
    for (const call of calls)
      expect(call[3]).toEqual(
        expect.objectContaining({
          maxWait: 8000,
          rejectOnAllRelaysFailure: true,
          rejectOnTimeout: true,
        }),
      );
  });

  it('fails on a relay timeout instead of returning an empty "no shop"', async () => {
    (querySyncAbortable as jest.Mock).mockRejectedValue(
      new Error('Relay query timed out before EOSE'),
    );
    await expect(fetchSellerEvents({ pubkey, relays: ['wss://r.example'] })).rejects.toThrow(
      'No seller write relay answered',
    );
  });
});

describe('seller relay quorum with supplemental marketplace reads', () => {
  const writeRelays = ['wss://write.example'];

  it.each(['snapshot', 'revision'])(
    'returns seller events for a %s when every marketplace relay times out',
    async (read) => {
      const saved = listing('saved');
      (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) =>
        MARKET_RELAYS.includes(relays[0])
          ? Promise.reject(new Error('Relay query timed out before EOSE'))
          : Promise.resolve(filter.kinds.includes(saved.kind) ? [saved] : []),
      );
      if (read === 'snapshot') {
        await expect(fetchSellerEvents({ pubkey, relays: writeRelays })).resolves.toEqual([saved]);
      } else {
        await expect(
          fetchLatestRevision({ pubkey, kind: saved.kind, dTag: 'saved', relays: writeRelays }),
        ).resolves.toMatchObject({ event: saved });
        expect((querySyncAbortable as jest.Mock).mock.calls.some((c) => c[2]['#a'])).toBe(true);
        expect((querySyncAbortable as jest.Mock).mock.calls.some((c) => c[2]['#e'])).toBe(true);
      }
    },
  );

  it.each(['snapshot', 'revision'])(
    'rejects a %s when marketplace replies cannot make up the seller quorum',
    async (read) => {
      const sellers = Array.from({ length: 3 }, (_, i) => `wss://seller${i}.example`);
      (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays) =>
        sellers.slice(1).includes(relays[0])
          ? Promise.reject(new Error('Relay query timed out before EOSE'))
          : Promise.resolve([]),
      );
      const pending =
        read === 'snapshot'
          ? fetchSellerEvents({ pubkey, relays: sellers })
          : fetchLatestRevision({ pubkey, kind: 30402, dTag: 'saved', relays: sellers });
      await expect(pending).rejects.toThrow('Only 1 of 3 relays answered');
    },
  );

  it('rejects a snapshot when only marketplace relays answer', async () => {
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays) =>
      writeRelays.includes(relays[0])
        ? Promise.reject(new Error('Relay query timed out before EOSE'))
        : Promise.resolve([]),
    );
    await expect(fetchSellerEvents({ pubkey, relays: writeRelays })).rejects.toThrow(
      'No seller write relay answered',
    );
  });

  it.each(['snapshot', 'revision'])(
    'filters disabled app defaults and marketplace relays for a %s, retaining explicit write choices',
    async (read) => {
      setCurrentUserPubkey(pubkey);
      await forgetAppRelayPrefs(pubkey);
      await loadAppRelayPrefs(pubkey);
      try {
        await setAppRelayEnabled(pubkey, 'default', 'wss://default.example', false);
        await setAppRelayEnabled(pubkey, 'market', MARKET_RELAYS[0], false);
        (querySyncAbortable as jest.Mock).mockResolvedValue([]);
        const fetch = (relays: string[]) =>
          read === 'snapshot'
            ? fetchSellerEvents({ pubkey, relays })
            : fetchLatestRevision({ pubkey, kind: 30402, dTag: 'saved', relays });
        await expect(fetch([])).rejects.toThrow('No seller write relay answered');
        let targets = (querySyncAbortable as jest.Mock).mock.calls.map((call) => call[1][0]);
        expect(targets).not.toContain('wss://default.example');
        expect(targets).not.toContain(MARKET_RELAYS[0]);
        jest.clearAllMocks();
        await fetch(['wss://default.example']);
        targets = (querySyncAbortable as jest.Mock).mock.calls.map((call) => call[1][0]);
        expect(targets).toContain('wss://default.example');
        expect(targets).not.toContain(MARKET_RELAYS[0]);
      } finally {
        setCurrentUserPubkey(null);
        await forgetAppRelayPrefs(pubkey);
      }
    },
  );

  it('uses default seller relays when none are configured', async () => {
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays) =>
      relays[0] === 'wss://default.example'
        ? Promise.resolve([])
        : Promise.reject(new Error('Relay query timed out before EOSE')),
    );
    await expect(fetchSellerEvents({ pubkey, relays: [] })).resolves.toEqual([]);
  });
});

describe('marketplace-only seller events', () => {
  const writeRelays = ['wss://write.example'];

  function serveMarketplace(events: Event[], source = MARKET_RELAYS[0]) {
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) =>
      Promise.resolve(
        relays[0] === source ? events.filter((event) => filter.kinds.includes(event.kind)) : [],
      ),
    );
  }

  it.each(MARKET_RELAYS)(
    'recovers a save accepted only by %s on a fresh device',
    async (source) => {
      const saved = listing('marketplace-only');
      (publishSignedEvent as jest.Mock).mockImplementation((...args: unknown[]) =>
        jest.requireActual('./nostrEventPublish').publishSignedEvent(...args),
      );
      (pool.publish as jest.Mock).mockImplementation((targets: string[]) =>
        targets.map((relay) =>
          relay === source ? Promise.resolve('') : Promise.reject(new Error('blocked: refused')),
        ),
      );
      await publishSellerEvent(saved, writeRelays);
      resetSellerStore();
      await expect(loadSellerCache(pubkey)).resolves.toEqual([]);
      serveMarketplace([saved], source);
      await expect(fetchSellerEvents({ pubkey, relays: writeRelays })).resolves.toEqual([saved]);
      const publishedTargets = (publishSignedEvent as jest.Mock).mock.calls[0][1];
      expect([
        ...new Set((querySyncAbortable as jest.Mock).mock.calls.map((call) => call[1][0])),
      ]).toEqual(publishedTargets);
    },
  );

  it('detects a newer revision stored only on a marketplace relay', async () => {
    const base = listing('edited', 100);
    const newer = listing('edited', 200);
    serveMarketplace([newer]);
    const fetchLatest = () =>
      fetchLatestRevision({
        pubkey,
        kind: 30402,
        dTag: 'edited',
        baseId: base.id,
        relays: writeRelays,
      });
    await expect(fetchLatest()).resolves.toMatchObject({ event: newer });
    await expect(resolveCurrentRevision({ fetchLatest, base })).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
  });

  it.each(['a', 'e'])(
    'detects marketplace-only %s deletions in snapshots and revision checks',
    async (target) => {
      const base = listing('deleted', 100);
      const deletion = sign(
        {
          kind: 5,
          content: '',
          tags: [
            [target, target === 'a' ? coordinateOf(30402, pubkey, 'deleted') : base.id],
            ['k', '30402'],
          ],
        },
        200,
      );
      (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) =>
        Promise.resolve(
          filter.kinds[0] === 5 ? (relays[0] === MARKET_RELAYS[0] ? [deletion] : []) : [base],
        ),
      );
      await expect(fetchSellerEvents({ pubkey, relays: writeRelays })).resolves.toContainEqual(
        deletion,
      );
      const fetchLatest = () =>
        fetchLatestRevision({
          pubkey,
          kind: 30402,
          dTag: 'deleted',
          baseId: base.id,
          relays: writeRelays,
        });
      await expect(fetchLatest()).resolves.toMatchObject({ event: null });
      await expect(resolveCurrentRevision({ fetchLatest, base })).rejects.toBeInstanceOf(
        StaleRevisionError,
      );
    },
  );

  it('locks snapshot and revision reads to the requested test author', async () => {
    (querySyncAbortable as jest.Mock).mockResolvedValue([]);
    await fetchSellerEvents({ pubkey: TEST_ACCOUNT_KEYS.big, relays: writeRelays });
    await fetchLatestRevision({
      pubkey: TEST_ACCOUNT_KEYS.big,
      kind: 30402,
      dTag: 'test',
      baseId: 'base',
      relays: writeRelays,
    });
    expect(querySyncAbortable).toHaveBeenCalledTimes(6);
    for (const call of (querySyncAbortable as jest.Mock).mock.calls) {
      expect(call[1]).toEqual([TEST_RELAY_URL]);
    }
  });
});

describe('displaced seller write relays', () => {
  const writeRelays = Array.from({ length: 8 }, (_, i) => `wss://write${i}.example`);
  const displacedRelays = writeRelays.slice(8 - MARKET_RELAYS.length);

  it.each(displacedRelays)('recovers a shop and its newest revision from %s', async (source) => {
    const shop = sign(
      buildShopTemplate({
        shop: { name: 'TEST displaced', description: '', currency: 'GBP' },
        pubkey,
        productCoordinates: [],
        zoneCoordinates: [],
      }),
      200,
    );
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) =>
      Promise.resolve(relays[0] === source && filter.kinds.includes(shop.kind) ? [shop] : []),
    );
    await expect(fetchSellerEvents({ pubkey, relays: writeRelays })).resolves.toEqual([shop]);
    await expect(
      fetchLatestRevision({
        pubkey,
        kind: shop.kind,
        dTag: 'lightning-piggy-shop',
        relays: writeRelays,
      }),
    ).resolves.toMatchObject({ event: shop });
    const leases = (acquireMarketListingsPool as jest.Mock).mock.calls.map((call) => call[0]);
    expect(leases).toContainEqual([...MARKET_RELAYS, ...writeRelays.slice(0, 8 - MARKET_RELAYS.length)]);
    expect(leases).toContainEqual(displacedRelays);
    for (const relays of leases) expect(relays.length).toBeLessThanOrEqual(8);
  });

  it.each(['a', 'e'])(
    'includes displaced-relay %s deletions in revision checks',
    async (target) => {
      const base = listing('deleted', 100);
      const deletion = sign(
        {
          kind: 5,
          content: '',
          tags: [[target, target === 'a' ? coordinateOf(30402, pubkey, 'deleted') : base.id]],
        },
        200,
      );
      (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) =>
        Promise.resolve(
          filter.kinds[0] !== 5
            ? [base]
            : relays[0] === displacedRelays[0] && filter[`#${target}`]
              ? [deletion]
              : [],
        ),
      );
      await expect(
        fetchLatestRevision({ pubkey, kind: 30402, dTag: 'deleted', relays: writeRelays }),
      ).resolves.toMatchObject({ event: null });
    },
  );

  it.each(['snapshot', 'revision', 'address deletion', 'id deletion'])(
    'fails closed when the displaced batch cannot complete the %s read',
    async (failedQuery) => {
      (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) => {
        const query = filter['#d'] ? 'revision' : filter['#a'] ? 'address deletion' : 'id deletion';
        return displacedRelays.includes(relays[0]) &&
          (failedQuery === 'snapshot' || query === failedQuery)
          ? Promise.reject(new Error('Relay query timed out before EOSE'))
          : Promise.resolve([]);
      });
      const pending =
        failedQuery === 'snapshot'
          ? fetchSellerEvents({ pubkey, relays: writeRelays })
          : fetchLatestRevision({
              pubkey,
              kind: 30402,
              dTag: 'cached',
              baseId: 'cached-id',
              relays: writeRelays,
            });
      await expect(pending).rejects.toThrow('No seller write relay answered');
    },
  );
});

describe('queryQuorum', () => {
  const filter = { kinds: [30405], authors: ['a'.repeat(64)], limit: 5 };
  it('counts an answer only when at least half the relays complete', async () => {
    const shop = listing('s');
    (querySyncAbortable as jest.Mock)
      .mockResolvedValueOnce([shop])
      .mockRejectedValueOnce(new Error('Relay query timed out before EOSE'))
      .mockResolvedValueOnce([]);
    await expect(queryQuorum(['wss://a', 'wss://b', 'wss://c'], filter)).resolves.toEqual([shop]);
    // One relay per query, each failing closed on its own timeout.
    expect((querySyncAbortable as jest.Mock).mock.calls.map((c) => c[1])).toEqual([
      ['wss://a'],
      ['wss://b'],
      ['wss://c'],
    ]);
  });
  it('is "unknown" (rejects) when most relays time out, even if one says empty', async () => {
    (querySyncAbortable as jest.Mock)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('timed out'))
      .mockRejectedValueOnce(new Error('timed out'));
    await expect(queryQuorum(['wss://a', 'wss://b', 'wss://c'], filter)).rejects.toThrow(
      'Only 1 of 3',
    );
  });
});

describe('verifiedOwnEvents', () => {
  it('drops a forged "own" event (bad signature) and other authors', async () => {
    const real = listing('a', 100);
    const forged = { ...listing('a', 200), content: 'PAY ME ELSEWHERE' };
    const foreign = finalizeEvent(
      { kind: 30402, created_at: 300, content: '', tags: [['d', 'a']] },
      new Uint8Array(32).fill(1),
    );
    await expect(verifiedOwnEvents([real, forged, foreign], pubkey, [30402])).resolves.toEqual([
      real,
    ]);
  });
});

describe('verifiedOwnEvents dedupe', () => {
  it('a forged copy reusing a real id first does not hide the genuine copy', async () => {
    const real = listing('a', 100);
    const forgedSameId = { ...real, content: 'tampered' };
    await expect(verifiedOwnEvents([forgedSameId, real], pubkey, [30402])).resolves.toEqual([real]);
  });
});

describe('fetchLatestRevision', () => {
  it.each(['revision', 'address deletion', 'id deletion'])(
    'rejects empty marketplace replies when the write relay fails the %s query',
    async (failedQuery) => {
      const base = listing('cached', 100);
      const writeRelays = sellerRelays([{ url: 'wss://write.example', read: true, write: true }]);
      (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays, filter) => {
        const query = filter['#d'] ? 'revision' : filter['#a'] ? 'address deletion' : 'id deletion';
        return relays[0] === writeRelays[0] && query === failedQuery
          ? Promise.reject(new Error('Relay query timed out before EOSE'))
          : Promise.resolve([]);
      });
      const fetchLatest = () =>
        fetchLatestRevision({
          pubkey,
          kind: 30402,
          dTag: 'cached',
          baseId: base.id,
          relays: writeRelays,
        });
      await expect(fetchLatest()).rejects.toThrow('No seller write relay answered');
      await expect(resolveCurrentRevision({ fetchLatest, base })).rejects.toBeInstanceOf(
        SellerFetchError,
      );
    },
  );

  it('accepts one successful write relay alongside marketplace replies', async () => {
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, relays) =>
      relays[0] === 'wss://failed.example'
        ? Promise.reject(new Error('Relay query timed out before EOSE'))
        : Promise.resolve([]),
    );
    await expect(
      fetchLatestRevision({
        pubkey,
        kind: 30402,
        dTag: 'new',
        relays: ['wss://failed.example', 'wss://write.example'],
      }),
    ).resolves.toMatchObject({ event: null });
  });

  it('returns the newest verified revision of exactly that coordinate, failing closed', async () => {
    const v1 = listing('a', 100);
    const v2 = listing('a', 200);
    const forged = { ...listing('a', 300), sig: 'f'.repeat(128) };
    const other = listing('b', 400);
    (querySyncAbortable as jest.Mock).mockResolvedValue([v1, forged, v2, other]);
    await expect(
      fetchLatestRevision({ pubkey, kind: 30402, dTag: 'a', relays: ['wss://r.example'] }),
    ).resolves.toMatchObject({ event: v2 });
    expect((querySyncAbortable as jest.Mock).mock.calls[0][2]).toEqual({
      kinds: [30402],
      authors: [pubkey],
      '#d': ['a'],
      limit: 5,
    });
    expect((querySyncAbortable as jest.Mock).mock.calls[0][3]).toEqual(
      expect.objectContaining({ rejectOnTimeout: true }),
    );
  });

  it('ignores revisions deleted by NIP-09 (a deleted shop is not an existing shop)', async () => {
    const shop = sign(
      buildShopTemplate({
        shop: { name: 'TEST', description: '', currency: 'GBP' },
        pubkey,
        productCoordinates: [],
        zoneCoordinates: [],
      }),
      100,
    );
    const deletion = sign(
      buildDeletionTemplate([
        { kind: 30405, coordinate: coordinateOf(30405, pubkey, 'lightning-piggy-shop') },
      ]),
      150,
    );
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, _relays, filter) =>
      Promise.resolve(filter.kinds[0] === 5 ? [deletion] : [shop]),
    );
    await expect(
      fetchLatestRevision({
        pubkey,
        kind: 30405,
        dTag: 'lightning-piggy-shop',
        relays: ['wss://r'],
      }),
    ).resolves.toMatchObject({ event: null });
  });

  it('is null only when relays completed with nothing', async () => {
    (querySyncAbortable as jest.Mock).mockResolvedValue([]);
    await expect(
      fetchLatestRevision({
        pubkey,
        kind: 30405,
        dTag: 'lightning-piggy-shop',
        relays: ['wss://r'],
      }),
    ).resolves.toMatchObject({ event: null });
  });
});

describe('publishSellerEvent', () => {
  it.each(['listing', 'deletion'])('rejects an unreachable %s publication', async (kind) => {
    (publishSignedEvent as jest.Mock).mockImplementation((...args: unknown[]) =>
      jest.requireActual('./nostrEventPublish').publishSignedEvent(...args),
    );
    (pool.publish as jest.Mock).mockReturnValue([
      Promise.resolve('connection failure: offline'),
      Promise.reject(new Error('blocked: refused')),
    ]);
    const event = kind === 'listing' ? listing('a') : sign(buildDeletionTemplate([]));
    await expect(publishSellerEvent(event, ['wss://a', 'wss://b'])).rejects.toThrow();
  });

  it('waits for an actual acknowledgement after a fast connection failure', async () => {
    (publishSignedEvent as jest.Mock).mockImplementation((...args: unknown[]) =>
      jest.requireActual('./nostrEventPublish').publishSignedEvent(...args),
    );
    let accept!: (message: string) => void;
    (pool.publish as jest.Mock).mockReturnValue([
      Promise.resolve('connection failure: offline'),
      new Promise<string>((resolve) => (accept = resolve)),
    ]);
    let published = false;
    const pending = publishSellerEvent(listing('a'), ['wss://a', 'wss://b']).then(() => {
      published = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(published).toBe(false);
    accept(''); // An empty OK message is a valid positive acknowledgement.
    await pending;
    expect(published).toBe(true);
  });

  it.each([30402, 30406, 30405, 5])(
    'publishes kind %i to all marketplace relays and deduplicated write relays',
    async (kind) => {
      (publishSignedEvent as jest.Mock).mockResolvedValue(undefined);
      const event = sign({ kind, content: '', tags: [['d', 'test']] });
      await publishSellerEvent(event, ['wss://write.example', ...MARKET_RELAYS]);
      expect(publishSignedEvent).toHaveBeenCalledWith(event, [
        ...MARKET_RELAYS,
        'wss://write.example',
      ]);
    },
  );

  it('locks publication by the signed author to the test relay', async () => {
    (publishSignedEvent as jest.Mock).mockResolvedValue(undefined);
    const event = { ...listing('a'), pubkey: TEST_ACCOUNT_KEYS.big };
    await publishSellerEvent(event, ['wss://write.example', ...MARKET_RELAYS]);
    expect(publishSignedEvent).toHaveBeenCalledWith(event, [TEST_RELAY_URL]);
  });

  it('publishes to at most eight relays', async () => {
    (publishSignedEvent as jest.Mock).mockResolvedValue(undefined);
    const relays = Array.from({ length: 12 }, (_, i) => `wss://r${i}.example`);
    await publishSellerEvent(listing('a'), relays);
    const targets = (publishSignedEvent as jest.Mock).mock.calls[0][1];
    expect(targets).toHaveLength(8);
    expect(targets.slice(0, MARKET_RELAYS.length)).toEqual(MARKET_RELAYS);
  });
  it('rejects when no relay accepts in time', async () => {
    jest.useFakeTimers();
    (publishSignedEvent as jest.Mock).mockReturnValue(new Promise(() => {}));
    const pending = publishSellerEvent(listing('a'), ['wss://r.example']);
    jest.advanceTimersByTime(12_000);
    await expect(pending).rejects.toThrow('timed out');
    jest.useRealTimers();
  });
});

describe('hidden listings and the persisted snapshot', () => {
  it('round-trips the hidden set and ignores corrupt storage', async () => {
    const hidden = new Map([[coordinateOf(30402, pubkey, 'a'), 5]]);
    await saveHiddenListings(pubkey, hidden);
    await expect(loadHiddenListings(pubkey)).resolves.toEqual(hidden);
    await AsyncStorage.setItem(`market-seller-hidden:${pubkey}`, '{nope');
    await expect(loadHiddenListings(pubkey)).resolves.toEqual(new Map());
  });

  it('persists only the winning revisions plus deletions, and restores them', async () => {
    const zone = sign(
      buildShippingZoneTemplate({
        dTag: 'z',
        name: 'UK',
        countries: ['GB'],
        cost: '3',
        currency: 'GBP',
      }),
    );
    const shop = sign(
      buildShopTemplate({
        shop: { name: 'TEST shop', description: '', currency: 'GBP' },
        pubkey,
        productCoordinates: [],
        zoneCoordinates: [coordinateOf(30406, pubkey, 'z')],
      }),
    );
    const v1 = listing('a', 100);
    const v2 = listing('a', 200);
    const gone = listing('b', 100);
    const deletion = sign(
      buildDeletionTemplate([{ kind: 30402, coordinate: coordinateOf(30402, pubkey, 'b') }]),
      150,
    );
    addSellerEvents(pubkey, [zone, shop, v1, v2, gone, deletion]);
    await persistSellerSnapshot(pubkey);

    const cached = await loadSellerCache(pubkey);
    expect(cached.map((e) => e.id).sort()).toEqual([zone.id, shop.id, v2.id, deletion.id].sort());

    __resetVerifiedEventCache();
    resetSellerStore();
    restoreSellerAccount(pubkey, cached, new Map([[coordinateOf(30402, pubkey, 'c'), 9]]));
    const state = sellerStoreState(pubkey);
    expect(state.events.size).toBe(4);
    expect(state.hidden.get(coordinateOf(30402, pubkey, 'c'))).toBe(9);
    // A second restore in the same session is a no-op.
    restoreSellerAccount(pubkey, [v1], new Map());
    expect(sellerStoreState(pubkey).events.has(v1.id)).toBe(false);
  });

  it("rejects cached rows that aren't this account's events", async () => {
    await AsyncStorage.setItem(
      `market-seller-events:${pubkey}`,
      JSON.stringify([{ id: 'x' }, { ...listing('a'), pubkey: 'f'.repeat(64) }, listing('ok')]),
    );
    const cached = await loadSellerCache(pubkey);
    expect(cached.map((e) => e.tags[0][1])).toEqual(['ok']);
  });
});

describe('sellerEventStore', () => {
  it('only accepts the account’s own events, and forgets an account on sign-out', () => {
    const foreign = finalizeEvent(
      { kind: 30402, created_at: 1, content: '', tags: [['d', 'x']] },
      new Uint8Array(32).fill(2),
    );
    addSellerEvents(pubkey, [listing('a'), foreign], true);
    expect(sellerStoreState(pubkey).events.size).toBe(1);
    expect(sellerStoreState(pubkey).fetchedAt).toBeGreaterThan(0);
    setSellerHidden(pubkey, new Map([['c', 1]]));
    expect(sellerStoreState(pubkey).hidden.get('c')).toBe(1);
    forgetSellerAccount(pubkey);
    expect(sellerStoreState(pubkey).events.size).toBe(0);
  });

  it('ignores late writes for a signed-out account until it is active again', () => {
    forgetSellerAccount(pubkey);
    addSellerEvents(pubkey, [listing('late')]);
    expect(sellerStoreState(pubkey).events.size).toBe(0);
    reviveSellerAccount(pubkey);
    addSellerEvents(pubkey, [listing('back')]);
    expect(sellerStoreState(pubkey).events.size).toBe(1);
  });

  it('compacts superseded revisions past the cap instead of refusing new events', () => {
    const revisions = Array.from({ length: 1100 }, (_, i) => listing('same', i + 1));
    addSellerEvents(pubkey, revisions);
    const fresh = listing('new', 5000);
    addSellerEvents(pubkey, [fresh]);
    const events = sellerStoreState(pubkey).events;
    expect(events.has(fresh.id)).toBe(true);
    expect(events.has(revisions[1099].id)).toBe(true);
    expect(events.size).toBeLessThan(1000);
  });
});

it.each(['a', 'e'])(
  'rejects saving a stale listing deleted by %s through the real revision lookup',
  async (target) => {
    const base = listing('deleted', 100);
    const deletion = sign(
      {
        kind: 5,
        content: '',
        tags: [[target, target === 'a' ? coordinateOf(30402, pubkey, 'deleted') : base.id]],
      },
      200,
    );
    (querySyncAbortable as jest.Mock).mockImplementation((_pool, _relays, filter) =>
      Promise.resolve(filter.kinds[0] === 5 ? [deletion] : [base]),
    );
    const fetchLatest = () =>
      fetchLatestRevision({
        pubkey,
        kind: 30402,
        dTag: 'deleted',
        baseId: base.id,
        relays: ['wss://r'],
      });
    await expect(resolveCurrentRevision({ fetchLatest, base })).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
    await expect(resolveCurrentRevision({ fetchLatest, base, force: true })).resolves.toBeNull();
  },
);

test('seller snapshots use the structure-only pool and cache one signature pass across refreshes', async () => {
  const rows: Event[] = JSON.parse(
    JSON.stringify([listing('paced-a'), listing('paced-b'), listing('paced-c')]),
  );
  (querySyncAbortable as jest.Mock)
    .mockReset()
    .mockImplementation((_pool, _relays, filter) =>
      Promise.resolve(filter.kinds[0] === 30402 ? JSON.parse(JSON.stringify(rows)) : []),
    );
  const request = { pubkey, relays: ['wss://r.example'] };
  await expect(fetchSellerEvents(request)).resolves.toEqual(rows);
  expect(nostrVerifyEvent).toHaveBeenCalledTimes(3);
  for (const [pool] of (querySyncAbortable as jest.Mock).mock.calls) {
    expect(pool).toEqual({ structureOnly: true });
  }
  await expect(fetchSellerEvents(request)).resolves.toEqual(rows);
  expect(nostrVerifyEvent).toHaveBeenCalledTimes(3);
  const leases = (acquireMarketListingsPool as jest.Mock).mock.results;
  expect(leases).toHaveLength(6);
  for (const lease of leases) expect(lease.value.release).toHaveBeenCalledTimes(1);
});
