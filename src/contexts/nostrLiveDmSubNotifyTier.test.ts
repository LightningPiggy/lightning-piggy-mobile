/**
 * Live kind-4 path + follow-gate reconciliation: notifications follow the Web
 * of Trust tier, storage keeps the follow gate. Harness mirrors
 * nostrLiveDmSubFollowGate.test.ts.
 */
import {
  startLiveDmSubscription as openLiveDmSubscription,
  type LiveDmSubscriptionParams,
} from './nostrLiveDmSub';
import { act, renderHook } from '@testing-library/react-native';
import { useLiveFollowGate } from './useLiveFollowGate';
import { adoptFollowSnapshot } from '../services/contactFollowFreshness';
import { clearFollowGateStores } from '../services/followSetEvents';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { nip04PlaintextCache } from './nostrSecretKeyCache';
import { upsertDmMessages } from '../services/dmDb';
import { __resetForTests as __resetDedupe } from '../services/dmWrapNotificationDedupe';
import {
  __resetNotificationAudiences,
  publishNotificationAudience,
} from '../services/notificationAudience';
import type { WotTier } from '../services/wotSettingsService';

jest.mock('../services/marmotWelcomeRouter', () => ({
  routeMarmotWelcome: jest.fn(async (rumor: { kind: number }) => rumor.kind === 444),
}));

const mockSubscribe = jest.fn();
let capturedOnEvent: ((ev: unknown) => void) | null = null;
const mockUnsub = jest.fn();
jest.mock('../services/dmLiveSubscription', () => ({
  subscribeInboxDmsForViewer: (input: { onEvent: (ev: unknown) => void }) => {
    capturedOnEvent = input.onEvent;
    mockSubscribe(input);
    return mockUnsub;
  },
}));

jest.mock('../services/dmDb', () => ({
  selectDmWrapIds: jest.fn(async () => [] as string[]),
  hasConversationWith: jest.fn(async () => true),
  upsertDmMessages: jest.fn(async () => {}),
}));
jest.mock('../services/groupMessagesStorageService', () => ({
  listPersistedGroupWrapIds: jest.fn(async () => [] as string[]),
}));
jest.mock('./dmStoreMigrationRunner', () => ({
  ensureDmStoreMigrated: jest.fn(async () => {}),
}));

const mockNotifyDm = jest.fn();
jest.mock('./nostrEventBus', () => ({
  notifyDmMessage: (...a: unknown[]) => mockNotifyDm(...a),
}));
const mockFireNotification = jest.fn();
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireNotification(...a),
}));
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: jest.fn(async () => ({ kind: 'not-group' })),
}));
jest.mock('./knownWrapIdsCap', () => ({ capKnownWrapIds: jest.fn() }));
jest.mock('./nostrDecryptPacing', () => ({
  createYieldScheduler: jest.fn(() => ({
    maybeYield: jest.fn(async () => {}),
    get yieldCount() {
      return 0;
    },
    dispose: jest.fn(),
  })),
  NIP17_LOOP_YIELD_EVERY: 2,
}));

// nsec unwrap returns a handcrafted rumor; partner/text derive from it.
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: (wrap: { rumor?: unknown }) => wrap.rumor ?? null,
  unwrapWrapViaNip44: jest.fn(),
  partnerFromRumor: (rumor: { partnership?: { partnerPubkey: string; fromMe: boolean } }) =>
    rumor.partnership ?? null,
  textForRumor: (rumor: { content: string }) => rumor.content,
  rumorEventId: (rumor: { id?: string }) => rumor.id ?? 'rumor-id',
}));

jest.mock('./nostrSecretKeyCache', () => ({
  nip04PlaintextCache: { get: jest.fn(), set: jest.fn() },
  getMemoisedSecretKey: jest.fn(async () => new Uint8Array(32)),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => {}),
}));

jest.mock('./nostrDmCache', () => ({
  COLD_INITIAL_WRAP_LIMIT: 50,
  DM_INBOX_CAP: 200,
  inboxCacheKey: (pk: string) => `inbox_${pk}`,
  inboxLastSeenKey: (pk: string) => `seen_${pk}`,
  safeGetDmCacheItem: jest.fn(async () => null),
  loadLastSeen: jest.fn(async () => undefined),
  mergeInboxEntries: (prev: unknown[], batch: unknown[]) => [...prev, ...batch],
}));

const subscriptions = new Set<() => void>();
function startLiveDmSubscription(params: LiveDmSubscriptionParams) {
  const stop = openLiveDmSubscription(params);
  const teardown = () => {
    subscriptions.delete(teardown);
    stop();
  };
  subscriptions.add(teardown);
  return teardown;
}
afterEach(() => {
  for (const stop of subscriptions) stop();
});

const VIEWER = 'f'.repeat(64);

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function makeParams(overrides: Partial<LiveDmSubscriptionParams> = {}): LiveDmSubscriptionParams {
  const buffer = createLiveSubFollowGateBuffer();
  return {
    viewerPubkey: VIEWER,
    activeSigner: 'nsec',
    pubkey: VIEWER,
    signerType: 'nsec',
    readRelays: ['wss://relay.example'],
    knownWrapIdsRef: { current: { pubkey: null, set: new Set<string>() } },
    followPubkeysRef: { current: new Set<string>() },
    setDmInbox: jest.fn(),
    setAmberNip44Permission: jest.fn(),
    followGateBuffer: buffer,
    setDeferredReplay: jest.fn(),
    ...overrides,
  } as LiveDmSubscriptionParams;
}

const FRIEND = 'b'.repeat(64);
const FOF = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);
const nowSec = () => Math.floor(Date.now() / 1000);
const kind4 = (id: string, from: string, createdAt = nowSec()) => ({
  id,
  kind: 4,
  pubkey: from,
  created_at: createdAt,
  tags: [['p', VIEWER]],
  content: 'ciphertext',
});
const wrap = (id: string, from: string) => ({
  id,
  kind: 1059,
  pubkey: 'e'.repeat(64),
  created_at: nowSec(),
  tags: [],
  content: 'ciphertext',
  rumor: {
    kind: 14,
    created_at: nowSec(),
    content: `wrap from ${from.slice(0, 1)}`,
    partnership: { partnerPubkey: from, fromMe: false },
  },
});
const notified = () =>
  mockFireNotification.mock.calls.map(
    ([n]) => (n as { data: { conversationPubkey: string } }).data.conversationPubkey,
  );
const audience = (tier: WotTier) => ({ tier, fof: tier === 'fof' ? new Set([FOF]) : null });

beforeEach(() => {
  jest.clearAllMocks();
  clearFollowGateStores();
  __resetDedupe();
  __resetNotificationAudiences();
  capturedOnEvent = null;
  jest.mocked(nip04PlaintextCache.get).mockReturnValue('hello');
});

describe.each<[WotTier, string[]]>([
  ['friends', [FRIEND]],
  ['fof', [FRIEND, FOF]],
  ['all', [FRIEND, FOF, STRANGER]],
])('hydrated live kind-4 under %s', (tier, expected) => {
  it('notifies the senders the tier admits; stores and lists only the friend', async () => {
    publishNotificationAudience(VIEWER, audience(tier));
    const setDmInbox = jest.fn();
    startLiveDmSubscription(
      makeParams({
        followPubkeysRef: { current: new Set([FRIEND]) },
        followHydratedRef: { current: true },
        setDmInbox,
      }),
    );
    await flush();
    capturedOnEvent!(kind4('k-friend', FRIEND));
    capturedOnEvent!(kind4('k-fof', FOF));
    capturedOnEvent!(kind4('k-stranger', STRANGER));
    // A redelivery and a backlog message stay silent.
    capturedOnEvent!(kind4('k-stranger', STRANGER));
    capturedOnEvent!(kind4('k-old', STRANGER, nowSec() - 3600));
    await flush();
    await flush();
    expect(notified()).toEqual(expected);
    expect(
      jest
        .mocked(upsertDmMessages)
        .mock.calls.flatMap(([rows]) => rows)
        .map((r) => r.conversation),
    ).toEqual([FRIEND]);
    expect(mockNotifyDm.mock.calls).toEqual([[FRIEND]]);
  });
});

it('a tier change reaches the open sub without re-arming it', async () => {
  publishNotificationAudience(VIEWER, audience('friends'));
  startLiveDmSubscription(
    makeParams({
      followPubkeysRef: { current: new Set([FRIEND]) },
      followHydratedRef: { current: true },
    }),
  );
  await flush();
  capturedOnEvent!(kind4('k-1', STRANGER));
  await flush();
  expect(notified()).toEqual([]);
  publishNotificationAudience(VIEWER, audience('all'));
  capturedOnEvent!(kind4('k-2', STRANGER));
  await flush();
  expect(notified()).toEqual([STRANGER]);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
});

describe.each<[WotTier, string[]]>([
  ['friends', [FRIEND]],
  ['fof', [FRIEND, FOF]],
  ['all', [FRIEND, FOF, STRANGER]],
])('held while follows load, reconciled under %s', (tier, expected) => {
  it('notifies the turned-away senders the tier admits, without storing them', async () => {
    publishNotificationAudience(VIEWER, audience(tier));
    const { result, unmount } = renderHook(() =>
      useLiveFollowGate(new Set<string>(), false, VIEWER),
    );
    const gate = result.current;
    const teardown = startLiveDmSubscription(
      makeParams({
        followPubkeysRef: gate.followPubkeysRef,
        followHydratedRef: gate.followHydratedRef,
        followGateBuffer: gate.followGateBufferRef.current,
        setDeferredReplay: gate.setDeferredReplay,
      }),
    );
    await flush();
    capturedOnEvent!(kind4('h-friend', FRIEND));
    capturedOnEvent!(wrap('h-fof', FOF));
    capturedOnEvent!(kind4('h-stranger', STRANGER));
    await flush();
    expect(gate.followGateBufferRef.current.size).toBe(3);
    expect(mockFireNotification).not.toHaveBeenCalled();
    await act(async () => {
      await adoptFollowSnapshot(VIEWER, {
        createdAt: 1791834639,
        contacts: [{ pubkey: FRIEND, relay: null, petname: null, profile: null }],
      });
    });
    await flush();
    expect(notified().sort()).toEqual([...expected].sort());
    expect(
      jest
        .mocked(upsertDmMessages)
        .mock.calls.flatMap(([rows]) => rows)
        .map((r) => r.conversation),
    ).toEqual([FRIEND]);
    expect(gate.followGateBufferRef.current.size).toBe(0);
    teardown();
    unmount();
  });
});
