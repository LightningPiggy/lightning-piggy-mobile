import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { createLiveRumorSurfacer, type LiveRumorSurfaceDeps } from './liveDmRumorSurface';
import { upsertDmMessages } from '../services/dmDb';
import { notifyDmMessage } from './nostrEventBus';
import { listNotifications } from '../services/notificationHistory';
import { __resetForTests, wasWrapHandled } from '../services/dmWrapNotificationDedupe';

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
const peer = 'b'.repeat(64);
const target = '1'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);

function setup(over: Partial<LiveRumorSurfaceDeps> = {}) {
  const queueInboxEntry = jest.fn();
  const writes: Promise<void>[] = [];
  const deps: LiveRumorSurfaceDeps = {
    viewerPubkey: owner,
    isCancelled: () => false,
    shouldAbort: () => false,
    isFollowHydrated: () => true,
    followPubkeysRef: { current: new Set([peer]) },
    followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
    isFreshArrival: () => true,
    queueInboxEntry,
    knownWrapIds: new Set(),
    seen: new Set(),
    chainWrite: (task) => {
      writes.push(task());
    },
    ...over,
  };
  const surface = createLiveRumorSurfacer(deps);
  return { surface, deps, queueInboxEntry, settle: async () => {
    await Promise.all(writes);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } }; // prettier-ignore
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  __resetForTests();
});

it('stores a wrapped reaction for its thread without an inbox entry or alert (#1321)', async () => {
  const { surface, deps, queueInboxEntry, settle } = setup();
  await surface(
    {
      pubkey: peer,
      kind: 7,
      content: '🎉',
      tags: [
        ['e', target],
        ['p', owner],
        ['k', '14'],
      ],
      created_at: now(),
    },
    'reaction-wrap',
  );
  await settle();

  expect(upsertDmMessages).toHaveBeenCalledWith([
    expect.objectContaining({
      owner,
      eventId: 'reaction-wrap',
      conversation: peer,
      sender: peer,
      wireKind: 7,
      rumorId: 'rumor-id',
      content: JSON.stringify({
        content: '🎉',
        tags: [
          ['e', target],
          ['p', owner],
          ['k', '14'],
        ],
      }),
    }),
  ]);
  expect(deps.knownWrapIds.has('reaction-wrap')).toBe(true);
  expect(queueInboxEntry).not.toHaveBeenCalled();
  expect(notifyDmMessage).not.toHaveBeenCalled();
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
  expect(await listNotifications(owner)).toEqual([]);
  // Handled: the background sync must not ping for it either.
  expect(wasWrapHandled('reaction-wrap')).toBe(true);
});

it('keeps the rumor id on a received message so it can be reacted to (#1320)', async () => {
  const { surface, queueInboxEntry, settle } = setup();
  await surface(
    { pubkey: peer, kind: 14, content: 'hi', tags: [['p', owner]], created_at: now() },
    'message-wrap',
  );
  await settle();

  expect(upsertDmMessages).toHaveBeenCalledWith([
    expect.objectContaining({ eventId: 'message-wrap', fromMe: false, rumorId: 'rumor-id' }),
  ]);
  expect(queueInboxEntry).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'message-wrap', rumorId: 'rumor-id' }),
  );
});

it('defers a reaction before follows load so it replays as a reaction, silently', async () => {
  const defer = jest.fn();
  const { surface, queueInboxEntry, settle } = setup({
    isFollowHydrated: () => false,
    followPubkeysRef: { current: new Set() },
    followGateBuffer: { defer, reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
  });
  const rumor = {
    pubkey: peer,
    kind: 7,
    content: '👍',
    tags: [['e', target]],
    created_at: now(),
  };
  await surface(rumor, 'deferred-wrap');
  await settle();

  expect(defer).toHaveBeenCalledTimes(1);
  const item = defer.mock.calls[0][0];
  // The replay runs the whole surface path again (like a group rumor), so it
  // takes the reaction branch instead of being queued as a message.
  expect(item.groupRumor).toBe(rumor);
  expect(item.notify).toBeUndefined();
  expect(upsertDmMessages).not.toHaveBeenCalled();
  expect(queueInboxEntry).not.toHaveBeenCalled();
});
