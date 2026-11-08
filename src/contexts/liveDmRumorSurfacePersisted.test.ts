// #1759 review: the inbox fetch's pre-parse skip must only cover ids that were
// actually stored. A wrap the follow gate dropped stays claimed in
// knownWrapIds (live redelivery dedupe) but must never count as persisted.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { knownInboxEvent, persistedInboxIds, type KnownWrapIdsState } from './knownInboxEvent';
import { upsertDmMessages } from '../services/dmDb';
import { __resetForTests } from '../services/dmWrapNotificationDedupe';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notification'),
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));
jest.mock('../services/dmDb', () => ({ upsertDmMessages: jest.fn().mockResolvedValue(undefined) }));
jest.mock('./nostrEventBus', () => ({ notifyDmMessage: jest.fn() }));
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: jest.fn().mockResolvedValue({ kind: 'not-group' }),
}));
jest.mock('../services/marmotWelcomeRouter', () => ({ routeMarmotWelcome: jest.fn() }));
jest.mock('../services/nostrCrypto', () => ({
  nip44DecryptFrom: jest.fn(),
  nostrGetEventHash: () => 'rumor-id',
}));

const OWNER = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);

function surfacer(ref: { current: KnownWrapIdsState }, follows: Set<string>) {
  const writes: Promise<void>[] = [];
  const surface = createLiveRumorSurfacer({
    viewerPubkey: OWNER,
    isCancelled: () => false,
    shouldAbort: () => false,
    isFollowHydrated: () => true,
    isFollowCacheReady: () => true,
    followPubkeysRef: { current: follows },
    followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
    isFreshArrival: () => false,
    queueInboxEntry: jest.fn(),
    knownWrapIds: ref.current.set,
    persistedIds: persistedInboxIds(ref),
    seen: new Set(),
    chainWrite: (task) => {
      writes.push(task());
    },
  });
  const rumor = (from: string) => ({
    pubkey: from,
    kind: 14,
    content: 'hello',
    tags: [['p', OWNER]],
    created_at: Math.floor(Date.now() / 1000) - 3600,
  });
  return { surface, rumor, settle: () => Promise.all(writes) };
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  __resetForTests();
});

test('a follow-gated drop is never persisted, so a later refresh still fetches it', async () => {
  const ref = { current: { pubkey: OWNER, set: new Set<string>() } as KnownWrapIdsState };
  const { surface, rumor, settle } = surfacer(ref, new Set());
  // The live sub claimed the wrap before decrypting it.
  ref.current.set.add('stranger-wrap');
  await surface(rumor(STRANGER), 'stranger-wrap');
  await settle();
  expect(upsertDmMessages).not.toHaveBeenCalled();
  expect(ref.current.set.has('stranger-wrap')).toBe(true); // live dedupe keeps it
  expect(knownInboxEvent(ref, OWNER)('stranger-wrap')).toBe(false); // fetch must not skip it
});

test('a stored wrap is persisted and skipped by the fetch', async () => {
  const ref = { current: { pubkey: OWNER, set: new Set<string>() } as KnownWrapIdsState };
  const { surface, rumor, settle } = surfacer(ref, new Set([FRIEND]));
  await surface(rumor(FRIEND), 'friend-wrap');
  await settle();
  expect(upsertDmMessages).toHaveBeenCalledTimes(1);
  expect(knownInboxEvent(ref, OWNER)('friend-wrap')).toBe(true);
  // Another account's state never counts.
  expect(knownInboxEvent(ref, STRANGER)('friend-wrap')).toBe(false);
});

test('a failed store write is not persisted', async () => {
  jest.mocked(upsertDmMessages).mockRejectedValueOnce(new Error('disk full'));
  const ref = { current: { pubkey: OWNER, set: new Set<string>() } as KnownWrapIdsState };
  const { surface, rumor, settle } = surfacer(ref, new Set([FRIEND]));
  await surface(rumor(FRIEND), 'friend-wrap');
  await expect(settle()).rejects.toThrow('disk full');
  expect(knownInboxEvent(ref, OWNER)('friend-wrap')).toBe(false);
});
