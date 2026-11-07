// The live DM sub publishes its wrap-id index to the background watch in the
// same JS context, so the watch skips wraps the sub already has instead of
// decrypting them a second time. The index must cover stored wraps and wraps
// the sub takes in live, and must go away with the sub.
import { startLiveDmSubscription, type LiveDmSubscriptionParams } from './nostrLiveDmSub';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import {
  isLiveDmSubArmed,
  liveDmSubHasWrap,
  __resetForTests as __resetDedupeForTests,
} from '../services/dmWrapNotificationDedupe';

jest.mock('../services/marmotWelcomeRouter', () => ({ routeMarmotWelcome: jest.fn() }));

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
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: jest.fn(),
  isThreadActivelyViewed: () => false,
}));
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: jest.fn(async () => ({ kind: 'not-group' })),
}));
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

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function makeParams(stored: string[]): LiveDmSubscriptionParams {
  return {
    viewerPubkey: VIEWER,
    activeSigner: 'nsec',
    pubkey: VIEWER,
    signerType: 'nsec',
    readRelays: ['wss://relay.example'],
    knownWrapIdsRef: { current: { pubkey: VIEWER, set: new Set<string>(stored) } },
    followPubkeysRef: { current: new Set([ALICE]) },
    followHydratedRef: { current: true },
    setDmInbox: jest.fn(),
    setAmberNip44Permission: jest.fn(),
    followGateBuffer: createLiveSubFollowGateBuffer(),
    setDeferredReplay: jest.fn(),
  } as LiveDmSubscriptionParams;
}

beforeEach(() => {
  jest.clearAllMocks();
  __resetDedupeForTests();
  capturedOnEvent = null;
});

it('exposes stored and live-taken wraps to the background watch while armed', async () => {
  const stop = startLiveDmSubscription(makeParams(['stored-wrap']));
  await flush();
  expect(isLiveDmSubArmed()).toBe(true);
  expect(liveDmSubHasWrap('stored-wrap')).toBe(true);
  expect(liveDmSubHasWrap('fresh-wrap')).toBe(false);

  capturedOnEvent!({
    id: 'fresh-wrap',
    kind: 1059,
    pubkey: 'e'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', VIEWER]],
    content: 'ciphertext',
    rumor: {
      id: 'rumor-1',
      kind: 14,
      pubkey: ALICE,
      created_at: Math.floor(Date.now() / 1000),
      content: 'hello',
      tags: [['p', VIEWER]],
      partnership: { partnerPubkey: ALICE, fromMe: false },
    },
  });
  expect(liveDmSubHasWrap('fresh-wrap')).toBe(true);

  stop();
  // Torn down: the watch must handle every wrap itself again.
  expect(isLiveDmSubArmed()).toBe(false);
  expect(liveDmSubHasWrap('stored-wrap')).toBe(false);
  expect(liveDmSubHasWrap('fresh-wrap')).toBe(false);
  await flush();
});
