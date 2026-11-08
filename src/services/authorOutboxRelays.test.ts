import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { setCurrentUserOwnRelays, setCurrentUserPubkey } from './nostrActiveAccount';
import {
  __resetOutboxLeasesForTests,
  authorWriteRelays,
  cachedAuthorWriteRelays,
  leasedOutboxRelayCount,
  leaseOutboxRelays,
  MAX_AUTHOR_OUTBOX_RELAYS,
  MAX_OUTBOX_EXTRA_RELAYS,
  OUTBOX_FRAMES_PER_LEASE,
  OUTBOX_QUARANTINE_MS,
  personOutboxRelays,
  quarantineOutboxRelay,
  withoutRelays,
  zapReceiptRelays,
} from './authorOutboxRelays';
import { claimPendingRelease, pooledRelayUrls, releaseNewIdleRelays } from './nostrPool';
import { getPeerRelayLists, peekPeerRelayLists, type PeerRelayLists } from './peerRelayLists';
import { addRelayFrameBudget, clearRelayFrameBudget } from './nostrRelayReceiveQueue';
import { recordRelayFailure } from './relayHealth';

jest.mock('./nostrPool', () => ({
  claimPendingRelease: jest.fn(() => false),
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./nostrRelayReceiveQueue', () => ({
  addRelayFrameBudget: jest.fn(),
  clearRelayFrameBudget: jest.fn(),
}));
jest.mock('./relayHealth', () => ({ recordRelayFailure: jest.fn() }));
jest.mock('./peerRelayLists', () => ({
  getPeerRelayLists: jest.fn(),
  peekPeerRelayLists: jest.fn(),
}));

const viewer = 'f'.repeat(64);
const alice = 'a'.repeat(64);
const testViewer = TEST_ACCOUNT_KEYS.big;
const peek = jest.mocked(peekPeerRelayLists);
const lookup = jest.mocked(getPeerRelayLists);
const pooled = jest.mocked(pooledRelayUrls);
const claim = jest.mocked(claimPendingRelease);
const release = jest.mocked(releaseNewIdleRelays);

const lists = (partial: Partial<PeerRelayLists>) => ({
  status: 'ok' as const,
  lists: { inbox: undefined, read: undefined, write: undefined, ...partial },
});
const relay = (n: number) => `wss://r${n}.example/`;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  __resetOutboxLeasesForTests();
  // The viewer's lists have loaded (own relays: none here).
  setCurrentUserOwnRelays([], true);
  pooled.mockReturnValue(new Set());
  claim.mockReturnValue(false);
});

describe('withoutRelays / personOutboxRelays', () => {
  it("drops the viewer's relays (normalised), dedupes and caps per person", () => {
    const out = withoutRelays(
      ['wss://Mine.example', relay(1), relay(1), relay(2), relay(3), relay(4)],
      ['wss://mine.example/'],
    );
    expect(out).toEqual([relay(1), relay(2), relay(3)]);
    expect(out).toHaveLength(MAX_AUTHOR_OUTBOX_RELAYS);
  });

  it('puts write relays before hints and sanitises the hints', () => {
    const out = personOutboxRelays(
      [relay(1)],
      ['ws://192.168.1.5:7777', 'wss://localhost', 42, relay(2), relay(1)],
      [],
    );
    expect(out).toEqual([relay(1), relay(2)]);
  });

  it('caps after dropping relays already asked, hints included (L2)', () => {
    const out = personOutboxRelays(
      [relay(1), relay(2), relay(3)],
      [relay(4), relay(5)],
      [relay(1), relay(2), relay(3)],
    );
    expect(out).toEqual([relay(4), relay(5)]);
  });
});

describe('author write relays', () => {
  it('serves cached write relays, capped, without a lookup', () => {
    peek.mockReturnValue(lists({ write: [relay(1), relay(2), relay(3), relay(4)] }));
    expect(cachedAuthorWriteRelays(alice, viewer)).toEqual([relay(1), relay(2), relay(3)]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('is empty when nothing is cached or the list is absent', () => {
    peek.mockReturnValue(undefined);
    expect(cachedAuthorWriteRelays(alice, viewer)).toEqual([]);
    peek.mockReturnValue(lists({ write: null }));
    expect(cachedAuthorWriteRelays(alice, viewer)).toEqual([]);
  });

  it("caps only after dropping the viewer's relays (L2); a failed lookup is empty", async () => {
    // The author's first three write relays are the viewer's own.
    const mine = ['wss://mine1.example/', 'wss://mine2.example/', 'wss://mine3.example/'];
    lookup.mockResolvedValueOnce(lists({ write: [...mine, relay(4)] }));
    const all = await authorWriteRelays(alice, { viewerPubkey: viewer });
    expect(all).toEqual([...mine, relay(4)]);
    expect(withoutRelays(all, mine)).toEqual([relay(4)]);
    lookup.mockResolvedValueOnce({ status: 'failed', error: 'x' });
    expect(await authorWriteRelays(alice, { viewerPubkey: viewer })).toEqual([]);
  });

  it('a test account in lockdown never looks up or uses public relays', async () => {
    peek.mockReturnValue(lists({ write: [relay(1)], read: [relay(2)] }));
    expect(await authorWriteRelays(alice, { viewerPubkey: testViewer })).toEqual([]);
    expect(cachedAuthorWriteRelays(alice, testViewer)).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('zapReceiptRelays (F11)', () => {
  it("adds the recipient's cached read relays after the zapper's", () => {
    peek.mockReturnValue(lists({ read: ['wss://mine.example/', relay(1), relay(2)] }));
    expect(zapReceiptRelays(alice, ['wss://mine.example'], viewer)).toEqual([
      'wss://mine.example',
      relay(1),
      relay(2),
    ]);
  });

  it('never waits on a lookup: nothing cached means the zapper relays only', () => {
    peek.mockReturnValue(undefined);
    expect(zapReceiptRelays(alice, ['wss://mine.example'], viewer)).toEqual(['wss://mine.example']);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('adds nothing for a test account in lockdown', () => {
    peek.mockReturnValue(lists({ read: [relay(1)] }));
    expect(zapReceiptRelays(alice, ['ws://test'], testViewer)).toEqual(['ws://test']);
  });
});

describe('leaseOutboxRelays (global ceiling)', () => {
  it(`grants at most ${MAX_OUTBOX_EXTRA_RELAYS} distinct relays app-wide`, () => {
    for (let i = 0; i < 10; i++) leaseOutboxRelays([relay(i * 3), relay(i * 3 + 1)]);
    expect(leasedOutboxRelayCount()).toBe(20);
    const next = leaseOutboxRelays([relay(100), relay(101), relay(102), relay(103), relay(104)]);
    expect(next.relays).toHaveLength(5);
    expect(leasedOutboxRelayCount()).toBe(MAX_OUTBOX_EXTRA_RELAYS);
    expect(leaseOutboxRelays([relay(200)]).relays).toEqual([]);
    // An already-leased relay is shared, not a new socket.
    expect(leaseOutboxRelays([relay(0)]).relays).toEqual([relay(0)]);
    expect(leasedOutboxRelayCount()).toBe(MAX_OUTBOX_EXTRA_RELAYS);
    next.release(); // never connected: nothing left to close
    expect(leaseOutboxRelays([relay(200)]).relays).toEqual([relay(200)]);
  });

  it('releases a socket after its last lease, only if it opened it, and is idempotent', () => {
    pooled.mockReturnValue(new Set([relay(2)]));
    const a = leaseOutboxRelays([relay(1), relay(2)]);
    pooled.mockReturnValue(new Set([relay(1), relay(2)]));
    const b = leaseOutboxRelays([relay(1)]);
    a.release();
    a.release();
    expect(release).not.toHaveBeenCalled();
    b.release();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toEqual([relay(1)]);
  });

  it('a busy socket keeps counting against the ceiling until it is actually closed (#6)', () => {
    const lease = leaseOutboxRelays([relay(1)]);
    // Still open after release (its read hasn't finished): the pool closes it later.
    pooled.mockReturnValue(new Set([relay(1)]));
    lease.release();
    expect(leasedOutboxRelayCount()).toBe(1);
    const fill = leaseOutboxRelays(
      Array.from({ length: MAX_OUTBOX_EXTRA_RELAYS }, (_, i) => relay(50 + i)),
    );
    expect(fill.relays).toHaveLength(MAX_OUTBOX_EXTRA_RELAYS - 1);
    // Once the pool has closed it, it stops counting.
    pooled.mockReturnValue(new Set());
    expect(leasedOutboxRelayCount()).toBe(MAX_OUTBOX_EXTRA_RELAYS - 1);
  });

  it('re-leasing a socket whose release is pending claims it back and still closes it later (M1)', () => {
    const first = leaseOutboxRelays([relay(1)]);
    pooled.mockReturnValue(new Set([relay(1)])); // R is pooled, waiting to be released
    first.release();
    expect(release).toHaveBeenCalledTimes(1);
    claim.mockReturnValueOnce(true);
    const second = leaseOutboxRelays([relay(1)]);
    expect(claim).toHaveBeenCalledWith(relay(1));
    second.release();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls[1][0]).toEqual([relay(1)]);
  });

  it("claims a pooled socket that's only pending release instead of treating it as someone else's (M1)", () => {
    pooled.mockReturnValue(new Set([relay(1)]));
    claim.mockReturnValueOnce(true); // e.g. a one-off socket waiting to close
    leaseOutboxRelays([relay(1)]).release();
    expect(release).toHaveBeenCalledWith([relay(1)], new Set());
  });

  it('never grants a quarantined relay until the quarantine ends', () => {
    quarantineOutboxRelay(relay(9));
    expect(leaseOutboxRelays([relay(9), relay(8)]).relays).toEqual([relay(8)]);
    jest.advanceTimersByTime(OUTBOX_QUARANTINE_MS);
    expect(leaseOutboxRelays([relay(9)]).relays).toEqual([relay(9)]);
  });
});

describe('raw-frame budget for owned sockets (round 3 #1)', () => {
  const budget = jest.mocked(addRelayFrameBudget);

  it('each lease on an owned socket adds to its budget; sockets we did not open get none', () => {
    leaseOutboxRelays([relay(1)]);
    leaseOutboxRelays([relay(1)]);
    expect(budget).toHaveBeenCalledTimes(2);
    expect(budget.mock.calls[0].slice(0, 2)).toEqual([relay(1), OUTBOX_FRAMES_PER_LEASE]);
    budget.mockClear();
    pooled.mockReturnValue(new Set([relay(2)])); // someone else's socket
    leaseOutboxRelays([relay(2)]);
    expect(budget).not.toHaveBeenCalled();
  });

  it('a blown budget quarantines the relay, reports it, and revokes every holder', () => {
    const revokedA = jest.fn();
    const revokedB = jest.fn();
    leaseOutboxRelays([relay(1)], revokedA);
    leaseOutboxRelays([relay(1)], revokedB);
    const onExceeded = budget.mock.calls[0][2];
    onExceeded();
    expect(revokedA).toHaveBeenCalledTimes(1);
    expect(revokedB).toHaveBeenCalledTimes(1);
    expect(recordRelayFailure).toHaveBeenCalledWith(relay(1));
    expect(leaseOutboxRelays([relay(1)]).relays).toEqual([]);
  });

  it('a released lease is no longer revoked, and the budget goes once the socket has closed', () => {
    const revoked = jest.fn();
    const lease = leaseOutboxRelays([relay(1)], revoked);
    const onExceeded = budget.mock.calls[0][2];
    lease.release();
    onExceeded();
    expect(revoked).not.toHaveBeenCalled();
    pooled.mockReturnValue(new Set()); // the socket is gone
    expect(leasedOutboxRelayCount()).toBe(0);
    expect(clearRelayFrameBudget).toHaveBeenCalledWith(relay(1));
  });
});

describe("the viewer's own relays", () => {
  it('are never leased (or budgeted), whoever asks', () => {
    setCurrentUserOwnRelays(['wss://R5.example', relay(7)], true);
    expect(leaseOutboxRelays([relay(5), relay(6), relay(7)]).relays).toEqual([relay(6)]);
    expect(jest.mocked(addRelayFrameBudget).mock.calls.map(([url]) => url)).toEqual([relay(6)]);
  });

  it('nothing is leased before they are known (cold start, before the lists hydrate) (c)', () => {
    // A defaults-based own list, not yet this identity's.
    setCurrentUserOwnRelays(['wss://default.example/'], false);
    expect(leaseOutboxRelays([relay(1)]).relays).toEqual([]);
    expect(addRelayFrameBudget).not.toHaveBeenCalled();
    expect(leasedOutboxRelayCount()).toBe(0);
    // A new identity starts unhydrated again.
    setCurrentUserOwnRelays([], true);
    setCurrentUserPubkey('e'.repeat(64));
    expect(leaseOutboxRelays([relay(1)]).relays).toEqual([]);
    setCurrentUserPubkey(null);
  });

  it('a leased relay that BECOMES an own relay loses its grant at once and stays open (a)', () => {
    const lease = leaseOutboxRelays([relay(1)]);
    pooled.mockReturnValue(new Set([relay(1)])); // the viewer's DM sub keeps it pooled
    setCurrentUserOwnRelays([relay(1)], true); // e.g. a relay edit / account switch
    expect(clearRelayFrameBudget).toHaveBeenCalledWith(relay(1));
    expect(claim).toHaveBeenCalledWith(relay(1));
    expect(leasedOutboxRelayCount()).toBe(0);
    // The old lease ending doesn't hand the viewer's socket to the deferred release.
    lease.release();
    expect(release).not.toHaveBeenCalled();
  });
});

describe('revocation (b)', () => {
  it('drops the grant once no holder is left, instead of lingering', () => {
    const revoked = jest.fn();
    let lease!: ReturnType<typeof leaseOutboxRelays>;
    // The holder releases its lease when revoked (as the feed does).
    revoked.mockImplementation(() => lease.release());
    lease = leaseOutboxRelays([relay(1)], revoked);
    pooled.mockReturnValue(new Set([relay(1)])); // the socket hasn't gone yet
    jest.mocked(addRelayFrameBudget).mock.calls[0][2]();
    expect(revoked).toHaveBeenCalled();
    expect(clearRelayFrameBudget).toHaveBeenCalledWith(relay(1));
    expect(leasedOutboxRelayCount()).toBe(0);
  });

  it('two leases sharing one callback are each notified; releasing one keeps the other', () => {
    const shared = jest.fn();
    const a = leaseOutboxRelays([relay(1)], shared);
    leaseOutboxRelays([relay(1)], shared);
    a.release();
    jest.mocked(addRelayFrameBudget).mock.calls[0][2]();
    expect(shared).toHaveBeenCalledTimes(1); // the remaining lease still heard it
  });
});

describe('a borrowed socket replaced while leased (CodeRabbit)', () => {
  it('becomes ours when its replacement opens, so it is still released', () => {
    pooled.mockReturnValue(new Set([relay(1)])); // someone else's socket
    const feed = leaseOutboxRelays([relay(1)]);
    expect(addRelayFrameBudget).not.toHaveBeenCalled();
    // That socket closes; a later lookup's lease will open a replacement.
    pooled.mockReturnValue(new Set());
    const lookup = leaseOutboxRelays([relay(1)]);
    expect(addRelayFrameBudget).toHaveBeenCalledWith(
      relay(1),
      expect.any(Number),
      expect.any(Function),
    );
    lookup.release();
    pooled.mockReturnValue(new Set([relay(1)])); // the replacement, still open
    feed.release();
    expect(release).toHaveBeenCalledWith([relay(1)], new Set());
    expect(leasedOutboxRelayCount()).toBe(1); // counted until it's closed
  });

  it('takes the per-lease frame budget the caller sized', () => {
    leaseOutboxRelays([relay(1)], undefined, 5_000);
    expect(jest.mocked(addRelayFrameBudget).mock.calls[0][1]).toBe(5_000);
  });
});
