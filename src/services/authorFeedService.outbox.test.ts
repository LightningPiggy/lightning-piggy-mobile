import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { OUTBOX_FEED_EVENT_BUDGET_FACTOR, subscribeAuthorOutboxFeed } from './authorFeedService';
import {
  __resetOutboxLeasesForTests,
  leasedOutboxRelayCount,
  leaseOutboxRelays,
} from './authorOutboxRelays';
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

it('cuts off a relay that floods the feed: closed, released, reported and quarantined (M2)', async () => {
  write(['wss://noisy.example/', 'wss://quiet.example/']);
  const closers = new Map<string, jest.Mock>();
  mockSubscribeMany.mockImplementation(([relay]: string[]) => {
    const closeOne = jest.fn();
    closers.set(relay, closeOne);
    return { close: closeOne };
  });
  const onEvent = jest.fn();
  const onRelays = jest.fn();
  arm({ onEvent, onRelays, limit: 10 });
  await jest.runAllTimersAsync();
  expect(onRelays).toHaveBeenLastCalledWith(['wss://noisy.example/', 'wss://quiet.example/']);
  const noisy = mockSubscribeMany.mock.calls.find(([[r]]) => r === 'wss://noisy.example/')![2];
  const budget = OUTBOX_FEED_EVENT_BUDGET_FACTOR * 10;
  // Events by anyone count: the cost is paid before the author check.
  for (let i = 0; i < budget + 50; i++) {
    noisy.onevent({ id: `e${i}`, pubkey: viewer, kind: 1, created_at: i, content: '', tags: [] });
  }
  expect(closers.get('wss://noisy.example/')).toHaveBeenCalled();
  expect(closers.get('wss://quiet.example/')).not.toHaveBeenCalled();
  expect(recordRelayFailure).toHaveBeenCalledWith('wss://noisy.example/');
  expect(releaseNewIdleRelays).toHaveBeenCalledWith(['wss://noisy.example/'], new Set());
  // Older pages stop asking it, and it isn't leased again for a while.
  expect(onRelays).toHaveBeenLastCalledWith(['wss://quiet.example/']);
  expect(leaseOutboxRelays(['wss://noisy.example/']).relays).toEqual([]);
});

it('a relay within its budget is left alone', async () => {
  write(['wss://alice1.example/']);
  arm({ limit: 10 });
  await jest.runAllTimersAsync();
  const handlers = mockSubscribeMany.mock.calls[0][2];
  for (let i = 0; i < OUTBOX_FEED_EVENT_BUDGET_FACTOR * 10; i++) {
    handlers.onevent({ id: `e${i}`, pubkey: alice, kind: 1, created_at: i, content: '', tags: [] });
  }
  expect(close).not.toHaveBeenCalled();
  expect(recordRelayFailure).not.toHaveBeenCalled();
});
