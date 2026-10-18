import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { upsertDmMessages } from '../services/dmDb';
import { notifyDmMessage } from './nostrEventBus';
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
const owner = 'a'.repeat(64);
const replied = 'b'.repeat(64);
const stranger = 'c'.repeat(64);
jest.mock('../services/dmRepliedPartners', () => ({
  hasRepliedTo: (o: string, p: string) => o === 'a'.repeat(64) && p === 'b'.repeat(64),
}));

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  __resetForTests();
});

it('surfaces a non-followed partner we replied to, and still drops a stranger (#1623)', async () => {
  const queueInboxEntry = jest.fn();
  const writes: Promise<void>[] = [];
  const surface = createLiveRumorSurfacer({
    viewerPubkey: owner,
    isCancelled: () => false,
    shouldAbort: () => false,
    isFollowHydrated: () => true,
    followPubkeysRef: { current: new Set() },
    followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
    isFreshArrival: () => true,
    queueInboxEntry,
    knownWrapIds: new Set(),
    seen: new Set(),
    chainWrite: (task) => {
      writes.push(task());
    },
  });
  const at = Math.floor(Date.now() / 1000);
  await surface(
    { pubkey: replied, kind: 14, content: 'Hi', tags: [['p', owner]], created_at: at },
    'w1',
  );
  await surface(
    { pubkey: stranger, kind: 14, content: 'spam', tags: [['p', owner]], created_at: at },
    'w2',
  );
  await Promise.all(writes);

  expect(upsertDmMessages).toHaveBeenCalledTimes(1);
  expect(upsertDmMessages).toHaveBeenCalledWith([
    expect.objectContaining({ eventId: 'w1', conversation: replied }),
  ]);
  expect(queueInboxEntry).toHaveBeenCalledWith(expect.objectContaining({ partnerPubkey: replied }));
  expect(notifyDmMessage).toHaveBeenCalledWith(replied);
  expect(notifyDmMessage).not.toHaveBeenCalledWith(stranger);
});
