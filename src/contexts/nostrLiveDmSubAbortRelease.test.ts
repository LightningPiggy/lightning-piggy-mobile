// A live sub torn down while it is still deciding a wrap (a relay-list change
// re-opens the sub, an account switch, an unmount) must give the wrap back.
// Re-opened subs share the same knownWrapIds set: an orphaned claim would make
// the next sub treat a never-alerted wrap as "already stored" and mark it
// handled, and the background watch then stays silent too.
import { startLiveDmSubscription, type LiveDmSubscriptionParams } from './nostrLiveDmSub';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { tryRouteGroupRumor } from './nostrGroupRouting';
import { upsertDmMessages } from '../services/dmDb';
import {
  claimWrapNotification,
  wasWrapDecided,
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
  subscribeDmStorage: jest.fn(() => () => {}),
  selectRepliedConversations: jest.fn(async () => [] as string[]),
  REPLY_WIRE_KINDS: [14, 15],
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

function freshWrap(id: string = WRAP_ID, fromMe = false) {
  const now = Math.floor(Date.now() / 1000);
  return {
    id,
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
      partnership: { partnerPubkey: ALICE, fromMe },
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

it('un-marks a wrap the re-opened sub took for stored while the torn-down sub still held it', async () => {
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

  // Relay-list change: A is torn down, B opens on the same knownWrapIds and
  // gets the relay's redelivery BEFORE A's abort has given the wrap back.
  stopA();
  const stopB = startLiveDmSubscription(makeParams(knownWrapIdsRef));
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  // A still holds it undecided: B must not take the claim for "stored".
  expect(wasWrapHandled(WRAP_ID)).toBe(false);

  // A resumes, sees it was torn down and gives the wrap back undecided.
  releaseRouting({ kind: 'not-group' });
  await flush();
  expect(knownWrapIdsRef.current.set.has(WRAP_ID)).toBe(false);
  // Nobody alerted, so the background watch must not treat it as handled.
  expect(mockFireNotification).not.toHaveBeenCalled();
  expect(wasWrapHandled(WRAP_ID)).toBe(false);
  stopB();
  await flush();
});

it('leaves a wrap the follow gate holds to the background watch across a re-open, with no second alert', async () => {
  jest
    .mocked(tryRouteGroupRumor)
    .mockResolvedValue({ kind: 'not-group' } as Awaited<ReturnType<typeof tryRouteGroupRumor>>);
  const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
  // Follows not hydrated yet (first login, no follow cache): the gate defers.
  const followGateBuffer = createLiveSubFollowGateBuffer();
  const unhydrated = (): LiveDmSubscriptionParams => ({
    ...makeParams(knownWrapIdsRef),
    followPubkeysRef: { current: new Set<string>() },
    followHydratedRef: { current: false },
    followGateBuffer,
  });

  const stopA = startLiveDmSubscription(unhydrated());
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  expect(followGateBuffer.size).toBe(1);
  expect(wasWrapHandled(WRAP_ID)).toBe(false);

  // Relay-list change: B opens on the same knownWrapIds and gets a redelivery.
  stopA();
  const paramsB = unhydrated();
  const stopB = startLiveDmSubscription(paramsB);
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  // Held, not stored: still the background watch's to alert for.
  expect(wasWrapHandled(WRAP_ID)).toBe(false);
  expect(mockFireNotification).not.toHaveBeenCalled();

  // The watch alerts after its grace (it claims the notification)...
  expect(claimWrapNotification(WRAP_ID)).toBe(true);
  // ...and when follows hydrate later, the replayed deferral doesn't alert again.
  const replay = jest.mocked(paramsB.setDeferredReplay).mock.calls.at(-1)?.[0];
  followGateBuffer.reevaluate(new Set([ALICE]), replay!);
  await flush();
  await flush();
  expect(mockFireNotification).not.toHaveBeenCalled();
  stopB();
  await flush();
});

it('keeps an alerted wrap handled when its store write fails afterwards', async () => {
  jest
    .mocked(tryRouteGroupRumor)
    .mockResolvedValue({ kind: 'not-group' } as Awaited<ReturnType<typeof tryRouteGroupRumor>>);
  jest.mocked(upsertDmMessages).mockRejectedValueOnce(new Error('disk full'));
  const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
  const stop = startLiveDmSubscription(makeParams(knownWrapIdsRef));
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  await flush();
  // Alerted, then the write failed and the wrap was given back for a retry...
  expect(mockFireNotification).toHaveBeenCalledTimes(1);
  expect(knownWrapIdsRef.current.set.has(WRAP_ID)).toBe(false);
  // ...but the alert stands: the background sync must not ping it again.
  expect(wasWrapHandled(WRAP_ID)).toBe(true);
  stop();
  await flush();
});

it('keeps our own sent copy handled when the sub is torn down before storing it', async () => {
  jest
    .mocked(tryRouteGroupRumor)
    .mockResolvedValue({ kind: 'not-group' } as Awaited<ReturnType<typeof tryRouteGroupRumor>>);
  // A backlog on the write chain: the first wrap's store write is still pending.
  let finishFirstWrite: () => void = () => {};
  jest.mocked(upsertDmMessages).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirstWrite = resolve;
      }),
  );
  const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
  const stop = startLiveDmSubscription(makeParams(knownWrapIdsRef));
  await flush();
  capturedOnEvent!(freshWrap('first'));
  await flush();
  capturedOnEvent!(freshWrap('own-echo', true));
  await flush();
  expect(wasWrapHandled('own-echo')).toBe(true); // nothing to see: decided
  // Relay-list change tears the sub down before the echo's store task runs.
  stop();
  finishFirstWrite();
  await flush();
  await flush();
  expect(knownWrapIdsRef.current.set.has('own-echo')).toBe(false);
  // Still decided: no phantom "New message" from the background sync.
  expect(wasWrapHandled('own-echo')).toBe(true);
});

it('marks a follow-gate replay handled once it alerts, so the background sync stays silent', async () => {
  jest
    .mocked(tryRouteGroupRumor)
    .mockResolvedValue({ kind: 'not-group' } as Awaited<ReturnType<typeof tryRouteGroupRumor>>);
  const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
  const followGateBuffer = createLiveSubFollowGateBuffer();
  const params: LiveDmSubscriptionParams = {
    ...makeParams(knownWrapIdsRef),
    followPubkeysRef: { current: new Set<string>() },
    followHydratedRef: { current: false },
    followGateBuffer,
  };
  const stop = startLiveDmSubscription(params);
  await flush();
  capturedOnEvent!(freshWrap());
  await flush();
  expect(followGateBuffer.size).toBe(1);

  const replay = jest.mocked(params.setDeferredReplay).mock.calls.at(-1)?.[0];
  followGateBuffer.reevaluate(new Set([ALICE]), replay!);
  await flush();
  await flush();
  expect(mockFireNotification).toHaveBeenCalledTimes(1);
  expect(wasWrapHandled(WRAP_ID)).toBe(true);
  stop();
  await flush();
});

it('decides a wrap an nsec account cannot decrypt, so the background watch does not retry it', async () => {
  const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
  const stop = startLiveDmSubscription(makeParams(knownWrapIdsRef));
  await flush();
  const { rumor: _rumor, ...undecryptable } = freshWrap('stranger-wrap');
  capturedOnEvent!(undecryptable);
  await flush();
  expect(wasWrapDecided('stranger-wrap')).toBe(true);
  expect(mockFireNotification).not.toHaveBeenCalled();
  stop();
  await flush();
});
