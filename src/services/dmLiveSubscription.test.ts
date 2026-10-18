import { SimplePool } from 'nostr-tools/pool';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { withRelayHealth } from './healthAwarePool';
import { subscribeInboxDmsForViewer } from './dmLiveSubscription';

jest.mock('./nostrService', () => ({
  get pool() {
    return mockPool;
  },
  trackRelays: jest.fn(),
  DM_INBOX_LIMIT: 100,
}));
jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  selectHealthyRelays: (urls: string[]) => urls,
  noteNetworkActivity: jest.fn(),
}));
class TestPool extends withRelayHealth(SimplePool) {}
let mockPool: TestPool;
const url = 'wss://inbox.example/';
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test.each([1, 2, 3, 4])(
  'actual inbox arm serves legacy DMs and gift wraps with relay limit %i',
  async (max) => {
    mockPool = new TestPool();
    mockPool.setRelaySubscriptionLimit(url, max);
    const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
    jest.spyOn(relay, 'send').mockResolvedValue();
    jest.spyOn(mockPool, 'ensureRelay').mockResolvedValue(relay);
    const onEvent = jest.fn();
    const onEose = jest.fn();
    const onWrapsClose = jest.fn();
    const cleanup = subscribeInboxDmsForViewer({
      viewerPubkey: 'me',
      relays: [url],
      onEvent,
      onEose,
      onWrapsClose,
      sinceK4: Math.floor(Date.now() / 1000),
      wrapsLimit: 10,
    });
    await tick();
    expect(relay.openSubs.size).toBe(1);
    const sub = [...relay.openSubs.values()][0];
    expect(sub.filters).toEqual([
      expect.objectContaining({ kinds: [4], since: expect.any(Number), limit: 100 }),
      { kinds: [1059], '#p': ['me'], limit: 10 },
    ]);
    for (const kind of [4, 1059]) {
      const event = {
        id: kind.toString(16).padStart(64, '0'),
        pubkey: 'a'.repeat(64),
        sig: 'b'.repeat(128),
        kind,
        created_at: Math.floor(Date.now() / 1000) - (kind === 1059 ? 2 * 86400 : 0),
        tags: [['p', 'me']],
        content: '',
      };
      relay._onmessage({ data: JSON.stringify(['EVENT', sub.id, event]) } as MessageEvent);
    }
    expect(onEvent.mock.calls.map(([event]) => event.kind)).toEqual([4, 1059]);
    sub.oneose?.();
    sub.oneose?.();
    expect(onEose).toHaveBeenCalledTimes(1);
    cleanup();
    expect(relay.openSubs.size).toBe(0);
    expect(onWrapsClose).not.toHaveBeenCalled();
    await tick();
    expect(onWrapsClose).toHaveBeenCalledTimes(1);
    mockPool.destroy();
  },
);

test('native-engine inbox omits wraps and retains EOSE and close signals', async () => {
  mockPool = new TestPool();
  const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
  jest.spyOn(relay, 'send').mockResolvedValue();
  jest.spyOn(mockPool, 'ensureRelay').mockResolvedValue(relay);
  const onEose = jest.fn();
  const onWrapsClose = jest.fn();
  const cleanup = subscribeInboxDmsForViewer({
    viewerPubkey: 'me',
    relays: [url],
    onEvent: jest.fn(),
    onEose,
    onWrapsClose,
    skipWraps: true,
  });
  await tick();
  const sub = [...relay.openSubs.values()][0];
  expect(sub.filters.map((filter) => filter.kinds)).toEqual([[4]]);
  sub.oneose?.();
  expect(onEose).toHaveBeenCalledTimes(1);
  cleanup();
  expect(relay.openSubs.size).toBe(0);
  expect(onWrapsClose).not.toHaveBeenCalled();
  await tick();
  expect(onWrapsClose).toHaveBeenCalledTimes(1);
  mockPool.destroy();
});

beforeEach(() => jest.useFakeTimers({ doNotFake: ['queueMicrotask'] }));
afterEach(() => jest.useRealTimers());
