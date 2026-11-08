// Marmot's peer relay-list lookups through the shared cache (#1402): the
// 10051 / 10002 discovery lists and the 10050 inbox. The pool is mocked:
// these tests never touch a real relay.
import type { Event } from 'nostr-tools';
import { TEST_RELAY_URL } from '../config/testRelayLockdown';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { fetchKeyPackageEvents } from './marmotInvitees';
import { MARMOT_KEY_PACKAGE_RELAYS } from './marmotKeyPackageRelays';
import { marmotInboxRelays, marmotPeerLists } from './marmotPeerRelayLists';
import { pool } from './nostrPool';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import {
  clearPeerRelayListCache,
  PEER_LIST_ABSENT_TTL_MS,
  PEER_LIST_FAILED_TTL_MS,
  PEER_LIST_TTL_MS,
} from './peerRelayLists';

jest.mock('./nostrPool', () => ({
  pool: { querySyncFilters: jest.fn() },
  trackRelays: jest.fn(),
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  releaseNewIdleRelays: jest.fn(),
}));
// Hydrated prefs with every app relay enabled (lockdown is applied by lockRelays).
jest.mock('./appRelayPrefs', () => ({
  enabledAppRelays: (_group: string, list: readonly string[]) => list,
}));

const query = jest.mocked(pool.querySyncFilters);
const viewer = 'f'.repeat(64);
const peer = 'a'.repeat(64);
const LOOKUP = ['wss://mine.example.com'];

const list = (kind: number, tags: string[][], createdAt = 100): Event => ({
  id: `${kind}-${createdAt}`,
  pubkey: peer,
  kind,
  created_at: createdAt,
  tags,
  content: '',
  sig: '',
});

type QueryOptions = { onClose?: (reasons: string[], urls?: string[]) => void } | undefined;
const EOSE = 'closed automatically on eose';
/** A lookup every relay asked (the indexers too) completed, returning `events`. */
const answered =
  (events: Event[]) =>
  async (relays: string[], _filters: unknown, _maxWait: number, options?: QueryOptions) => {
    options?.onClose?.(
      relays.map(() => EOSE),
      relays,
    );
    return events;
  };
/** Only the non-indexer relays answered fast; the indexers timed out. */
const indexersSlow =
  (events: Event[]) =>
  async (relays: string[], _filters: unknown, _maxWait: number, options?: QueryOptions) => {
    options?.onClose?.(
      relays.map((r) => (RELAY_LIST_INDEXERS.includes(r) ? 'relay connection timed out' : EOSE)),
      relays,
    );
    return events;
  };

const peerLists = [
  list(10051, [['relay', 'wss://key.example.com']]),
  list(10051, [['relay', 'wss://older-key.example.com']], 50),
  list(10002, [
    ['r', 'wss://write.example.com', 'write'],
    ['r', 'wss://read.example.com', 'read'],
  ]),
  list(10050, [['relay', 'wss://inbox.example.com']]),
];

beforeEach(() => {
  clearPeerRelayListCache();
  query.mockReset();
  jest.useRealTimers();
});

describe('marmotPeerLists().keyPackage', () => {
  it('reads the newest 10051 and the 10002 write relays in one bounded lookup', async () => {
    query.mockImplementation(answered(peerLists));
    const lists = await marmotPeerLists(viewer, () => LOOKUP).keyPackage(peer);
    expect(lists).toEqual({
      keyPackage: ['wss://key.example.com/'],
      write: ['wss://write.example.com/'],
    });
    expect(query).toHaveBeenCalledTimes(1);
    const [relays, filters] = query.mock.calls[0];
    expect(filters).toEqual([
      { kinds: [10050], authors: [peer], limit: 1 },
      { kinds: [10002], authors: [peer], limit: 1 },
      { kinds: [10051], authors: [peer], limit: 1 },
    ]);
    // Where 10051s live (the well-known Marmot relays) and the viewer's relays.
    expect(relays).toEqual(expect.arrayContaining([...MARMOT_KEY_PACKAGE_RELAYS, ...LOOKUP]));
  });

  it('feeds the discovery order: their 10051 → NIP-65 writes → Marmot relays → lookup', async () => {
    query.mockImplementation(answered(peerLists));
    const request = jest.fn(async (_relays: string[], _filters: unknown) => []);
    await fetchKeyPackageEvents(
      { request },
      LOOKUP,
      peer,
      marmotPeerLists(viewer, () => LOOKUP).keyPackage,
    );
    expect(request.mock.calls[0][0]).toEqual([
      'wss://key.example.com',
      'wss://write.example.com',
      ...MARMOT_KEY_PACKAGE_RELAYS,
      ...LOOKUP,
    ]);
  });

  it('caches hits: the Welcome inbox after an invite lookup needs no second REQ', async () => {
    query.mockImplementation(answered(peerLists));
    const lists = marmotPeerLists(viewer, () => LOOKUP).keyPackage;
    await lists(peer);
    await lists(peer);
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toEqual(['wss://inbox.example.com/']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches a negative result (no lists published) for the absent TTL', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    query.mockImplementation(answered([]));
    const lists = marmotPeerLists(viewer, () => LOOKUP).keyPackage;
    expect(await lists(peer)).toEqual({ keyPackage: [], write: [] });
    jest.setSystemTime(1_000_000 + PEER_LIST_ABSENT_TTL_MS - 1);
    await lists(peer);
    expect(query).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + PEER_LIST_ABSENT_TTL_MS);
    await lists(peer);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('retries an unknown result (no relay answered) after the short TTL', async () => {
    jest.useFakeTimers({ now: 2_000_000 });
    query.mockRejectedValueOnce(new Error('No relay answered'));
    const lists = marmotPeerLists(viewer, () => LOOKUP).keyPackage;
    expect(await lists(peer)).toEqual({ keyPackage: [], write: [] });
    jest.setSystemTime(2_000_000 + PEER_LIST_FAILED_TTL_MS - 1);
    await lists(peer);
    expect(query).toHaveBeenCalledTimes(1);
    jest.setSystemTime(2_000_000 + PEER_LIST_FAILED_TTL_MS);
    query.mockImplementation(answered(peerLists));
    expect((await lists(peer)).keyPackage).toEqual(['wss://key.example.com/']);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps found lists for the found TTL, then looks them up again', async () => {
    jest.useFakeTimers({ now: 3_000_000 });
    query.mockImplementation(answered(peerLists));
    const lists = marmotPeerLists(viewer, () => LOOKUP).keyPackage;
    await lists(peer);
    jest.setSystemTime(3_000_000 + PEER_LIST_TTL_MS - 1);
    await lists(peer);
    expect(query).toHaveBeenCalledTimes(1);
    jest.setSystemTime(3_000_000 + PEER_LIST_TTL_MS);
    await lists(peer);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps a test account on the LAN relay: locked lookup, LAN lists sanitised away', async () => {
    query.mockImplementation(
      answered([
        list(10051, [['relay', TEST_RELAY_URL]]),
        list(10050, [['relay', TEST_RELAY_URL]]),
      ]),
    );
    const lists = await marmotPeerLists(TEST_ACCOUNT_KEYS.little, () => LOOKUP).keyPackage(peer);
    expect(query.mock.calls[0][0]).toEqual([TEST_RELAY_URL]);
    // A peer-published ws:// URL is never a destination; the network locks reads anyway.
    expect(lists).toEqual({ keyPackage: [], write: [] });
  });
});

describe('marmotPeerLists().read', () => {
  it('returns the NIP-65 read relays from the same cached lookup as the inbox', async () => {
    query.mockImplementation(answered(peerLists));
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toEqual(['wss://inbox.example.com/']);
    expect(await marmotPeerLists(viewer, () => LOOKUP).read(peer)).toEqual([
      'wss://read.example.com/',
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('marmotInboxRelays', () => {
  it('returns the sanitised 10050, without asking for the 10051', async () => {
    query.mockImplementation(
      answered([
        list(10050, [
          ['relay', 'wss://inbox.example.com'],
          ['relay', 'ws://lan.local'],
        ]),
      ]),
    );
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toEqual(['wss://inbox.example.com/']);
    expect(query.mock.calls[0][1]).toHaveLength(2);
  });

  it('returns [] (never the defaults) when a completed lookup finds none', async () => {
    query.mockImplementation(answered([]));
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toEqual([]);
  });

  it('returns undefined — unknown, not "none" — when no relay answered or completed', async () => {
    query.mockImplementation(() => Promise.reject(new Error('No relay answered')));
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toBeUndefined();
    clearPeerRelayListCache();
    query.mockImplementation(async () => []); // no EOSE
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toBeUndefined();
  });
});

describe('a confirmed absence before a Welcome falls back (#1402)', () => {
  it('a fast non-indexer EOSE alone is not proof: unknown, so the Welcome stays unsigned', async () => {
    query.mockImplementation(indexersSlow([]));
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toBeUndefined();
  });

  it('an indexer EOSE confirms it', async () => {
    query.mockImplementation(answered([]));
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toEqual([]);
  });

  it('finding their other list in the same lookup confirms it, even with the indexers slow', async () => {
    query.mockImplementation(
      indexersSlow([list(10002, [['r', 'wss://read.example.com', 'read']])]),
    );
    expect(await marmotInboxRelays(peer, viewer, LOOKUP)).toEqual([]);
  });
});
