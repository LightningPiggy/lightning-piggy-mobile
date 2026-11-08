import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { subscribeAuthorOutboxFeed } from './authorFeedService';
import { __resetOutboxLeasesForTests, leasedOutboxRelayCount } from './authorOutboxRelays';
import { releaseNewIdleRelays } from './nostrPool';
import { getPeerRelayLists } from './peerRelayLists';

// The author-relay half of a profile feed (#1390): background, bounded,
// one author per subscription, released on close.
const mockSubscribeMany = jest.fn();
jest.mock('./nostrPool', () => ({
  pool: { subscribeMany: (...args: unknown[]) => mockSubscribeMany(...args) },
  trackRelays: jest.fn(),
  pooledRelayUrls: jest.fn(() => new Set<string>()),
  pruneIdleRelays: jest.fn(),
  releaseNewIdleRelays: jest.fn(),
}));
jest.mock('./relayHealth', () => ({
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
