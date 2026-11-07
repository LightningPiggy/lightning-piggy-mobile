// A live sub torn down while it is still deciding a wrap (a relay-list change
// re-opens the sub, an account switch, an unmount) must give the wrap back.
// Re-opened subs share the same knownWrapIds set: an orphaned claim would make
// the next sub treat a never-alerted wrap as "already stored" and mark it
// handled, and the background watch then stays silent too.
import { startLiveDmSubscription, type LiveDmSubscriptionParams } from './nostrLiveDmSub';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { tryRouteGroupRumor } from './nostrGroupRouting';
import {
  wasWrapHandled,
  __resetForTests as __resetDedupeForTests,
} from '../services/dmWrapNotificationDedupe';

jest.mock('../services/marmotWelcomeRouter', () => ({ routeMarmotWelcome: jest.fn() }));
jest.mock('./nip171InboxRouting', () => ({ routeNip171Rumor: jest.fn(async () => false) }));

let capturedOnEvent: ((ev: unknown) => void) | null = null;
jest.mock('../services/dmLiveSubscription', () => ({
  subscribeInboxDmsForViewer: (input: { onEvent: (ev: unknown) => void }) => {
    capturedOnEvent = input.onEvent;
    return jest.fn();
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
jest.mock('./nostrEventBus', () => ({ notifyDmMessage: jest.fn() }));
const mockFireNotification = jest.fn(async () => 'notif-id');
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireNotification(...(a as [])),
  isThreadActivelyViewed: () => false,
}));
jest.mock('./nostrGroupRouting', () => ({ tryRouteGroupRumor: jest.fn() }));
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

const VIEWER = 'f'.repeat(64);
const ALICE = 'a'.repeat(64);
const WRAP_ID = 'fresh-wrap';

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function makeParams(
  knownWrapIdsRef: LiveDmSubscriptionParams['knownWrapIdsRef'],
): LiveDmSubscriptionParams {
  return {
    viewerPubkey: VIEWER,
    activeSigner: 'nsec',
    pubkey: VIEWER,
    signerType: 'nsec',
    readRelays: ['wss://relay.example'],
    knownWrapIdsRef,
    followPubkeysRef: { current: new Set([ALICE]) },
    followHydratedRef: { current: true },
    setDmInbox: jest.fn(),
    setAmberNip44Permission: jest.fn(),
    followGateBuffer: createLiveSubFollowGateBuffer(),
    setDeferredReplay: jest.fn(),
  } as LiveDmSubscriptionParams;
}

function freshWrap() {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: WRAP_ID,
    kind: 1059,
    pubkey: 'e'.repeat(64),
    created_at: now,
    tags: [['p', VIEWER]],
    content: 'ciphertext',
    rumor: {
      id: 'rumor-1',
      kind: 14,
      pubkey: ALICE,
      created_at: now,
      content: 'hello',
      tags: [['p', VIEWER]],
      partnership: { partnerPubkey: ALICE, fromMe: false },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetDedupeForTests();
  capturedOnEvent = null;
});

it('gives a wrap back when torn down mid-decision, so the re-opened sub alerts for it', async () => {
  const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };

  // Sub A takes the wrap and parks in group routing.
  let releaseRouting: (v: { kind: 'not-group' }) => void = () => {};
  jest.mocked(tryRouteGroupRumor).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseRouting = resolve as typeof releaseRouting;
      }) as ReturnType<typeof tryRouteGroupRumor>,
  );
  const stopA = startLiveDmSubscription(makeParams(knownWrapIdsRef));
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  expect(knownWrapIdsRef.current.set.has(WRAP_ID)).toBe(true);

  // Relay-list change: A is torn down before it decides, then routing resumes.
  stopA();
  releaseRouting({ kind: 'not-group' });
  await flush();
  expect(knownWrapIdsRef.current.set.has(WRAP_ID)).toBe(false);
  expect(wasWrapHandled(WRAP_ID)).toBe(false);
  expect(mockFireNotification).not.toHaveBeenCalled();

  // Sub B (same knownWrapIds) gets the relay's redelivery and alerts for it.
  jest
    .mocked(tryRouteGroupRumor)
    .mockResolvedValue({ kind: 'not-group' } as Awaited<ReturnType<typeof tryRouteGroupRumor>>);
  const stopB = startLiveDmSubscription(makeParams(knownWrapIdsRef));
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  await flush();
  expect(mockFireNotification).toHaveBeenCalledTimes(1);
  expect(wasWrapHandled(WRAP_ID)).toBe(true);
  stopB();
  await flush();
});
