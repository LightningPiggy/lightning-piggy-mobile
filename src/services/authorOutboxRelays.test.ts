import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import {
  __resetOutboxLeasesForTests,
  authorWriteRelays,
  cachedAuthorWriteRelays,
  leasedOutboxRelayCount,
  leaseOutboxRelays,
  MAX_AUTHOR_OUTBOX_RELAYS,
  MAX_OUTBOX_EXTRA_RELAYS,
  OUTBOX_RELEASE_RETRY_MS,
  personOutboxRelays,
  withoutRelays,
  zapReceiptRelays,
} from './authorOutboxRelays';
import { pooledRelayUrls, pruneIdleRelays, releaseNewIdleRelays } from './nostrPool';
import { getPeerRelayLists, peekPeerRelayLists, type PeerRelayLists } from './peerRelayLists';

jest.mock('./nostrPool', () => ({
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  pruneIdleRelays: jest.fn(),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./peerRelayLists', () => ({
  getPeerRelayLists: jest.fn(),
  peekPeerRelayLists: jest.fn(),
}));

const viewer = 'f'.repeat(64);
const alice = 'a'.repeat(64);
const testViewer = TEST_ACCOUNT_KEYS.big;
const peek = jest.mocked(peekPeerRelayLists);
const lookup = jest.mocked(getPeerRelayLists);

const lists = (partial: Partial<PeerRelayLists>) => ({
  status: 'ok' as const,
  lists: { inbox: undefined, read: undefined, write: undefined, ...partial },
});
const relay = (n: number) => `wss://r${n}.example/`;

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  __resetOutboxLeasesForTests();
  jest.mocked(pooledRelayUrls).mockReturnValue(new Set());
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

  it('looks up and caps; a failed lookup is empty', async () => {
    lookup.mockResolvedValueOnce(lists({ write: [relay(1), relay(2), relay(3), relay(4)] }));
    expect(await authorWriteRelays(alice, { viewerPubkey: viewer })).toHaveLength(3);
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
    const leases = [];
    for (let i = 0; i < 10; i++) leases.push(leaseOutboxRelays([relay(i * 3), relay(i * 3 + 1)]));
    expect(leasedOutboxRelayCount()).toBe(20);
    const next = leaseOutboxRelays([relay(100), relay(101), relay(102), relay(103), relay(104)]);
    expect(next.relays).toHaveLength(5);
    expect(leasedOutboxRelayCount()).toBe(MAX_OUTBOX_EXTRA_RELAYS);
    const full = leaseOutboxRelays([relay(200)]);
    expect(full.relays).toEqual([]);
    // An already-leased relay is shared, not a new socket.
    expect(leaseOutboxRelays([relay(0)]).relays).toEqual([relay(0)]);
    expect(leasedOutboxRelayCount()).toBe(MAX_OUTBOX_EXTRA_RELAYS);
    next.release();
    expect(leaseOutboxRelays([relay(200)]).relays).toEqual([relay(200)]);
  });

  it('releases a socket only after its last lease, and only if it opened it', () => {
    jest.mocked(pooledRelayUrls).mockReturnValue(new Set([relay(2)]));
    const a = leaseOutboxRelays([relay(1), relay(2)]);
    const b = leaseOutboxRelays([relay(1)]);
    a.release();
    a.release(); // idempotent
    expect(releaseNewIdleRelays).not.toHaveBeenCalled();
    b.release();
    expect(releaseNewIdleRelays).toHaveBeenCalledTimes(1);
    expect(jest.mocked(releaseNewIdleRelays).mock.calls[0][0]).toEqual([relay(1)]);
    expect(leasedOutboxRelayCount()).toBe(0);
    jest.advanceTimersByTime(OUTBOX_RELEASE_RETRY_MS);
    expect(pruneIdleRelays).toHaveBeenCalledWith([relay(1)]);
  });

  it('skips the retry prune for a relay leased again meanwhile', () => {
    leaseOutboxRelays([relay(1)]).release();
    leaseOutboxRelays([relay(1)]);
    jest.advanceTimersByTime(OUTBOX_RELEASE_RETRY_MS);
    expect(pruneIdleRelays).not.toHaveBeenCalled();
  });
});
