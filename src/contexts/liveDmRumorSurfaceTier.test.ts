// Live NIP-17 path: notifications follow the Web of Trust tier, storage keeps
// the follow gate.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { upsertDmMessages } from '../services/dmDb';
import { tryRouteGroupRumor } from './nostrGroupRouting';
import { toggleMutedSender } from '../services/mutedSenders';
import { listNotifications } from '../services/notificationHistory';
import { __resetForTests } from '../services/dmWrapNotificationDedupe';
import {
  __resetNotificationAudiences,
  publishNotificationAudience,
  unpublishNotificationAudience,
  type NotificationAudience,
} from '../services/notificationAudience';
import type { WotTier } from '../services/wotSettingsService';

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
jest.mock('../services/dmRepliedPartners', () => ({ hasRepliedTo: () => false }));

const owner = 'a'.repeat(64);
const friend = 'b'.repeat(64);
const fof = 'c'.repeat(64);
const stranger = 'd'.repeat(64);

const audience = (tier: WotTier, set: string[] | null = [fof]): NotificationAudience => ({
  tier,
  fof: tier === 'fof' && set ? new Set(set) : null,
});

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  __resetForTests();
  __resetNotificationAudiences();
});

function makeSurface(isFresh = true) {
  const queueInboxEntry = jest.fn();
  const writes: Promise<void>[] = [];
  const surface = createLiveRumorSurfacer({
    viewerPubkey: owner,
    isCancelled: () => false,
    shouldAbort: () => false,
    isFollowHydrated: () => true,
    followPubkeysRef: { current: new Set([friend]) },
    followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
    isFreshArrival: () => isFresh,
    queueInboxEntry,
    knownWrapIds: new Set(),
    seen: new Set(),
    chainWrite: (task) => {
      writes.push(task());
    },
  });
  const receive = async (from: string, wrapId: string, kind = 14) => {
    await surface(
      {
        pubkey: from,
        kind,
        content: `hi from ${from.slice(0, 1)}`,
        tags: [['p', owner]],
        created_at: Math.floor(Date.now() / 1000),
      },
      wrapId,
    );
    await Promise.all(writes);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { receive, queueInboxEntry };
}

const notifiedPartners = async () =>
  (await listNotifications(owner)).map((n) => n.data?.conversationPubkey);

describe.each<[WotTier | 'unpublished', string[]]>([
  ['unpublished', [friend]],
  ['friends', [friend]],
  ['fof', [friend, fof]],
  ['all', [friend, fof, stranger]],
])('tier %s', (tier, expected) => {
  it('notifies exactly the senders the tier admits, but stores only the friend', async () => {
    if (tier !== 'unpublished') publishNotificationAudience(owner, audience(tier));
    const { receive, queueInboxEntry } = makeSurface();
    await receive(friend, 'w-friend');
    await receive(fof, 'w-fof');
    await receive(stranger, 'w-stranger');

    expect((await notifiedPartners()).sort()).toEqual([...expected].sort());
    // Storage and the Messages list keep the follow gate, whatever the tier.
    expect(upsertDmMessages).toHaveBeenCalledTimes(1);
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: 'w-friend', conversation: friend }),
    ]);
    expect(queueInboxEntry).toHaveBeenCalledTimes(1);
  });
});

it('friends of friends with no cached set notifies follows only', async () => {
  publishNotificationAudience(owner, audience('fof', null));
  const { receive } = makeSurface();
  await receive(fof, 'w-fof');
  await receive(stranger, 'w-stranger');
  expect(await notifiedPartners()).toEqual([]);
});

it('a tier change applies to the next message without re-opening the sub', async () => {
  publishNotificationAudience(owner, audience('friends'));
  const { receive } = makeSurface();
  await receive(stranger, 'w-1');
  expect(await notifiedPartners()).toEqual([]);
  publishNotificationAudience(owner, audience('all'));
  await receive(stranger, 'w-2');
  expect(await notifiedPartners()).toEqual([stranger]);
  unpublishNotificationAudience(owner);
  await receive(stranger, 'w-3');
  expect(await notifiedPartners()).toHaveLength(1);
});

it('a muted sender never notifies, even under All', async () => {
  publishNotificationAudience(owner, audience('all'));
  await toggleMutedSender(owner, stranger);
  const { receive } = makeSurface();
  await receive(stranger, 'w-muted');
  expect(await listNotifications(owner)).toEqual([]);
  expect(Notifications.scheduleNotificationAsync).not.toHaveBeenCalled();
});

it('stays silent for backlog, reactions, a redelivery and an unplaced two-party room chat', async () => {
  publishNotificationAudience(owner, audience('all'));
  await makeSurface(false).receive(stranger, 'w-old');
  const { receive } = makeSurface();
  await receive(stranger, 'w-reaction', 7);
  await receive(stranger, 'w-once');
  await receive(stranger, 'w-once');
  jest.mocked(tryRouteGroupRumor).mockResolvedValueOnce({
    kind: 'not-group',
    deferredGroupRumor: { pubkey: stranger, kind: 14, content: 'x', tags: [], created_at: 0 },
  });
  await receive(stranger, 'w-room');
  const history = await listNotifications(owner);
  expect(history.map((n) => n.data?.messageId)).toEqual(['w-once']);
});
