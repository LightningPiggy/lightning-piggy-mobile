import type { Event } from 'nostr-tools';
import { TEST_RELAY_URL } from '../config/testRelayLockdown';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { setCurrentUserPubkey } from './nostrActiveAccount';
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

type QueryOptions = { onClose?: (reasons: string[]) => void } | undefined;
/** A lookup a relay completed (EOSE), returning `events`. */
const answered =
  (events: Event[]) =>
  async (_relays: string[], _filters: unknown, _maxWait: number, options?: QueryOptions) => {
    options?.onClose?.(['closed automatically on eose', 'relay connection closed']);
    return events;
  };

afterEach(() => setCurrentUserPubkey(null));

beforeEach(() => {
  clearPeerRelayListCache();
  query.mockReset();
  jest.useRealTimers();
});

it('looks up both kinds with one bounded REQ per relay (limit 1 per kind for one pubkey)', async () => {
  query.mockImplementation(
    answered([
      listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']]),
      listEvent(alice, 10002, [
        ['r', 'wss://both.example.com'],
        ['r', 'wss://read.example.com', 'read'],
        ['r', 'wss://write.example.com', 'write'],
      ]),
    ]),
  );
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
  expect(options).toEqual(expect.objectContaining({ requireAnswer: true }));
  expect(relays).toEqual(expect.arrayContaining(RELAY_LIST_INDEXERS));
  expect(releaseNewIdleRelays).toHaveBeenCalledWith(relays, expect.any(Set));
});

it('keeps the newest list across relays and ignores other authors', async () => {
  query.mockImplementation(
    answered([
      listEvent(alice, 10050, [['relay', 'wss://old.example.com']], 100),
      listEvent(alice, 10050, [['relay', 'wss://new.example.com']], 200),
      listEvent(bob, 10050, [['relay', 'wss://bob.example.com']], 300),
    ]),
  );
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result.status === 'ok' && result.lists.inbox).toEqual(['wss://new.example.com/']);
});

it('sanitises and caps hostile peer-supplied relay URLs before caching them', async () => {
  query.mockImplementation(
    answered([
      listEvent(alice, 10050, [
        ['relay', 'wss://127.0.0.1'],
        ['relay', 'ws://plain.example.com'],
        ['relay', 'wss://192.168.1.1'],
        ['relay', 'wss://printer.local'],
        ...Array.from({ length: 20 }, (_, i) => ['relay', `wss://r${i}.example.com`]),
      ]),
    ]),
  );
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result.status === 'ok' && result.lists.inbox).toEqual([
    'wss://r0.example.com/',
    'wss://r1.example.com/',
    'wss://r2.example.com/',
    'wss://r3.example.com/',
  ]);
});

it('tells "nothing published" apart from "lookup failed"', async () => {
  query.mockImplementationOnce(answered([]));
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
  query.mockImplementation(async (_relays, filters, _maxWait, options) => {
    const authors = filters[0].authors ?? [];
    if (authors.includes(carol)) throw new Error('No relay answered');
    options?.onClose?.(['closed automatically on eose']);
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
  query.mockImplementation(
    answered([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(peekPeerRelayLists(alice, viewer)?.status).toBe('ok');
});

it(`evicts the least recently used entry beyond ${MAX_CACHED_PEERS} peers`, async () => {
  query.mockImplementation(answered([]));
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
  query.mockImplementation(answered([]));
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
  query.mockImplementation(
    answered([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  await getPeerRelayLists(alice, {
    viewerPubkey: TEST_ACCOUNT_KEYS.little,
    lookupRelays: ['wss://mine.example.com'],
  });
  expect(query.mock.calls[0][0]).toEqual([TEST_RELAY_URL]);
  // A public viewer doesn't get the locked lookup's entry.
  expect(peekPeerRelayLists(alice, viewer)).toBeUndefined();
  expect(peekPeerRelayLists(alice, TEST_ACCOUNT_KEYS.little)).toBeDefined();
});

it('fetches a pubkey repeated in one call only once', async () => {
  query.mockImplementation(answered([]));
  const results = await getManyPeerRelayLists([alice, alice, alice.toUpperCase(), ` ${alice} `], {
    viewerPubkey: viewer,
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1][0].authors).toEqual([alice]);
  expect([...results.keys()]).toEqual([alice]);
});

it("doesn't cache a lookup redirected because a test account became active mid-lookup", async () => {
  setCurrentUserPubkey(viewer);
  query.mockImplementationOnce(async (_relays, _filters, _maxWait, options) => {
    // The pool routes reads by the active account: this answer came from the test relay.
    setCurrentUserPubkey(TEST_ACCOUNT_KEYS.little);
    options?.onClose?.(['closed automatically on eose']);
    return [];
  });
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result.status).toBe('ok');
  expect(peekPeerRelayLists(alice, viewer)).toBeUndefined();

  // Also when a test account was already active as the lookup started.
  query.mockImplementationOnce(answered([]));
  await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(peekPeerRelayLists(alice, viewer)).toBeUndefined();

  // Back on the viewer's own account, the answer is cached again.
  setCurrentUserPubkey(viewer);
  query.mockImplementationOnce(answered([]));
  await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(peekPeerRelayLists(alice, viewer)).toBeDefined();
});

/** A lookup that returned `events` but where no relay reached EOSE (connections dropped). */
const incomplete =
  (events: Event[]) =>
  async (_relays: string[], _filters: unknown, _maxWait: number, options?: QueryOptions) => {
    options?.onClose?.(['relay connection closed', 'relay connection timed out']);
    return events;
  };

it('does not cache peers missing from an incomplete lookup as absent', async () => {
  query.mockImplementationOnce(
    incomplete([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  const results = await getManyPeerRelayLists([alice, bob], { viewerPubkey: viewer });
  // Bob's answer may simply not have arrived: unknown, not "nothing published".
  expect(results.get(bob)).toEqual({ status: 'failed', error: 'no relay completed the lookup' });
  expect(peekPeerRelayLists(bob, viewer)?.status).toBe('failed');

  // So he's asked again after the short unknown TTL, not after the absent one.
  jest.useFakeTimers({ now: Date.now() + PEER_LIST_FAILED_TTL_MS });
  query.mockImplementationOnce(answered([listEvent(bob, 10050, [['relay', 'wss://bob.example.com']])])); // prettier-ignore
  const again = await getPeerRelayLists(bob, { viewerPubkey: viewer });
  expect(again.status === 'ok' && again.lists.inbox).toEqual(['wss://bob.example.com/']);
});

it("marks a found pubkey's missing kind unknown (not absent) when the lookup was incomplete", async () => {
  jest.useFakeTimers({ now: 5_000_000 });
  query.mockImplementationOnce(
    incomplete([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  const first = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(first).toEqual({
    status: 'ok',
    lists: { inbox: ['wss://inbox.example.com/'], read: undefined, write: undefined },
  });

  // The unknown kind is re-checked soon; the found inbox stays cached as found.
  jest.setSystemTime(5_000_000 + PEER_LIST_FAILED_TTL_MS);
  query.mockImplementationOnce(incomplete([]));
  const second = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(query).toHaveBeenCalledTimes(2);
  expect(second).toEqual(first);

  // A completed lookup can then confirm the 10002 is absent.
  jest.setSystemTime(5_000_000 + 2 * PEER_LIST_FAILED_TTL_MS);
  query.mockImplementationOnce(answered([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])])); // prettier-ignore
  const third = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(third.status === 'ok' && third.lists.read).toBeNull();
});

it('serves a still-fresh kind while the expired other kind is re-looked up', async () => {
  jest.useFakeTimers({ now: 7_000_000 });
  query.mockImplementationOnce(
    incomplete([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  await getPeerRelayLists(alice, { viewerPubkey: viewer });

  // The unknown 10002 expires; a retry starts and hangs.
  jest.setSystemTime(7_000_000 + PEER_LIST_FAILED_TTL_MS);
  query.mockReturnValueOnce(new Promise(() => {}));
  void getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(query).toHaveBeenCalledTimes(2);

  // The inbox is still within its own TTL, so it's still served.
  expect(peekPeerRelayLists(alice, viewer)).toEqual({
    status: 'ok',
    lists: { inbox: ['wss://inbox.example.com/'], read: undefined, write: undefined },
  });
  // Once it expires too, nothing is fresh.
  jest.setSystemTime(7_000_000 + PEER_LIST_TTL_MS);
  expect(peekPeerRelayLists(alice, viewer)).toBeUndefined();
});

it('never downgrades a fresh find to absent, and keeps the newest list', async () => {
  jest.useFakeTimers({ now: 9_000_000 });
  const inbox = (url: string, createdAt: number, id: string) =>
    listEvent(alice, 10050, [['relay', url]], createdAt, id);
  const inboxOf = async () => {
    const r = await getPeerRelayLists(alice, { viewerPubkey: viewer });
    return r.status === 'ok' ? r.lists.inbox : r.status;
  };
  // A partial lookup finds the current inbox; the 10002 stays unknown.
  query.mockImplementationOnce(incomplete([inbox('wss://current.example.com', 200, 'b')]));
  expect(await inboxOf()).toEqual(['wss://current.example.com/']);

  // Retry: a relay without that event completes (EOSE) while the original is down.
  jest.setSystemTime(9_000_000 + PEER_LIST_FAILED_TTL_MS);
  query.mockImplementationOnce(answered([]));
  expect(await inboxOf()).toEqual(['wss://current.example.com/']);

  // Retries (partial lookups, so the 10002 stays unknown and is re-asked every 30 s):
  // an OLDER event doesn't replace the newer cached list...
  const step = 9_000_000 + PEER_LIST_FAILED_TTL_MS + PEER_LIST_ABSENT_TTL_MS;
  jest.setSystemTime(step);
  query.mockImplementationOnce(incomplete([inbox('wss://stale.example.com', 100, 'a')]));
  expect(await inboxOf()).toEqual(['wss://current.example.com/']);

  // ...nor does a same-second event with a higher id (NIP-01 tie-break)...
  jest.setSystemTime(step + PEER_LIST_FAILED_TTL_MS);
  query.mockImplementationOnce(incomplete([inbox('wss://tie.example.com', 200, 'c')]));
  expect(await inboxOf()).toEqual(['wss://current.example.com/']);

  // ...but a strictly newer one does.
  jest.setSystemTime(step + 2 * PEER_LIST_FAILED_TTL_MS);
  query.mockImplementationOnce(incomplete([inbox('wss://newer.example.com', 300, 'd')]));
  expect(await inboxOf()).toEqual(['wss://newer.example.com/']);
  expect(query).toHaveBeenCalledTimes(5);
});

it('lets a completed lookup replace an EXPIRED find with absent', async () => {
  jest.useFakeTimers({ now: 11_000_000 });
  query.mockImplementationOnce(
    answered([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  await getPeerRelayLists(alice, { viewerPubkey: viewer });
  jest.setSystemTime(11_000_000 + PEER_LIST_TTL_MS);
  query.mockImplementationOnce(answered([]));
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  expect(result.status === 'ok' && result.lists.inbox).toBeNull();
});

it('a redirected (uncacheable) retry still returns fresh cached finds, writing nothing', async () => {
  jest.useFakeTimers({ now: 13_000_000 });
  setCurrentUserPubkey(viewer);
  query.mockImplementationOnce(
    incomplete([listEvent(alice, 10050, [['relay', 'wss://inbox.example.com']])]),
  );
  await getPeerRelayLists(alice, { viewerPubkey: viewer });

  // The unknown 10002 expires; the retry is redirected to the test relay,
  // which completes with nothing.
  jest.setSystemTime(13_000_000 + PEER_LIST_FAILED_TTL_MS);
  query.mockImplementationOnce(async (_relays, _filters, _maxWait, options) => {
    setCurrentUserPubkey(TEST_ACCOUNT_KEYS.little);
    options?.onClose?.(['closed automatically on eose']);
    return [];
  });
  const result = await getPeerRelayLists(alice, { viewerPubkey: viewer });
  // The fresh inbox isn't hidden by the redirected empty answer...
  expect(result.status === 'ok' && result.lists.inbox).toEqual(['wss://inbox.example.com/']);
  // ...and nothing was cached from it: the 10002 is still unknown, not absent.
  expect(peekPeerRelayLists(alice, viewer)).toEqual({
    status: 'ok',
    lists: { inbox: ['wss://inbox.example.com/'], read: undefined, write: undefined },
  });
});
