import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { __resetOutboxLeasesForTests, leaseOutboxRelays } from './authorOutboxRelays';
import { getManyPeerRelayLists, type PeerRelayListResult } from './peerRelayLists';
import {
  __resetProfileFallbackForTests,
  fetchMissingProfileEvents,
  FALLBACK_RETRY_THROTTLE_MS,
  MAX_FALLBACK_PEOPLE,
} from './profileOutboxFallback';
import { querySyncAbortable } from './relayQuery';

jest.mock('./nostrPool', () => ({
  pool: {},
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  pruneIdleRelays: jest.fn(),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./peerRelayLists', () => ({
  getManyPeerRelayLists: jest.fn(),
  getPeerRelayLists: jest.fn(),
  peekPeerRelayLists: jest.fn(),
}));
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));

const viewer = 'f'.repeat(64);
const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);
const pk = (n: number) => n.toString(16).padStart(64, '0');
const relay = (name: string) => `wss://${name}.example/`;
const lists = jest.mocked(getManyPeerRelayLists);
const query = jest.mocked(querySyncAbortable);

const ok = (write: string[] | null): PeerRelayListResult => ({
  status: 'ok',
  lists: { inbox: undefined, read: undefined, write },
});
const kind0 = (pubkey: string, created_at = 1) =>
  ({
    id: `${pubkey}-${created_at}`,
    pubkey,
    kind: 0,
    created_at,
    content: '{}',
    tags: [],
  }) as never;

const writeLists = (byPerson: Record<string, PeerRelayListResult>) =>
  lists.mockImplementation(async (pubkeys) => {
    const out = new Map<string, PeerRelayListResult>();
    for (const p of pubkeys) out.set(p, byPerson[p] ?? ok(null));
    return out;
  });

const opts = { purpose: 'display' as const, alreadyAsked: [relay('mine')], viewerPubkey: viewer };

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  __resetOutboxLeasesForTests();
  __resetProfileFallbackForTests();
  query.mockResolvedValue([]);
});

it("asks each person's own relays, one person per query (never batched)", async () => {
  writeLists({
    [alice]: ok([relay('alice1'), relay('shared'), relay('mine')]),
    [bob]: ok([relay('bob1'), relay('shared')]),
  });
  query.mockImplementation(async (_pool, _relays, filter) => [kind0(filter.authors![0])]);
  const found = await fetchMissingProfileEvents([alice, bob], opts);
  expect([...found.keys()].sort()).toEqual([alice, bob]);
  const calls = query.mock.calls.map(([, relays, filter]) => ({ relays, filter }));
  expect(calls).toEqual(
    expect.arrayContaining([
      {
        relays: [relay('alice1'), relay('shared')],
        filter: { kinds: [0], authors: [alice], limit: 1 },
      },
      {
        relays: [relay('bob1'), relay('shared')],
        filter: { kinds: [0], authors: [bob], limit: 1 },
      },
    ]),
  );
  // Privacy: every query carries exactly one author, sent only to that author's relays.
  for (const { relays, filter } of calls) {
    expect(filter.authors).toHaveLength(1);
    expect(relays).not.toContain(relay('mine'));
  }
});

it('caps relays per person and people per call; hints are sanitised and come after write relays', async () => {
  const many = Array.from({ length: MAX_FALLBACK_PEOPLE + 5 }, (_, i) => pk(i + 1));
  writeLists(
    Object.fromEntries(
      many.map((p) => [p, ok([relay(`${p.slice(-2)}w1`), relay(`${p.slice(-2)}w2`)])]),
    ),
  );
  const hints = new Map([[many[0], ['ws://192.168.1.10:7777', relay('hint'), relay('extra')]]]);
  const run = fetchMissingProfileEvents(many, { ...opts, hints });
  await jest.runAllTimersAsync();
  await run;
  expect(jest.mocked(lists).mock.calls[0][0]).toHaveLength(MAX_FALLBACK_PEOPLE);
  expect(query).toHaveBeenCalledTimes(MAX_FALLBACK_PEOPLE);
  const first = query.mock.calls.find(([, , f]) => f.authors![0] === many[0])!;
  expect(first[1]).toEqual([relay('01w1'), relay('01w2'), relay('hint')]);
  for (const [, relays] of query.mock.calls) expect(relays.length).toBeLessThanOrEqual(3);
});

it('throttles a miss for a while, per purpose, and never persists it', async () => {
  writeLists({ [alice]: ok([relay('alice1')]) });
  await fetchMissingProfileEvents([alice], opts);
  expect(query).toHaveBeenCalledTimes(1);
  await fetchMissingProfileEvents([alice], opts);
  expect(query).toHaveBeenCalledTimes(1);
  // A display-only miss doesn't suppress the verified fetch (lud16 path).
  await fetchMissingProfileEvents([alice], { ...opts, purpose: 'verified' });
  expect(query).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(FALLBACK_RETRY_THROTTLE_MS);
  await fetchMissingProfileEvents([alice], opts);
  expect(query).toHaveBeenCalledTimes(3);
});

it('a failed relay-list lookup is not throttled', async () => {
  lists.mockResolvedValue(new Map([[alice, { status: 'failed', error: 'offline' }]]));
  await fetchMissingProfileEvents([alice], opts);
  writeLists({ [alice]: ok([relay('alice1')]) });
  await fetchMissingProfileEvents([alice], opts);
  expect(query).toHaveBeenCalledTimes(1);
});

it('skips people whose relays are all already asked, without a query', async () => {
  writeLists({ [alice]: ok([relay('mine')]) });
  expect((await fetchMissingProfileEvents([alice], opts)).size).toBe(0);
  expect(query).not.toHaveBeenCalled();
});

it("ignores events by someone else, and keeps the person's newest kind-0", async () => {
  writeLists({ [alice]: ok([relay('alice1')]) });
  query.mockResolvedValue([kind0(bob, 9), kind0(alice, 2), kind0(alice, 5)]);
  const found = await fetchMissingProfileEvents([alice], opts);
  expect(found.get(alice)?.created_at).toBe(5);
  expect(found.has(bob)).toBe(false);
});

it('over the global relay ceiling it skips (no query, no throttle)', async () => {
  writeLists({ [alice]: ok([relay('alice1')]) });
  const hog = leaseOutboxRelays(Array.from({ length: 25 }, (_, i) => relay(`hog${i}`)));
  await fetchMissingProfileEvents([alice], opts);
  expect(query).not.toHaveBeenCalled();
  hog.release();
  await fetchMissingProfileEvents([alice], opts);
  expect(query).toHaveBeenCalledTimes(1);
});

it('a test account in lockdown makes no lookups at all', async () => {
  writeLists({ [alice]: ok([relay('alice1')]) });
  const found = await fetchMissingProfileEvents([alice], {
    ...opts,
    viewerPubkey: TEST_ACCOUNT_KEYS.big,
  });
  expect(found.size).toBe(0);
  expect(lists).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
