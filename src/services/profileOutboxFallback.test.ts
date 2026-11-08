import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { __resetOutboxLeasesForTests, leaseOutboxRelays } from './authorOutboxRelays';
import { getManyPeerRelayLists, type PeerRelayListResult } from './peerRelayLists';
import {
  __resetProfileFallbackForTests,
  fetchMissingProfileEvents,
  FALLBACK_RETRY_THROTTLE_MS,
  FALLBACK_START_DELAY_MS,
  MAX_FALLBACK_PEOPLE,
  scheduleMissingProfileFallback,
} from './profileOutboxFallback';
import { setCurrentUserOwnRelays, setCurrentUserPubkey } from './nostrActiveAccount';
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
  setCurrentUserOwnRelays([]);
  query.mockResolvedValue([]);
});

it("never asks (or leases) the viewer's own DM inbox relays, whatever the caller passes", async () => {
  // e.g. the contact screen's fetchProfile, whose already-asked list is read relays only.
  setCurrentUserOwnRelays(['wss://mine.example/', 'wss://DM-inbox.example']);
  writeLists({ [alice]: ok([relay('dm-inbox'), relay('alice1')]) });
  await fetchMissingProfileEvents([alice], { ...opts, alreadyAsked: [relay('mine')] });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1]).toEqual([relay('alice1')]);
  // A person whose only relay is the viewer's DM inbox gets no query at all.
  query.mockClear();
  writeLists({ [bob]: ok([relay('dm-inbox')]) });
  await fetchMissingProfileEvents([bob], { ...opts, alreadyAsked: [] });
  expect(query).not.toHaveBeenCalled();
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

describe('scheduleMissingProfileFallback (background, never awaited)', () => {
  beforeEach(() => {
    setCurrentUserPubkey(viewer);
    writeLists({ [alice]: ok([relay('alice1')]) });
  });

  it('starts only after the stagger delay and reports what it found', async () => {
    query.mockResolvedValue([kind0(alice)]);
    const onFound = jest.fn();
    scheduleMissingProfileFallback([alice], opts, onFound);
    await jest.advanceTimersByTimeAsync(FALLBACK_START_DELAY_MS - 1);
    expect(lists).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await jest.runAllTimersAsync();
    expect(onFound).toHaveBeenCalledTimes(1);
    expect([...onFound.mock.calls[0][0].keys()]).toEqual([alice]);
  });

  it('stays quiet when nothing was found', async () => {
    const onFound = jest.fn();
    scheduleMissingProfileFallback([alice], opts, onFound);
    await jest.runAllTimersAsync();
    expect(query).toHaveBeenCalled();
    expect(onFound).not.toHaveBeenCalled();
  });

  it('is cancelled by its closer before it starts', async () => {
    const cancel = scheduleMissingProfileFallback([alice], opts, jest.fn());
    cancel();
    await jest.runAllTimersAsync();
    expect(lists).not.toHaveBeenCalled();
  });

  it('an account switch cancels it, before it starts or while it runs', async () => {
    scheduleMissingProfileFallback([alice], opts, jest.fn());
    setCurrentUserPubkey(bob);
    await jest.runAllTimersAsync();
    expect(lists).not.toHaveBeenCalled();

    setCurrentUserPubkey(viewer);
    let answer!: (events: never[]) => void;
    query.mockReturnValue(new Promise((r) => (answer = r)));
    const onFound = jest.fn();
    scheduleMissingProfileFallback([alice], opts, onFound);
    await jest.advanceTimersByTimeAsync(FALLBACK_START_DELAY_MS);
    expect(query).toHaveBeenCalled();
    setCurrentUserPubkey(bob);
    answer([kind0(alice)] as never[]);
    await jest.runAllTimersAsync();
    // The previous account's result is dropped.
    expect(onFound).not.toHaveBeenCalled();
  });

  it('runs nothing when the account already changed since the caller started (#4)', async () => {
    setCurrentUserPubkey(bob); // the owner passed in is `viewer`
    scheduleMissingProfileFallback([alice], opts, jest.fn());
    await jest.runAllTimersAsync();
    expect(lists).not.toHaveBeenCalled();
  });

  it("an aborted caller's signal stops it (a newer refresh)", async () => {
    const generation = new AbortController();
    scheduleMissingProfileFallback([alice], { ...opts, signal: generation.signal }, jest.fn());
    generation.abort();
    await jest.runAllTimersAsync();
    expect(lists).not.toHaveBeenCalled();
  });
});

describe('cancellation stops running work (#5)', () => {
  it('passes the signal to the relay-list lookup and to every query', async () => {
    writeLists({ [alice]: ok([relay('alice1')]) });
    const controller = new AbortController();
    await fetchMissingProfileEvents([alice], { ...opts, signal: controller.signal });
    // Uncached relay-list discovery is cancelled too (#5).
    expect(lists.mock.calls[0][1]).toMatchObject({ signal: controller.signal });
    expect(query.mock.calls[0][3]).toMatchObject({ signal: controller.signal });
  });

  it('no new round, socket or throttle entry after an abort mid-run', async () => {
    const people = Array.from({ length: 8 }, (_, i) => pk(i + 1));
    writeLists(Object.fromEntries(people.map((p) => [p, ok([relay(`p${p.slice(-1)}`)])])));
    const controller = new AbortController();
    // The whole first round (5 people) is in flight when the user cancels.
    query.mockImplementation(async () => {
      if (query.mock.calls.length === 5) controller.abort();
      return [];
    });
    const run = fetchMissingProfileEvents(people, { ...opts, signal: controller.signal });
    await jest.runAllTimersAsync();
    expect((await run).size).toBe(0);
    // One round of 5, never the second.
    expect(query).toHaveBeenCalledTimes(5);
    // Aborted lookups aren't misses: a later call asks again.
    query.mockReset();
    query.mockResolvedValue([]);
    await fetchMissingProfileEvents(people.slice(0, 1), opts);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('an abort before the relay lists land opens no sockets', async () => {
    const controller = new AbortController();
    lists.mockImplementation(async (pubkeys) => {
      controller.abort();
      return new Map(pubkeys.map((p) => [p, ok([relay('alice1')])]));
    });
    await fetchMissingProfileEvents([alice], { ...opts, signal: controller.signal });
    expect(query).not.toHaveBeenCalled();
  });
});
