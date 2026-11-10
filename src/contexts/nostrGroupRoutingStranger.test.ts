// A stranger must not START a room past the follow gate (#1830): a
// subject-tagged rumor to several people from someone the viewer doesn't
// follow creates no group, stores nothing and raises no alert. A room the
// viewer is already in keeps reaching them from every member. Real router,
// surfacer, batch ingest and follow-gate buffer — only storage is mocked.
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { ingestInboxWraps } from './dmWrapIngest';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import {
  setKnownGroups,
  setSyntheticGroupReconciler,
  type SyntheticRoomInput,
} from '../services/groupRoutingRegistry';
import { appendGroupMessage } from '../services/groupMessagesStorageService';
import { upsertDmMessages } from '../services/dmDb';
import { fireMessageNotification } from '../services/notificationService';
import type { DecodedRumor } from '../utils/nip17Unwrap';
import type { Group } from '../types/groups';

jest.mock('../services/groupMessagesStorageService', () => ({ appendGroupMessage: jest.fn() }));
jest.mock('../services/dmDb', () => ({
  selectKnownEventIds: jest.fn(async () => new Set()),
  upsertDmMessages: jest.fn(async () => undefined),
}));
jest.mock('../services/marmotWelcomeRouter', () => ({ routeMarmotWelcome: jest.fn() }));
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: jest.fn(async () => 'notification'),
  isThreadActivelyViewed: jest.fn(() => false),
}));
jest.mock('../services/dmWrapNotificationDedupe', () => ({
  claimWrapNotification: jest.fn(() => true),
  markWrapHandled: jest.fn(),
  takeContentlessWrapAlert: jest.fn(),
  noteContentlessWrapAlert: jest.fn(),
  noteWrapStored: jest.fn(),
}));
jest.mock('./nostrEventBus', () => ({
  notifyDmMessage: jest.fn(),
  notifyGroupMessage: jest.fn(),
}));
jest.mock('../services/nostrCrypto', () => ({
  nip44DecryptFrom: jest.fn(),
  nostrGetEventHash: () => 'rumor-id',
}));

const ME = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const FRIEND = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

const roomRumor = (sender: string): DecodedRumor => ({
  pubkey: sender,
  created_at: 20,
  kind: 14,
  // The stranger names a follow of the viewer as a member.
  tags: [
    ['p', ME],
    ['p', sender === FRIEND ? OTHER : FRIEND],
    ['subject', 'Free sats'],
  ],
  content: 'hello',
});

const reconcile = jest.fn(
  async (input: SyntheticRoomInput): Promise<Group> => ({
    id: input.groupId,
    name: input.name,
    memberPubkeys: input.memberPubkeys,
    createdAt: 1,
    updatedAt: 1,
  }),
);

function liveSurfacer(follows: Set<string>, hydrated: () => boolean) {
  const buffer = createLiveSubFollowGateBuffer();
  const queueInboxEntry = jest.fn();
  const surface = createLiveRumorSurfacer({
    viewerPubkey: ME,
    isCancelled: () => false,
    shouldAbort: () => false,
    followPubkeysRef: { current: follows },
    followGateBuffer: buffer,
    isFollowHydrated: hydrated,
    isFreshArrival: () => true,
    queueInboxEntry,
    knownWrapIds: new Set(),
    seen: new Set(),
    chainWrite: (task) => void task(),
  });
  return { surface, buffer, queueInboxEntry };
}

const expectNothingStored = () => {
  expect(reconcile).not.toHaveBeenCalled();
  expect(appendGroupMessage).not.toHaveBeenCalled();
  expect(upsertDmMessages).not.toHaveBeenCalled();
  expect(fireMessageNotification).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  setKnownGroups([], ME);
  setSyntheticGroupReconciler(reconcile, ME);
});
afterEach(() => {
  setKnownGroups([]);
  setSyntheticGroupReconciler(null);
});

describe('live', () => {
  it('a stranger starting a room: no group, no stored message, no alert', async () => {
    const { surface, buffer, queueInboxEntry } = liveSurfacer(new Set([FRIEND]), () => true);
    await surface(roomRumor(STRANGER), 'wrap');
    expectNothingStored();
    expect(queueInboxEntry).not.toHaveBeenCalled();
    expect(buffer.size).toBe(0);
  });

  it('a followed sender starting a room: group created, stored and alerted', async () => {
    const { surface } = liveSurfacer(new Set([FRIEND]), () => true);
    await surface(roomRumor(FRIEND), 'wrap');
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(appendGroupMessage).toHaveBeenCalledTimes(1);
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(fireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'group', title: 'Free sats' }),
    );
  });

  it('the viewer starting a room from another device is not gated', async () => {
    const { surface } = liveSurfacer(new Set(), () => true);
    await surface(
      {
        ...roomRumor(ME),
        tags: [
          ['p', OTHER],
          ['p', STRANGER],
          ['subject', 'Ours'],
        ],
      },
      'w',
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(appendGroupMessage).toHaveBeenCalledTimes(1);
    expect(fireMessageNotification).not.toHaveBeenCalled(); // own message
  });

  it('a stranger in a room the viewer is already in still reaches them', async () => {
    setKnownGroups(
      [
        {
          id: 'known',
          name: 'Known',
          memberPubkeys: [STRANGER, FRIEND],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      ME,
    );
    const { surface } = liveSurfacer(new Set(), () => true);
    await surface(roomRumor(STRANGER), 'wrap');
    expect(appendGroupMessage).toHaveBeenCalledWith(
      ME,
      'known',
      expect.objectContaining({ senderPubkey: STRANGER }),
    );
    expect(fireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'group', threadId: 'known' }),
    );
  });

  it('holds a room started before follows load, then routes it once the sender is followed', async () => {
    const follows = new Set<string>();
    let hydrated = false;
    const { surface, buffer } = liveSurfacer(follows, () => hydrated);
    await surface(roomRumor(FRIEND), 'wrap');
    expectNothingStored();
    expect(buffer.size).toBe(1);

    follows.add(FRIEND);
    hydrated = true;
    const replays: Promise<void>[] = [];
    buffer.reevaluate(follows, (item) => replays.push(surface(item.groupRumor!, item.entry.id)));
    await Promise.all(replays);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(appendGroupMessage).toHaveBeenCalledTimes(1);
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(fireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'group', title: 'Free sats' }),
    );
  });

  it('a held stranger is dropped at reconciliation without an alert', async () => {
    let hydrated = false;
    const { surface, buffer } = liveSurfacer(new Set(), () => hydrated);
    await surface(roomRumor(STRANGER), 'wrap');
    hydrated = true;
    buffer.reevaluate(new Set([FRIEND]), () => {
      throw new Error('a stranger must not pass');
    });
    buffer.clear();
    expectNothingStored();
  });
});

describe('refresh', () => {
  it.each([
    ['a stranger', STRANGER, false],
    ['a follow', FRIEND, true],
  ])('only a followed sender starts a room (%s)', async (_label, sender, created) => {
    const result = await ingestInboxWraps({
      owner: ME,
      wraps: [{ id: 'wrap' }],
      unwrap: async () => roomRumor(sender),
      passesFollowGate: (pk) => pk === FRIEND,
    });
    // Never misfiled as a 1:1 with the follow it names.
    expect(result.stored).toBe(0);
    expect(result.entries).toEqual([]);
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(created ? 1 : 0);
    expect(appendGroupMessage).toHaveBeenCalledTimes(created ? 1 : 0);
  });
});
