/** Regression coverage for outgoing echo hydration and in-flight kind-4 replay claims. */
import {
  startLiveDmSubscription as openLiveDmSubscription,
  type LiveDmSubscriptionParams,
} from './nostrLiveDmSub';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { nip04PlaintextCache } from './nostrSecretKeyCache';
import { upsertDmMessages } from '../services/dmDb';
import type { DmInboxEntry } from '../utils/conversationSummaries';

jest.mock('../services/marmotWelcomeRouter', () => ({ routeMarmotWelcome: jest.fn() }));

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
  listPersistedGroupWrapIds: jest.fn(async () => [] as string[]),
}));
jest.mock('./dmStoreMigrationRunner', () => ({
  ensureDmStoreMigrated: jest.fn(async () => {}),
}));

const mockNotifyDm = jest.fn();
jest.mock('./nostrEventBus', () => ({
  notifyDmMessage: (...a: unknown[]) => mockNotifyDm(...a),
}));
const mockFireNotification = jest.fn();
jest.mock('../services/notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireNotification(...a),
}));
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: jest.fn(async () => ({ kind: 'not-group' })),
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

// nsec unwrap returns a handcrafted rumor; partner/text derive from it.
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

const subscriptions = new Set<() => void>();
function startLiveDmSubscription(params: LiveDmSubscriptionParams) {
  const stop = openLiveDmSubscription(params);
  const teardown = () => {
    subscriptions.delete(teardown);
    stop();
  };
  subscriptions.add(teardown);
  return teardown;
}
afterEach(() => {
  for (const stop of subscriptions) stop();
});

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
    setDmInbox: jest.fn(),
    setAmberNip44Permission: jest.fn(),
    followGateBuffer: buffer,
    setDeferredReplay: jest.fn(),
    ...overrides,
  } as LiveDmSubscriptionParams;
}

describe('review hydration and replay claim regressions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(upsertDmMessages).mockReset().mockResolvedValue(undefined);
  });

  it.each([
    ['document', 'https://files.example/report.pdf?token=private', '📎 File'],
    ['text', 'hello Alice', 'hello Alice'],
    ['web link', 'https://example.com/article', 'https://example.com/article'],
  ])(
    'formats kind-4 %s previews while preserving stored content',
    async (_, plaintext, preview) => {
      for (const deferred of [false, true]) {
        jest.clearAllMocks();
        jest.mocked(nip04PlaintextCache.get).mockReturnValue(plaintext);
        const setDmInbox = jest.fn();
        const params = makeParams({
          followPubkeysRef: { current: new Set([ALICE]) },
          followHydratedRef: { current: !deferred },
          setDmInbox,
        });
        const stop = startLiveDmSubscription(params);
        await flush();
        const id = `kind4-preview-${_}-${deferred}`;
        capturedOnEvent!({
          id,
          kind: 4,
          pubkey: ALICE,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['p', VIEWER]],
          content: 'ciphertext',
        });
        await flush();
        if (deferred) {
          expect(setDmInbox).not.toHaveBeenCalled();
          expect(mockFireNotification).not.toHaveBeenCalled();
          params.followHydratedRef!.current = true;
          params.followGateBuffer.reevaluate(
            params.followPubkeysRef.current,
            jest.mocked(params.setDeferredReplay).mock.calls[0][0]!,
          );
          await flush();
        }
        expect(setDmInbox).toHaveBeenCalledTimes(1);
        const update = setDmInbox.mock.calls[0][0] as (prev: DmInboxEntry[]) => DmInboxEntry[];
        expect(update([])).toEqual([expect.objectContaining({ id, text: preview, wireKind: 4 })]);
        expect(mockFireNotification).toHaveBeenCalledTimes(1);
        expect(mockFireNotification).toHaveBeenCalledWith(
          expect.objectContaining({ body: preview }),
        );
        expect(upsertDmMessages).toHaveBeenCalledWith([
          expect.objectContaining({ eventId: id, content: plaintext, wireKind: 4 }),
        ]);
        stop();
      }
    },
  );

  it('silently preserves a fresh outgoing wrap to a cached friend until follows hydrate', async () => {
    const params = makeParams({
      followPubkeysRef: { current: new Set([ALICE]) },
      followHydratedRef: { current: false },
    });
    startLiveDmSubscription(params);
    await flush();
    const wrap = {
      id: 'outgoing-echo',
      kind: 1059,
      pubkey: VIEWER,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'sealed',
      rumor: {
        kind: 14,
        created_at: Math.floor(Date.now() / 1000),
        content: 'sent hello',
        partnership: { partnerPubkey: ALICE, fromMe: true },
      },
    };
    capturedOnEvent!(wrap);
    await flush();
    expect(params.followGateBuffer.size).toBe(1);
    expect(upsertDmMessages).not.toHaveBeenCalled();
    params.followHydratedRef!.current = true;
    params.followGateBuffer.reevaluate(
      params.followPubkeysRef.current,
      jest.mocked(params.setDeferredReplay).mock.calls[0][0]!,
    );
    await flush();
    capturedOnEvent!(wrap);
    await flush();
    expect(upsertDmMessages).toHaveBeenCalledTimes(1);
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        eventId: wrap.id,
        fromMe: true,
        sender: VIEWER,
        content: 'sent hello',
      }),
    ]);
    expect(mockNotifyDm).toHaveBeenCalledTimes(1);
    expect(mockFireNotification).not.toHaveBeenCalled();
  });

  it.each(['commit', 'failure', 'teardown'] as const)(
    'claims reopened kind-4 replay before a blocked write, then handles %s',
    async (outcome) => {
      const params = makeParams({ followHydratedRef: { current: false } });
      const stop = startLiveDmSubscription(params);
      await flush();
      jest.mocked(nip04PlaintextCache.get).mockReturnValue('legacy hello');
      const message = {
        id: 'reopened-kind4',
        kind: 4,
        pubkey: ALICE,
        created_at: 100,
        tags: [['p', VIEWER]],
        content: 'ciphertext',
      };
      capturedOnEvent!(message);
      await flush();
      expect(params.followGateBuffer.size).toBe(1);
      stop();
      params.followPubkeysRef.current.add(ALICE);
      params.followHydratedRef!.current = true;
      let commit!: () => void;
      let fail!: (error: Error) => void;
      jest.mocked(upsertDmMessages).mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            commit = resolve;
            fail = reject;
          }),
      );
      const stopReplay = startLiveDmSubscription(params);
      params.followGateBuffer.reevaluate(
        params.followPubkeysRef.current,
        jest.mocked(params.setDeferredReplay).mock.calls.at(-1)![0]!,
      );
      await flush();
      capturedOnEvent!(message);
      await flush();
      expect(upsertDmMessages).toHaveBeenCalledTimes(1);
      expect(mockNotifyDm).not.toHaveBeenCalled();
      expect(params.knownWrapIdsRef.current.set.has(message.id)).toBe(true);
      if (outcome === 'teardown') {
        stopReplay();
        expect(params.knownWrapIdsRef.current.set.has(message.id)).toBe(false);
        fail(new Error('cancelled write'));
      } else if (outcome === 'failure') {
        fail(new Error('disk unavailable'));
      } else commit();
      await flush();
      if (outcome === 'commit') {
        capturedOnEvent!(message);
        await flush();
        expect(upsertDmMessages).toHaveBeenCalledTimes(1);
        expect(mockNotifyDm).toHaveBeenCalledTimes(1);
      } else {
        expect(params.knownWrapIdsRef.current.set.has(message.id)).toBe(false);
        // Retry in the same subscription after failure, or reopen after teardown.
        if (outcome === 'teardown') startLiveDmSubscription(params);
        await flush();
        capturedOnEvent!(message);
        await flush();
        expect(upsertDmMessages).toHaveBeenCalledTimes(2);
        expect(mockNotifyDm).toHaveBeenCalledTimes(1);
      }
      expect(mockFireNotification).not.toHaveBeenCalled();
    },
  );
});
