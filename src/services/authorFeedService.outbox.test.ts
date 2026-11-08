import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { OUTBOX_FEED_EVENT_BUDGET_FACTOR, subscribeAuthorOutboxFeed } from './authorFeedService';
import {
  __resetOutboxLeasesForTests,
  leasedOutboxRelayCount,
  leaseOutboxRelays,
} from './authorOutboxRelays';
import { setCurrentUserOwnRelays } from './nostrActiveAccount';
import { releaseNewIdleRelays } from './nostrPool';
import { recordRelayFailure } from './relayHealth';
import { getPeerRelayLists } from './peerRelayLists';

// The author-relay half of a profile feed (#1390): background, bounded,
// one author per subscription, released on close.
const mockSubscribeMany = jest.fn();
jest.mock('./nostrPool', () => ({
  pool: { subscribeMany: (...args: unknown[]) => mockSubscribeMany(...args) },
  trackRelays: jest.fn(),
  claimPendingRelease: jest.fn(() => false),
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./relayHealth', () => ({
  recordRelayFailure: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
  relayKey: (url: string) => url,
}));
jest.mock('./peerRelayLists', () => ({
  getPeerRelayLists: jest.fn(),
  peekPeerRelayLists: jest.fn(),
}));
const mockFrameBudgets = new Map<string, () => void>();
jest.mock('./nostrRelayReceiveQueue', () => ({
  addRelayFrameBudget: (url: string, _frames: number, onExceeded: () => void) =>
    mockFrameBudgets.set(url, onExceeded),
  clearRelayFrameBudget: (url: string) => mockFrameBudgets.delete(url),
}));

const viewer = 'f'.repeat(64);
const alice = 'a'.repeat(64);
const lookup = jest.mocked(getPeerRelayLists);
const write = (urls: string[]) =>
  lookup.mockResolvedValue({
    status: 'ok',
    lists: { inbox: undefined, read: undefined, write: urls },
  });

const close = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  __resetOutboxLeasesForTests();
  setCurrentUserOwnRelays([], true); // the viewer's lists have loaded
  mockSubscribeMany.mockReturnValue({ close });
});

const arm = (extra: Partial<Parameters<typeof subscribeAuthorOutboxFeed>[0]> = {}) =>
  subscribeAuthorOutboxFeed({
    authorPubkey: alice,
    currentRelays: ['wss://mine.example/'],
    viewerPubkey: viewer,
    onEvent: jest.fn(),
    ...extra,
  });

it("subscribes only the author's relays the viewer doesn't use, once they're known", async () => {
  write(['wss://mine.example', 'wss://alice1.example/', 'wss://alice2.example/']);
  const onRelays = jest.fn();
  arm({ onRelays });
  // Nothing synchronous: the caller's own subscription is never held up.
  expect(mockSubscribeMany).not.toHaveBeenCalled();
  await jest.runAllTimersAsync();
  const relays = mockSubscribeMany.mock.calls.map(([r]) => r[0]);
  expect(relays).toEqual(['wss://alice1.example/', 'wss://alice2.example/']);
  for (const [, filter] of mockSubscribeMany.mock.calls) {
    expect(filter).toMatchObject({ authors: [alice], limit: 30 });
  }
  expect(onRelays).toHaveBeenCalledWith(['wss://alice1.example/', 'wss://alice2.example/']);
});

it('caps the author at 3 relays', async () => {
  write([1, 2, 3, 4, 5].map((n) => `wss://a${n}.example/`));
  arm();
  await jest.runAllTimersAsync();
  expect(mockSubscribeMany).toHaveBeenCalledTimes(3);
});

it('delivers author-relay events to the same handler (merged by the caller)', async () => {
  write(['wss://alice1.example/']);
  const onEvent = jest.fn();
  arm({ onEvent });
  await jest.runAllTimersAsync();
  const handlers = mockSubscribeMany.mock.calls[0][2];
  handlers.onevent({ id: 'n1', pubkey: alice, kind: 1, created_at: 1, content: '', tags: [] });
  handlers.onevent({ id: 'x', pubkey: viewer, kind: 1, created_at: 1, content: '', tags: [] });
  expect(onEvent).toHaveBeenCalledTimes(1);
  expect(onEvent.mock.calls[0][0].id).toBe('n1');
});

it('closing before the lookup lands subscribes nothing and leases nothing', async () => {
  write(['wss://alice1.example/']);
  const stop = arm();
  stop();
  await jest.runAllTimersAsync();
  expect(mockSubscribeMany).not.toHaveBeenCalled();
  expect(leasedOutboxRelayCount()).toBe(0);
});

it('closing ends the subscription and releases the sockets it opened', async () => {
  write(['wss://alice1.example/']);
  const stop = arm();
  await jest.runAllTimersAsync();
  expect(leasedOutboxRelayCount()).toBe(1);
  stop();
  expect(close).toHaveBeenCalled();
  expect(leasedOutboxRelayCount()).toBe(0);
  expect(releaseNewIdleRelays).toHaveBeenCalledWith(['wss://alice1.example/'], new Set());
});

it('the global ceiling bounds many open author feeds', async () => {
  lookup.mockImplementation(async (pubkey) => ({
    status: 'ok',
    lists: {
      inbox: undefined,
      read: undefined,
      write: [1, 2, 3].map((n) => `wss://${pubkey.slice(-4)}-${n}.example/`),
    },
  }));
  for (let i = 0; i < 12; i++) {
    arm({ authorPubkey: i.toString(16).padStart(64, '0').replace(/^0/, 'a') });
  }
  await jest.runAllTimersAsync();
  expect(leasedOutboxRelayCount()).toBe(25);
  expect(mockSubscribeMany.mock.calls.length).toBe(25);
});

it('a test account in lockdown adds no author relays', async () => {
  write(['wss://alice1.example/']);
  arm({ viewerPubkey: TEST_ACCOUNT_KEYS.big });
  await jest.runAllTimersAsync();
  expect(lookup).not.toHaveBeenCalled();
  expect(mockSubscribeMany).not.toHaveBeenCalled();
});

it('cuts off a relay that floods the feed: closed once, released, reported and quarantined (M2)', async () => {
  write(['wss://noisy.example/', 'wss://quiet.example/']);
  const closers = new Map<string, jest.Mock>();
  mockSubscribeMany.mockImplementation(([relay]: string[]) => {
    const closeOne = jest.fn();
    closers.set(relay, closeOne);
    return { close: closeOne };
  });
  const onRelays = jest.fn();
  const stop = arm({ onRelays, limit: 10 });
  await jest.runAllTimersAsync();
  expect(onRelays).toHaveBeenLastCalledWith(['wss://noisy.example/', 'wss://quiet.example/']);
  const noisy = mockSubscribeMany.mock.calls.find(([[r]]) => r === 'wss://noisy.example/')![2];
  const budget = OUTBOX_FEED_EVENT_BUDGET_FACTOR * 10;
  // Counted in `alreadyHaveEvent`, which nostr-tools calls for every EVENT
  // BEFORE parsing / verifying it (any author, on-filter or not). Past the
  // budget each one is skipped (true), so it's never verified.
  const skipped: boolean[] = [];
  for (let i = 0; i < budget + 50; i++) skipped.push(noisy.alreadyHaveEvent(`e${i}`));
  expect(skipped.slice(0, budget).every((s) => s === false)).toBe(true);
  expect(skipped.slice(budget).every((s) => s === true)).toBe(true);
  await jest.runAllTimersAsync();
  expect(closers.get('wss://quiet.example/')).not.toHaveBeenCalled();
  expect(recordRelayFailure).toHaveBeenCalledWith('wss://noisy.example/');
  expect(releaseNewIdleRelays).toHaveBeenCalledWith(['wss://noisy.example/'], new Set());
  // Older pages stop asking it, and it isn't leased again for a while.
  expect(onRelays).toHaveBeenLastCalledWith(['wss://quiet.example/']);
  expect(leaseOutboxRelays(['wss://noisy.example/']).relays).toEqual([]);
  // Closed exactly once, even after the feed closes too (L-A: nostr-tools'
  // closers aren't idempotent; a second close corrupts its bookkeeping).
  stop();
  expect(closers.get('wss://noisy.example/')).toHaveBeenCalledTimes(1);
  expect(closers.get('wss://quiet.example/')).toHaveBeenCalledTimes(1);
});

it('a relay within its budget is left alone', async () => {
  write(['wss://alice1.example/']);
  arm({ limit: 10 });
  await jest.runAllTimersAsync();
  const handlers = mockSubscribeMany.mock.calls[0][2];
  for (let i = 0; i < OUTBOX_FEED_EVENT_BUDGET_FACTOR * 10; i++) {
    expect(handlers.alreadyHaveEvent(`e${i}`)).toBe(false);
  }
  await jest.runAllTimersAsync();
  expect(close).not.toHaveBeenCalled();
  expect(recordRelayFailure).not.toHaveBeenCalled();
});

it('never closes a subscription the relay already closed (L-A)', async () => {
  write(['wss://alice1.example/']);
  const stop = arm({ limit: 10 });
  await jest.runAllTimersAsync();
  mockSubscribeMany.mock.calls[0][2].onclose(['closed by relay']);
  stop();
  expect(close).not.toHaveBeenCalled();
});

it('a socket that blows its raw-frame budget is dropped from the feed and from paging (round 3 #1)', async () => {
  write(['wss://noisy.example/', 'wss://quiet.example/']);
  const onRelays = jest.fn();
  arm({ onRelays, limit: 10 });
  await jest.runAllTimersAsync();
  // The receive hook counted too many raw frames on this socket.
  mockFrameBudgets.get('wss://noisy.example/')!();
  expect(onRelays).toHaveBeenLastCalledWith(['wss://quiet.example/']);
  expect(recordRelayFailure).toHaveBeenCalledWith('wss://noisy.example/');
  expect(releaseNewIdleRelays).toHaveBeenCalledWith(['wss://noisy.example/'], new Set());
  expect(leaseOutboxRelays(['wss://noisy.example/']).relays).toEqual([]);
});

it("never leases the viewer's DM inbox relays, even when they're the author's write relays", async () => {
  write(['wss://dm-inbox.example/', 'wss://alice1.example/']);
  arm({ excludeRelays: ['wss://DM-inbox.example'] });
  await jest.runAllTimersAsync();
  const subscribed = mockSubscribeMany.mock.calls.map(([[r]]) => r);
  expect(subscribed).toEqual(['wss://alice1.example/']);
  // Not leased (so never frame-budgeted) either.
  expect(mockFrameBudgets.has('wss://dm-inbox.example/')).toBe(false);
  expect(leasedOutboxRelayCount()).toBe(1);
});
