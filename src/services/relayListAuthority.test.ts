import type { Event } from 'nostr-tools';
import {
  EOSE_REASON,
  lookupOwnList,
  queryEachRelay,
  type OwnListSources,
  type PerRelayQuery,
} from './relayListAuthority';
import { pool } from './nostrPool';
import { relayAllowsKind } from './relayKindPolicy';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';

jest.mock('./relayKindPolicy', () => ({ relayAllowsKind: jest.fn(async () => true) }));
jest.mock('./nostrPool', () => ({
  pool: { subscribeEose: jest.fn() },
  trackRelays: jest.fn(),
}));

const PK = 'a'.repeat(64);
const WRITE = 'wss://my-write.example';
const INDEXERS = ['wss://purplepag.es', 'wss://user.kindpag.es'];
const DEFAULTS = ['wss://relay.damus.io', 'wss://nos.lol'];
const SOURCES: OwnListSources = { required: [WRITE], indexers: INDEXERS, bestEffort: DEFAULTS };
const ALL = [WRITE, ...INDEXERS, ...DEFAULTS];
const list = (id: string, created_at: number, over: Partial<Event> = {}) =>
  ({ id, created_at, pubkey: PK, kind: 10050, tags: [], content: '', sig: '', ...over }) as Event;
/** A fake per-relay query: which relays reached a clean EOSE, and what they returned. */
const answered =
  (eosed: string[], events: Event[] = []): PerRelayQuery =>
  async () => ({ events, eosed });
const status = async (query: PerRelayQuery, sources = SOURCES) =>
  (await lookupOwnList(PK, 10050, sources, { query })).status;

beforeEach(() => {
  jest.clearAllMocks();
  (relayAllowsKind as jest.Mock).mockImplementation(async () => true);
});

describe('lookupOwnList: absence must be authoritative', () => {
  it('is absent only when every write relay and indexer answered cleanly, with nothing', async () => {
    expect(await status(answered([WRITE, ...INDEXERS]))).toBe('absent');
    // Defaults are best-effort: their silence doesn't block it.
    expect(await status(answered([WRITE, ...INDEXERS, DEFAULTS[0]]))).toBe('absent');
  });

  it("the user's write relay timing out is unknown, even with an indexer and a default empty", async () => {
    expect(await status(answered([...INDEXERS, ...DEFAULTS]))).toBe('unknown');
  });

  it('an indexer not answering is unknown', async () => {
    expect(await status(answered([WRITE, INDEXERS[0], ...DEFAULTS]))).toBe('unknown');
  });

  it('a timeout (no relay finished) is unknown', async () => {
    expect(await status(answered([]))).toBe('unknown');
  });

  it('needs at least one indexer that stores the kind', async () => {
    // Indexers turned off in app relay settings.
    expect(await status(answered(ALL), { ...SOURCES, indexers: [] })).toBe('unknown');
    // Only an indexer that doesn't store 10050: it isn't asked and can't vouch.
    (relayAllowsKind as jest.Mock).mockImplementation(
      async (url: string) => url !== 'wss://user.kindpag.es',
    );
    const query = jest.fn(answered(ALL));
    expect(await status(query, { ...SOURCES, indexers: ['wss://user.kindpag.es'] })).toBe(
      'unknown',
    );
    expect(query.mock.calls[0][0]).not.toContain('wss://user.kindpag.es');
  });

  it('one relay alone is not enough', async () => {
    expect(
      await status(answered(['wss://purplepag.es']), {
        required: [],
        indexers: ['wss://purplepag.es'],
        bestEffort: [],
      }),
    ).toBe('unknown');
  });

  it('two spellings of one relay count once (no false two-relay quorum)', async () => {
    const query = jest.fn(answered(['wss://purplepag.es']));
    const sources = {
      required: ['wss://PURPLEPAG.ES:443/'],
      indexers: ['wss://purplepag.es'],
      bestEffort: [],
    };
    expect(await status(query, sources)).toBe('unknown');
    expect(query.mock.calls[0][0]).toEqual(['wss://purplepag.es']);
  });

  it('a failed query is unknown', async () => {
    const query: PerRelayQuery = async () => {
      throw new Error('offline');
    };
    expect(await status(query)).toBe('unknown');
  });

  it('a list on any relay (even a best-effort one) is found, whatever timed out', async () => {
    const result = await lookupOwnList(PK, 10050, SOURCES, { query: answered([], [list('x', 1)]) });
    expect(result).toEqual({ status: 'found', event: expect.objectContaining({ id: 'x' }) });
  });

  it('the newest list wins over an older copy on another relay', async () => {
    const query = answered(ALL, [list('old', 100), list('new', 300), list('mid', 200)]);
    const result = await lookupOwnList(PK, 10050, SOURCES, { query });
    expect(result.status === 'found' && result.event.id).toBe('new');
  });

  it("ignores another author's or kind's event (no false 'found')", async () => {
    const query = answered(ALL, [
      list('forged', 999, { pubkey: 'b'.repeat(64) }),
      list('wrongkind', 999, { kind: 10002 }),
    ]);
    expect(await status(query)).toBe('absent');
  });

  it('asks every source once, for one bounded event per relay', async () => {
    const query = jest.fn(answered([]));
    await lookupOwnList(
      PK,
      10050,
      {
        required: [`${WRITE}/`, 'https://x'],
        indexers: INDEXERS,
        bestEffort: [WRITE, ...DEFAULTS],
      },
      { query },
    );
    expect(query.mock.calls[0][0]).toEqual(ALL);
    expect(query.mock.calls[0][1]).toEqual({ kinds: [10050], authors: [PK], limit: 1 });
  });

  it('test accounts in lockdown only ask (and trust) the LAN test relay', async () => {
    const testPk = [...TEST_ACCOUNT_PUBKEYS][0];
    const query = jest.fn(answered([TEST_RELAY_URL]));
    expect((await lookupOwnList(testPk, 10050, SOURCES, { query })).status).toBe('absent');
    expect(query.mock.calls[0][0]).toEqual([TEST_RELAY_URL]);
    expect(relayAllowsKind).not.toHaveBeenCalled();
    expect((await lookupOwnList(testPk, 10050, SOURCES, { query: answered([]) })).status).toBe(
      'unknown',
    );
  });
});

describe('queryEachRelay', () => {
  const sub = pool.subscribeEose as jest.Mock;
  afterEach(() => jest.useRealTimers());

  it('counts only relays that sent a clean EOSE before our deadline', async () => {
    jest.useFakeTimers();
    const close = jest.fn();
    sub.mockImplementation((relays: string[], _filter, params) => {
      const [url] = relays;
      if (url === 'wss://eose') params.onclose([EOSE_REASON]);
      if (url === 'wss://error') params.onclose(['connection failure']);
      if (url === 'wss://auth') params.onclose(['auth-required: authenticate first']);
      if (url === 'wss://limited') params.onclose(['rate-limited: slow down']);
      if (url === 'wss://skipped') params.onclose([]);
      if (url === 'wss://event') {
        params.onevent(list('e', 1));
        params.onclose([EOSE_REASON]);
      }
      // 'wss://slow' never answers: nostr-tools would synthesise EOSE at maxWait.
      return { close };
    });
    const relays = ['eose', 'error', 'auth', 'limited', 'skipped', 'event', 'slow'];
    const pending = queryEachRelay(
      relays.map((r) => `wss://${r}`),
      { kinds: [10050] },
      1000,
    );
    await jest.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result.eosed.sort()).toEqual(['wss://eose', 'wss://event']);
    expect(result.events.map((e) => e.id)).toEqual(['e']);
    for (const call of sub.mock.calls) {
      // Our deadline must fire before nostr-tools' synthetic EOSE...
      expect(call[2].maxWait).toBeGreaterThan(1000);
      // ...and relay AUTH stays off: no signer prompt from a background check.
      expect(call[2].noAuth).toBe(true);
    }
  });

  it('CLOSED auth-required on the write relay makes the lookup unknown', async () => {
    sub.mockImplementation((relays: string[], _filter, params) => {
      params.onclose([relays[0] === WRITE ? 'auth-required: authenticate first' : EOSE_REASON]);
      return { close: jest.fn() };
    });
    expect((await lookupOwnList(PK, 10050, SOURCES)).status).toBe('unknown');
    sub.mockImplementation((_relays: string[], _filter, params) => {
      params.onclose([EOSE_REASON]);
      return { close: jest.fn() };
    });
    expect((await lookupOwnList(PK, 10050, SOURCES)).status).toBe('absent');
  });

  it('a late synthetic EOSE after our deadline does not count', async () => {
    jest.useFakeTimers();
    let late!: (reasons: string[]) => void;
    sub.mockImplementation((_relays, _filter, params) => {
      late = params.onclose;
      return { close: jest.fn() };
    });
    const pending = queryEachRelay(['wss://slow'], { kinds: [10050] }, 1000);
    await jest.advanceTimersByTimeAsync(1000);
    late([EOSE_REASON]);
    expect((await pending).eosed).toEqual([]);
  });
});
