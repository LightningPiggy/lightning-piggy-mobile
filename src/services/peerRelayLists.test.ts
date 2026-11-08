import type { Event } from 'nostr-tools';
import { TEST_RELAY_URL } from '../config/testRelayLockdown';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { pool, releaseNewIdleRelays } from './nostrPool';
import {
  clearPeerRelayListCache,
  getManyPeerRelayLists,
  getPeerRelayLists,
  MAX_AUTHORS_PER_LOOKUP,
  MAX_CACHED_PEERS,
  MAX_LOOKUP_RELAYS,
  peekPeerRelayLists,
  peerLookupRelays,
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
const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);

const listEvent = (
  pubkey: string,
  kind: 10050 | 10002,
  tags: string[][],
  createdAt = 100,
  id = `${kind}-${createdAt}`,
): Event => ({ id, pubkey, kind, created_at: createdAt, tags, content: '', sig: '' });

beforeEach(() => {
  clearPeerRelayListCache();
  query.mockReset();
  jest.useRealTimers();
});

it('looks up both kinds with one bounded REQ per relay (limit 1 per kind for one pubkey)', async () => {
  query.mockResolvedValue([
    listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']]),
    listEvent(alice, 10002, [
      ['r', 'wss://both.example.com'],
      ['r', 'wss://read.example.com', 'read'],
      ['r', 'wss://write.example.com', 'write'],
    ]),
  ]);
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result).toEqual({
    status: 'ok',
    lists: {
      inbox: ['wss://inbox.example.com/'],
      read: ['wss://both.example.com/', 'wss://read.example.com/'],
      write: ['wss://both.example.com/', 'wss://write.example.com/'],
    },
  });
  expect(query).toHaveBeenCalledTimes(1);
  const [relays, filters, maxWait, options] = query.mock.calls[0];
  expect(filters).toEqual([
    { kinds: [10050], authors: [alice], limit: 1 },
    { kinds: [10002], authors: [alice], limit: 1 },
  ]);
  expect(maxWait).toBeGreaterThan(0);
  expect(options).toEqual({ requireAnswer: true });
  expect(relays).toEqual(expect.arrayContaining(RELAY_LIST_INDEXERS));
  expect(releaseNewIdleRelays).toHaveBeenCalledWith(relays, expect.any(Set));
});

it('keeps the newest list across relays and ignores other authors', async () => {
  query.mockResolvedValue([
    listEvent(alice, 10050, [['relay', 'wss://old.example.com']], 100),
    listEvent(alice, 10050, [['relay', 'wss://new.example.com']], 200),
    listEvent(bob, 10050, [['relay', 'wss://bob.example.com']], 300),
  ]);
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result.status === 'ok' && result.lists.inbox).toEqual(['wss://new.example.com/']);
});

it('sanitises and caps hostile peer-supplied relay URLs before caching them', async () => {
  query.mockResolvedValue([
    listEvent(alice, 10050, [
      ['relay', 'wss://127.0.0.1'],
      ['relay', 'ws://plain.example.com'],
      ['relay', 'wss://192.168.1.1'],
      ['relay', 'wss://printer.local'],
      ...Array.from({ length: 20 }, (_, i) => ['relay', `wss://r${i}.example.com`]),
    ]),
  ]);
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result.status === 'ok' && result.lists.inbox).toEqual([
    'wss://r0.example.com/',
    'wss://r1.example.com/',
    'wss://r2.example.com/',
    'wss://r3.example.com/',
  ]);
});

it('tells "nothing published" apart from "lookup failed"', async () => {
  query.mockResolvedValueOnce([]);
  expect(await getPeerRelayLists(alice, { viewerPubkey: viewer })).toEqual({
    status: 'ok',
    lists: { inbox: null, read: null, write: null },
  });
  query.mockRejectedValueOnce(new Error('No relay answered: connection failed'));
  expect(await getPeerRelayLists(bob, { viewerPubkey: viewer })).toEqual({
    status: 'failed',
    error: 'No relay answered: connection failed',
  });
});

it('caches found lists for 10 min, absent for 2 min, failures for 30 s', async () => {
  jest.useFakeTimers({ now: 1_000_000 });
  const carol = 'c'.repeat(64);
  query.mockImplementation(async (_relays, filters) => {
    const authors = filters[0].authors ?? [];
    if (authors.includes(carol)) throw new Error('No relay answered');
    return authors.includes(alice)
      ? [listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]
      : [];
  });
  for (const pk of [alice, bob, carol]) await getPeerRelayLists(pk, { viewerPubkey: viewer });
  expect(query).toHaveBeenCalledTimes(3);

  const lookedUp = () => query.mock.calls.flatMap(([, filters]) => filters[0].authors ?? []);
  const lookupAgain = async () => {
    query.mockClear();
    await getManyPeerRelayLists([alice, bob, carol], { viewerPubkey: viewer });
    return lookedUp();
  };

  jest.setSystemTime(1_000_000 + PEER_LIST_FAILED_TTL_MS - 1);
  expect(await lookupAgain()).toEqual([]);
  jest.setSystemTime(1_000_000 + PEER_LIST_FAILED_TTL_MS);
  expect(await lookupAgain()).toEqual([carol]);

  jest.setSystemTime(1_000_000 + PEER_LIST_ABSENT_TTL_MS);
  expect((await lookupAgain()).sort()).toEqual([bob, carol]);

  jest.setSystemTime(1_000_000 + PEER_LIST_TTL_MS - 1);
  expect(await lookupAgain()).not.toContain(alice);
  jest.setSystemTime(1_000_000 + PEER_LIST_TTL_MS + PEER_LIST_ABSENT_TTL_MS);
  expect(await lookupAgain()).toContain(alice);
});

it('shares one in-flight lookup per pubkey (single-flight)', async () => {
  let resolve!: (events: Event[]) => void;
  query.mockReturnValue(new Promise((r) => (resolve = r)));
  const first = getPeerRelayLists(alice, { viewerPubkey: viewer });
  const second = getPeerRelayLists(alice, { viewerPubkey: viewer });
  const many = getManyPeerRelayLists([alice, alice.toUpperCase()], { viewerPubkey: viewer });
  expect(query).toHaveBeenCalledTimes(1);
  resolve([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]);
  const [a, b, m] = await Promise.all([first, second, many]);
  expect(a).toEqual(b);
  expect(m.get(alice)).toEqual(a);
  expect(m.size).toBe(1);
});

it('serves a fresh entry synchronously via peek, and nothing before a lookup', async () => {
  expect(peekPeerRelayLists(alice, viewer)).toBeUndefined();
  query.mockResolvedValue([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]);
  await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(peekPeerRelayLists(alice, viewer)?.status).toBe('ok');
});

it(`evicts the least recently used entry beyond ${MAX_CACHED_PEERS} peers`, async () => {
  query.mockResolvedValue([]);
  const peers = Array.from({ length: MAX_CACHED_PEERS + 1 }, (_, i) =>
    i.toString(16).padStart(64, '0'),
  );
  await getManyPeerRelayLists(peers.slice(0, MAX_CACHED_PEERS), { viewerPubkey: viewer });
  // Touch the oldest so the second-oldest becomes least recently used.
  expect(peekPeerRelayLists(peers[0], viewer)).toBeDefined();
  await getPeerRelayLists(peers[MAX_CACHED_PEERS], { viewerPubkey: viewer });
  expect(peekPeerRelayLists(peers[0], viewer)).toBeDefined();
  expect(peekPeerRelayLists(peers[1], viewer)).toBeUndefined();
  expect(peekPeerRelayLists(peers[MAX_CACHED_PEERS], viewer)).toBeDefined();
});

it(`splits big batches into REQs of at most ${MAX_AUTHORS_PER_LOOKUP} authors`, async () => {
  query.mockResolvedValue([]);
  const peers = Array.from({ length: MAX_AUTHORS_PER_LOOKUP + 5 }, (_, i) =>
    (i + 1).toString(16).padStart(64, '0'),
  );
  const results = await getManyPeerRelayLists(peers, { viewerPubkey: viewer });
  expect(results.size).toBe(peers.length);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0][1][0]).toEqual({
    kinds: [10050],
    authors: peers.slice(0, MAX_AUTHORS_PER_LOOKUP),
    limit: MAX_AUTHORS_PER_LOOKUP,
  });
});

it('rejects invalid pubkeys without a lookup', async () => {
  expect(await getPeerRelayLists('not-a-pubkey', { viewerPubkey: viewer })).toEqual({
    status: 'failed',
    error: 'invalid pubkey',
  });
  expect(query).not.toHaveBeenCalled();
});

it('asks indexers, the viewer read relays and defaults — bounded and deduped', () => {
  const relays = peerLookupRelays(viewer, [
    'wss://mine.example.com',
    'wss://purplepag.es/',
    'not a url',
  ]);
  expect(relays.slice(0, RELAY_LIST_INDEXERS.length)).toEqual(RELAY_LIST_INDEXERS);
  expect(relays).toContain('wss://mine.example.com');
  expect(relays).not.toContain('not a url');
  expect(relays.filter((r) => r.includes('purplepag.es'))).toHaveLength(1);
  expect(relays.length).toBeLessThanOrEqual(MAX_LOOKUP_RELAYS);
});

it('keeps a test account lookup on the test relay, cached apart from public lookups', async () => {
  query.mockResolvedValue([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]);
  await getPeerRelayLists(alice, {
    viewerPubkey: TEST_ACCOUNT_KEYS.little,
    lookupRelays: ['wss://mine.example.com'],
  });
  expect(query.mock.calls[0][0]).toEqual([TEST_RELAY_URL]);
  // A public viewer doesn't get the locked lookup's entry.
  expect(peekPeerRelayLists(alice, viewer)).toBeUndefined();
  expect(peekPeerRelayLists(alice, TEST_ACCOUNT_KEYS.little)).toBeDefined();
});
