import { startLiveDmSubscription, type LiveDmSubscriptionParams } from './nostrLiveDmSub';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { selectDmWrapIds, upsertDmMessages } from '../services/dmDb';

import { setKnownGroups, setSyntheticGroupReconciler } from '../services/groupRoutingRegistry';
import {
  appendGroupMessage,
  listPersistedGroupWrapIds,
} from '../services/groupMessagesStorageService';
import { notifyGroupMessage } from './nostrEventBus';
import type { DeferredFollowGateEntry } from './liveSubFollowGate';
import { syntheticGroupIdForParticipants } from '../utils/syntheticGroupId';

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
  appendGroupMessage: jest.fn(async () => {}),
  listPersistedGroupWrapIds: jest.fn(async () => [] as string[]),
}));
jest.mock('./dmStoreMigrationRunner', () => ({
  ensureDmStoreMigrated: jest.fn(async () => {}),
}));

const mockNotifyDm = jest.fn();
jest.mock('./nostrEventBus', () => ({
  notifyDmMessage: (...a: unknown[]) => mockNotifyDm(...a),
  notifyGroupMessage: jest.fn(),
}));
const mockFireNotification = jest.fn();
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireNotification(...a),
  isThreadActivelyViewed: jest.fn(() => false),
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

jest.mock('../utils/nip17Unwrap', () => ({
  ...jest.requireActual('../utils/nip17Unwrap'),
  unwrapWrapNsec: (wrap: { rumor?: unknown }) => wrap.rumor ?? null,
}));
jest.mock('../services/nostrCrypto', () => ({
  nip44DecryptFrom: jest.fn(),
  nostrGetEventHash: () => 'rumor-id',
}));
jest.mock('../services/dmWrapNotificationDedupe', () => ({
  claimWrapNotification: jest.fn(() => true),
  markWrapHandled: jest.fn(),
  takeContentlessWrapAlert: jest.fn(),
  noteLiveDmSubArmed: jest.fn(),
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
    followHydratedRef: { current: false },
    setDmInbox: jest.fn(),
    setAmberNip44Permission: jest.fn(),
    followGateBuffer: buffer,
    setDeferredReplay: jest.fn(),
    ...overrides,
  } as LiveDmSubscriptionParams;
}

beforeEach(() => {
  jest.clearAllMocks();
  setKnownGroups([], VIEWER);
});
afterEach(() => {
  setKnownGroups([]);
  setSyntheticGroupReconciler(null);
});

it.each([false, true])(
  'routes a subject-tagged arrival through group storage after follow hydration (teardown=%s)',
  async (teardownBeforeHydration) => {
    const reconcile = jest.fn(async (input) => ({
      id: input.groupId,
      name: input.name,
      memberPubkeys: input.memberPubkeys,
      createdAt: 1,
      updatedAt: 1,
    }));
    setSyntheticGroupReconciler(reconcile, VIEWER);
    const params = makeParams();
    let replay: ((item: DeferredFollowGateEntry) => void) | null = null;
    params.setDeferredReplay = (fn) => {
      replay = fn;
    };
    const stop = startLiveDmSubscription(params);
    await flush();
    const now = Math.floor(Date.now() / 1000);
    capturedOnEvent!({
      id: 'hydrating-group-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'wrapped',
      rumor: {
        pubkey: ALICE,
        kind: 14,
        created_at: now,
        tags: [
          ['p', VIEWER],
          ['subject', 'Family'],
        ],
        content: 'hello while hydrating',
      },
    });
    await flush();
    expect(params.followGateBuffer.size).toBe(1);
    expect(reconcile).not.toHaveBeenCalled();
    expect(appendGroupMessage).not.toHaveBeenCalled();
    expect(params.setDmInbox).not.toHaveBeenCalled();
    expect(mockFireNotification).not.toHaveBeenCalled();
    const registeredReplay = replay!;
    let bufferedItem: DeferredFollowGateEntry | undefined;
    if (teardownBeforeHydration) {
      params.followGateBuffer.reevaluate(new Set([ALICE]), (item) => {
        bufferedItem = item;
      });
      stop();
    }
    params.followPubkeysRef.current = new Set([ALICE]);
    params.followHydratedRef!.current = true;
    params.followGateBuffer.reevaluate(params.followPubkeysRef.current, registeredReplay);
    if (bufferedItem) registeredReplay(bufferedItem);
    await flush();
    expect(params.followGateBuffer.size).toBe(0);
    expect(params.setDmInbox).not.toHaveBeenCalled();
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(mockNotifyDm).not.toHaveBeenCalled();
    if (teardownBeforeHydration) {
      expect(reconcile).not.toHaveBeenCalled();
      expect(appendGroupMessage).not.toHaveBeenCalled();
      expect(notifyGroupMessage).not.toHaveBeenCalled();
      expect(mockFireNotification).not.toHaveBeenCalled();
    } else {
      const groupId = syntheticGroupIdForParticipants([VIEWER, ALICE]);
      const message = {
        id: 'hydrating-group-wrap',
        senderPubkey: ALICE,
        text: 'hello while hydrating',
        createdAt: now,
        wireKind: 14,
      };
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(appendGroupMessage).toHaveBeenCalledWith(VIEWER, groupId, message);
      expect(notifyGroupMessage).toHaveBeenCalledTimes(1);
      expect(notifyGroupMessage).toHaveBeenCalledWith(groupId, message);
      expect(mockFireNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'group',
          threadId: groupId,
          title: 'Family',
          body: message.text,
          data: { groupId, messageId: message.id, senderPubkey: ALICE },
        }),
      );
      params.followGateBuffer.reevaluate(params.followPubkeysRef.current, registeredReplay);
      await flush();
      expect(appendGroupMessage).toHaveBeenCalledTimes(1);
      expect(mockFireNotification).toHaveBeenCalledTimes(1);
      stop();
    }
  },
);

it('replays marked group messages after follows hydrate', async () => {
  let finishReconcile!: () => void;
  const pendingReconcile = new Promise<void>((resolve) => {
    finishReconcile = resolve;
  });
  const reconcile = jest.fn(async (input) => {
    await pendingReconcile;
    return {
      id: input.groupId,
      name: input.name,
      memberPubkeys: input.memberPubkeys,
      createdAt: 1,
      updatedAt: 1,
    };
  });
  setSyntheticGroupReconciler(reconcile, VIEWER);
  const params = makeParams();
  let replay!: (item: DeferredFollowGateEntry) => void;
  params.setDeferredReplay = (fn) => {
    if (fn) replay = fn;
  };
  const stop = startLiveDmSubscription(params);
  await flush();
  const now = Math.floor(Date.now() / 1000);
  const messages = [
    { id: 'room-start', text: 'hello while hydrating', tags: [['subject', 'Family']] },
    { id: 'room-follow-up', text: 'marked follow-up', tags: [['subject', 'Family']] },
  ];
  for (const message of messages) {
    capturedOnEvent!({
      id: message.id,
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'wrapped',
      rumor: {
        pubkey: ALICE,
        kind: 14,
        created_at: now,
        tags: [['p', VIEWER], ...message.tags],
        content: message.text,
      },
    });
    await flush();
  }
  expect(params.followGateBuffer.size).toBe(2);
  expect(reconcile).not.toHaveBeenCalled();
  expect(appendGroupMessage).not.toHaveBeenCalled();
  params.followPubkeysRef.current = new Set([ALICE]);
  params.followHydratedRef!.current = true;
  params.followGateBuffer.reevaluate(params.followPubkeysRef.current, replay);
  await flush();
  // Replay keeps marked group messages out of the DM inbox while reconciling.
  expect(reconcile).toHaveBeenCalledTimes(1);
  expect(params.setDmInbox).not.toHaveBeenCalled();
  expect(mockNotifyDm).not.toHaveBeenCalled();
  expect(mockFireNotification).not.toHaveBeenCalled();
  finishReconcile();
  await flush();
  const groupId = syntheticGroupIdForParticipants([VIEWER, ALICE]);
  expect(appendGroupMessage).toHaveBeenCalledTimes(2);
  expect(notifyGroupMessage).toHaveBeenCalledTimes(2);
  expect(mockFireNotification).toHaveBeenCalledTimes(2);
  messages.forEach((message, index) => {
    const stored = {
      id: message.id,
      senderPubkey: ALICE,
      text: message.text,
      createdAt: now,
      wireKind: 14,
    };
    expect(appendGroupMessage).toHaveBeenNthCalledWith(index + 1, VIEWER, groupId, stored);
    expect(notifyGroupMessage).toHaveBeenNthCalledWith(index + 1, groupId, stored);
    expect(mockFireNotification).toHaveBeenNthCalledWith(
      index + 1,
      expect.objectContaining({ kind: 'group', threadId: groupId, body: message.text }),
    );
  });
  expect(params.setDmInbox).not.toHaveBeenCalled();
  expect(upsertDmMessages).not.toHaveBeenCalled();
  expect(mockNotifyDm).not.toHaveBeenCalled();
  params.followGateBuffer.reevaluate(params.followPubkeysRef.current, replay);
  await flush();
  expect(mockFireNotification).toHaveBeenCalledTimes(2);
  stop();
});

it('keeps a deferred subjectless chat as a DM when hydration establishes no room', async () => {
  const params = makeParams();
  let replay!: (item: DeferredFollowGateEntry) => void;
  params.setDeferredReplay = (fn) => {
    if (fn) replay = fn;
  };
  const stop = startLiveDmSubscription(params);
  await flush();
  const now = Math.floor(Date.now() / 1000);
  capturedOnEvent!({
    id: 'ordinary-dm',
    kind: 1059,
    pubkey: ALICE,
    created_at: now,
    tags: [],
    content: 'wrapped',
    rumor: {
      pubkey: ALICE,
      kind: 14,
      created_at: now,
      tags: [['p', VIEWER]],
      content: 'ordinary chat',
    },
  });
  await flush();
  expect(params.followGateBuffer.size).toBe(1);
  params.followPubkeysRef.current = new Set([ALICE]);
  params.followHydratedRef!.current = true;
  params.followGateBuffer.reevaluate(params.followPubkeysRef.current, replay);
  await flush();
  expect(params.setDmInbox).toHaveBeenCalledTimes(1);
  expect(mockNotifyDm).toHaveBeenCalledWith(ALICE);
  expect(mockFireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'dm', body: 'ordinary chat' }),
  );
  expect(appendGroupMessage).not.toHaveBeenCalled();
  expect(notifyGroupMessage).not.toHaveBeenCalled();
  stop();
});

it('does not reclassify persisted direct or subjectless group rows on live replay', async () => {
  jest.mocked(selectDmWrapIds).mockResolvedValueOnce(['old-direct']);
  jest.mocked(listPersistedGroupWrapIds).mockResolvedValueOnce(['old-group']);
  const params = makeParams();
  const stop = startLiveDmSubscription(params);
  await flush();
  for (const id of ['old-direct', 'old-group']) {
    capturedOnEvent!({
      id,
      kind: 1059,
      pubkey: ALICE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'wrapped',
      rumor: {
        pubkey: ALICE,
        kind: 14,
        created_at: 20,
        tags: [['p', VIEWER]],
        content: 'old history',
      },
    });
  }
  await flush();
  expect(appendGroupMessage).not.toHaveBeenCalled();
  expect(upsertDmMessages).not.toHaveBeenCalled();
  expect(params.setDmInbox).not.toHaveBeenCalled();
  expect(mockNotifyDm).not.toHaveBeenCalled();
  expect(notifyGroupMessage).not.toHaveBeenCalled();
  stop();
});
