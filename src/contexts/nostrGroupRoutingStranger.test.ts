// A stranger must not START a room past the follow gate (#1830): a
// subject-tagged rumor to several people from someone the viewer doesn't
// follow creates no group, stores nothing and raises no alert. A room the
// viewer is already in keeps reaching them from every member. Real router,
// surfacer, batch ingest and follow-gate buffer — only storage is mocked.
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { ingestInboxWraps } from './dmWrapIngest';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { GROUPS_LOAD_WAIT_MS } from './nostrGroupRouting';
import {
  setKnownGroups,
  setSyntheticGroupReconciler,
  type SyntheticRoomInput,
} from '../services/groupRoutingRegistry';
import { appendGroupMessage } from '../services/groupMessagesStorageService';
import { upsertDmMessages } from '../services/dmDb';
import { fireMessageNotification } from '../services/notificationService';
import { notifyDroppedDeferred } from './liveDmAudienceNotify';
import {
  __resetNotificationAudiences,
  publishNotificationAudience,
} from '../services/notificationAudience';
import {
  __resetAccountSettingsCacheForTests,
  rememberAccountSetting,
} from '../services/accountSettingsCache';
import { WOT_STORAGE_KEY_BASE } from '../services/wotSettingsService';
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
const mockSkipSet = new Set<string>();
jest.mock('./nostrDmCache', () => ({
  loadNip17SkipSet: jest.fn(async () => new Set(mockSkipSet)),
  writeNip17SkipSet: jest.fn(async (_key: string, ids: Set<string>) => {
    mockSkipSet.clear();
    for (const id of ids) mockSkipSet.add(id);
  }),
}));
const mockReplied = new Set<string>();
jest.mock('../services/dmRepliedPartners', () => ({
  ...jest.requireActual('../services/dmRepliedPartners'),
  hasRepliedTo: (_owner: string, pk: string) => mockReplied.has(pk.toLowerCase()),
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

const KNOWN: Group = {
  id: 'known',
  name: 'Known',
  memberPubkeys: [STRANGER, FRIEND],
  createdAt: 1,
  updatedAt: 1,
};
const listTier = (wotTier: 'friends' | 'all') =>
  rememberAccountSetting(WOT_STORAGE_KEY_BASE, ME, JSON.stringify({ wotTier, explicit: true }));

beforeEach(() => {
  jest.clearAllMocks();
  mockSkipSet.clear();
  mockReplied.clear();
  __resetAccountSettingsCacheForTests();
  __resetNotificationAudiences();
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
    // The live sub's real drop path, under a tier that lets anyone notify:
    // a room chat (it carries a subject) still raises no 1:1 alert.
    publishNotificationAudience(ME, { tier: 'all', fof: null });
    buffer.clear((item) => notifyDroppedDeferred(ME, item));
    expectNothingStored();
  });

  it('someone the viewer replied to may start a room', async () => {
    mockReplied.add(STRANGER);
    const { surface } = liveSurfacer(new Set(), () => true);
    await surface(roomRumor(STRANGER), 'wrap');
    expect(appendGroupMessage).toHaveBeenCalledTimes(1);
    expect(fireMessageNotification).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['friends', false],
    ['all', true],
  ] as const)(
    'list tier all: a stranger room is created as on refresh; alerts only if the notification tier (%s) admits',
    async (notifyTier, alerted) => {
      listTier('all');
      publishNotificationAudience(ME, { tier: notifyTier, fof: null });
      const { surface } = liveSurfacer(new Set(), () => true);
      await surface(roomRumor(STRANGER), 'wrap');
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(appendGroupMessage).toHaveBeenCalledTimes(1);
      expect(fireMessageNotification).toHaveBeenCalledTimes(alerted ? 1 : 0);
    },
  );

  it('a member of a known room is routed once the stored groups load, not dropped', async () => {
    setKnownGroups([], ME, false);
    const { surface } = liveSurfacer(new Set(), () => true);
    const pending = surface(roomRumor(STRANGER), 'wrap');
    setKnownGroups([KNOWN], ME, true);
    await pending;
    expect(reconcile).not.toHaveBeenCalled();
    expect(appendGroupMessage).toHaveBeenCalledWith(ME, 'known', expect.anything());
    expect(fireMessageNotification).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'known' }),
    );
  });
});

describe('refresh', () => {
  const refresh = (sender: string, opts: { hydrated?: boolean; follows?: string[] } = {}) =>
    ingestInboxWraps({
      owner: ME,
      wraps: [{ id: 'wrap' }],
      unwrap: async () => roomRumor(sender),
      // The Map's refresh (includeNonFollows) and a thread-open pass every
      // pubkey for 1:1 storage; that must not let anyone start a room.
      passesFollowGate: () => true,
      isFollowed: (pk) => (opts.follows ?? [FRIEND]).includes(pk),
      followsHydrated: opts.hydrated ?? true,
      skipKey: 'skip',
      bypassSkipSet: true,
    });

  it.each([
    ['a stranger', STRANGER, false],
    ['a follow', FRIEND, true],
  ])('only a followed sender starts a room (%s)', async (_label, sender, created) => {
    const result = await refresh(sender);
    // Never misfiled as a 1:1 with the follow it names.
    expect(result.stored).toBe(0);
    expect(result.entries).toEqual([]);
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(reconcile).toHaveBeenCalledTimes(created ? 1 : 0);
    expect(appendGroupMessage).toHaveBeenCalledTimes(created ? 1 : 0);
    // A hydrated stranger is skip-set like an unfollowed 1:1 sender.
    expect(mockSkipSet.has('wrap')).toBe(true);
  });

  it('a stranger two-party room chat stays a 1:1 row, never a group', async () => {
    const rumor = {
      ...roomRumor(STRANGER),
      tags: [
        ['p', ME],
        ['subject', 'Free sats'],
      ],
    };
    const result = await ingestInboxWraps({
      owner: ME,
      wraps: [{ id: 'wrap' }],
      unwrap: async () => rumor,
      passesFollowGate: () => true,
      isFollowed: () => false,
    });
    expect(reconcile).not.toHaveBeenCalled();
    expect(appendGroupMessage).not.toHaveBeenCalled();
    expect(result.entries).toEqual([expect.objectContaining({ partnerPubkey: STRANGER })]);
  });

  it('before follows load, a held room is left for a later refresh (not skip-set)', async () => {
    await refresh(FRIEND, { hydrated: false, follows: [] });
    expect(reconcile).not.toHaveBeenCalled();
    expect(mockSkipSet.has('wrap')).toBe(false);
    await refresh(FRIEND);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(appendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it('while stored groups never load, a held room is not skip-set', async () => {
    jest.useFakeTimers();
    try {
      setKnownGroups([], ME, false);
      const pending = refresh(STRANGER);
      await jest.advanceTimersByTimeAsync(GROUPS_LOAD_WAIT_MS);
      await pending;
    } finally {
      jest.useRealTimers();
    }
    expect(appendGroupMessage).not.toHaveBeenCalled();
    expect(mockSkipSet.has('wrap')).toBe(false);
  });

  it('tier all: a stranger may start a room, as a 1:1 stranger is stored', async () => {
    listTier('all');
    await refresh(STRANGER);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(appendGroupMessage).toHaveBeenCalledTimes(1);
  });
});
