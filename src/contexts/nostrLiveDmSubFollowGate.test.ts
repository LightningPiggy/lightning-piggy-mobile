/**
 * Wiring tests for the live-sub follow-gate race + teardown (#851 F2).
 *
 * These exercise `startLiveDmSubscription` with its data-layer boundaries
 * mocked, pinning the three behaviours the #851 fix introduces:
 *
 *  1. Subscription teardown unregisters its replay closure but retains
 *     account-owned deferrals. Identity teardown clears the canonical store.
 *  2. A late live callback that fires AFTER teardown no-ops (doesn't surface
 *     to `setDmInbox`): the live-sub race a wipe-then-resubscribe could hit.
 *  3. A fresh wrap from a not-yet-hydrated (non-followed) partner is buffered
 *     rather than lost; replaying it surfaces the entry.
 */

import {
  startLiveDmSubscription as openLiveDmSubscription,
  type LiveDmSubscriptionParams,
} from './nostrLiveDmSub';
import { act, renderHook } from '@testing-library/react-native';
import { useLiveFollowGate } from './useLiveFollowGate';
import { adoptFollowSnapshot } from '../services/contactFollowFreshness';
import { clearFollowGateStores } from '../services/followSetEvents';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import { createYieldScheduler } from './nostrDecryptPacing';
import { nip04PlaintextCache } from './nostrSecretKeyCache';
import { routeMarmotWelcome } from '../services/marmotWelcomeRouter';
import { upsertDmMessages } from '../services/dmDb';
import { loadLastSeen } from './nostrDmCache';

jest.mock('../services/marmotWelcomeRouter', () => ({
  routeMarmotWelcome: jest.fn(async (rumor: { kind: number }) => rumor.kind === 444),
}));

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

describe('startLiveDmSubscription — follow-gate race + teardown (#851 F2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearFollowGateStores();
    capturedOnEvent = null;
  });

  it.each([true, false])(
    'defers live kind-4 from Middle until reconciliation, then surfaces once (fresh=%s, #1458)',
    async (fresh) => {
      const middle = '4b2fcb4e3c30c1363c4af5e3a6adebfe93cd572c3d57c31aaa4479d908612036';
      const follows = { current: new Set(fresh ? [middle] : [ALICE]) }; // cache alone is not hydration
      const hydrated = { current: false };
      const buffer = createLiveSubFollowGateBuffer();
      const setDeferredReplay = jest.fn();
      const setDmInbox = jest.fn();
      jest.mocked(nip04PlaintextCache.get).mockReturnValue('hello from Middle');
      const teardown = startLiveDmSubscription(
        makeParams({
          followPubkeysRef: follows,
          followHydratedRef: hydrated,
          followGateBuffer: buffer,
          setDeferredReplay,
          setDmInbox,
        } as Partial<LiveDmSubscriptionParams>),
      );
      await flush();
      capturedOnEvent!({
        id: `middle-kind4-${fresh}`,
        kind: 4,
        pubkey: middle,
        created_at: Math.floor(Date.now() / 1000) - (fresh ? 0 : 600),
        tags: [['p', VIEWER]],
        content: 'ciphertext',
      });
      await flush();
      expect(setDmInbox).not.toHaveBeenCalled();
      expect(buffer.size).toBe(1);
      follows.current = new Set([middle]);
      hydrated.current = true;
      const replay = setDeferredReplay.mock.calls[0][0];
      buffer.reevaluate(follows.current, replay);
      buffer.reevaluate(follows.current, replay);
      await flush();
      expect(mockNotifyDm).toHaveBeenCalledTimes(1);
      expect(mockNotifyDm).toHaveBeenCalledWith(middle);
      expect(setDmInbox).toHaveBeenCalledTimes(1);
      teardown();
    },
  );

  it('adoption releases buffered kind-4 and 1059 once despite known ids, then Middle passes (#1458)', async () => {
    const middle = '4b2fcb4e3c30c1363c4af5e3a6adebfe93cd572c3d57c31aaa4479d908612036';
    const { result, unmount } = renderHook(() =>
      useLiveFollowGate(new Set<string>(), false, VIEWER),
    );
    const gate = result.current;
    const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
    const teardown = startLiveDmSubscription(
      makeParams({
        followPubkeysRef: gate.followPubkeysRef,
        followHydratedRef: gate.followHydratedRef,
        followGateBuffer: gate.followGateBufferRef.current,
        setDeferredReplay: (fn) => {
          gate.deferredReplayRef.current = fn;
        },
        knownWrapIdsRef,
      }),
    );
    jest.mocked(nip04PlaintextCache.get).mockReturnValue('Middle plaintext');
    await flush();
    const now = Math.floor(Date.now() / 1000) - 600;
    const kind4 = (id: string) => ({
      id,
      kind: 4,
      pubkey: middle,
      created_at: now,
      tags: [['p', VIEWER]],
      content: 'ciphertext',
    });
    capturedOnEvent!(kind4('buffered-middle'));
    capturedOnEvent!({
      id: 'buffered-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'ciphertext',
      rumor: {
        kind: 14,
        created_at: now,
        content: 'Alice plaintext',
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    await flush();
    expect(gate.followGateBufferRef.current.size).toBe(2);
    expect(mockNotifyDm).not.toHaveBeenCalled();
    knownWrapIdsRef.current.set.add('buffered-middle');
    expect(knownWrapIdsRef.current.set.has('buffered-wrap')).toBe(true);
    const snapshot = {
      createdAt: 1791834639,
      contacts: [middle, ALICE, 'b'.repeat(64)].map((pubkey) => ({
        pubkey,
        relay: null,
        petname: null,
        profile: null,
      })),
    };
    await act(async () => {
      await adoptFollowSnapshot(VIEWER, snapshot);
    });
    await flush();
    expect(mockNotifyDm.mock.calls).toEqual([[middle], [ALICE]]);
    expect(
      jest
        .mocked(upsertDmMessages)
        .mock.calls.flatMap(([rows]) => rows)
        .map(({ eventId, content, wireKind }) => ({ eventId, content, wireKind })),
    ).toEqual([
      { eventId: 'buffered-middle', content: 'Middle plaintext', wireKind: 4 },
      { eventId: 'buffered-wrap', content: 'Alice plaintext', wireKind: 14 },
    ]);
    expect(gate.followGateBufferRef.current.size).toBe(0);
    await act(async () => {
      await adoptFollowSnapshot(VIEWER, snapshot);
    });
    capturedOnEvent!(kind4('buffered-middle'));
    await flush();
    expect(mockNotifyDm).toHaveBeenCalledTimes(2);
    capturedOnEvent!(kind4('middle-after-hydration'));
    await flush();
    expect(mockNotifyDm).toHaveBeenCalledTimes(3);
    expect(mockNotifyDm).toHaveBeenLastCalledWith(middle);
    expect(gate.followGateBufferRef.current.size).toBe(0);
    teardown();
    unmount();
  });

  it('defer 3 → re-open with new hook refs and sub closure → hydrate releases all 3 (#1458)', async () => {
    const first = renderHook(() => useLiveFollowGate(new Set<string>(), false, VIEWER));
    const originalBuffer = first.result.current.followGateBufferRef.current;
    const knownWrapIdsRef = { current: { pubkey: VIEWER, set: new Set<string>() } };
    const open = (gate: ReturnType<typeof useLiveFollowGate>) =>
      startLiveDmSubscription(
        makeParams({
          knownWrapIdsRef,
          followPubkeysRef: gate.followPubkeysRef,
          followHydratedRef: gate.followHydratedRef,
          followGateBuffer: gate.followGateBufferRef.current,
          setDeferredReplay: gate.setDeferredReplay,
        }),
      );
    const stop = open(first.result.current);
    await flush();
    jest.mocked(nip04PlaintextCache.get).mockReturnValue('Alice plaintext');
    const now = Math.floor(Date.now() / 1000) - 600;
    for (const id of ['legacy-1', 'legacy-2'])
      capturedOnEvent!({
        id,
        kind: 4,
        pubkey: ALICE,
        created_at: now,
        tags: [['p', VIEWER]],
        content: 'ciphertext',
      });
    capturedOnEvent!({
      id: 'wrap-3',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'ciphertext',
      rumor: {
        kind: 14,
        created_at: now,
        content: 'Alice plaintext',
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    await flush();
    expect(originalBuffer.size).toBe(3);
    expect(mockNotifyDm).not.toHaveBeenCalled();
    stop();
    first.unmount();
    expect(originalBuffer.size).toBe(3);
    const second = renderHook(() => useLiveFollowGate(new Set<string>(), false, VIEWER));
    expect(second.result.current.followGateBufferRef.current).toBe(originalBuffer);
    const stopSecond = open(second.result.current);
    await flush();
    await act(async () => {
      await adoptFollowSnapshot(VIEWER, {
        createdAt: 1791834639,
        contacts: [{ pubkey: ALICE, relay: null, petname: null, profile: null }],
      });
    });
    await flush();
    expect(mockNotifyDm.mock.calls).toEqual([[ALICE], [ALICE], [ALICE]]);
    expect(
      jest
        .mocked(upsertDmMessages)
        .mock.calls.flatMap(([rows]) => rows)
        .map((row) => row.eventId),
    ).toEqual(['legacy-1', 'legacy-2', 'wrap-3']);
    expect(originalBuffer.size).toBe(0);
    stopSecond();
    second.unmount();
  });

  it('replays on reopening after hydration completed while the subscription was closed', async () => {
    const hook = renderHook(() => useLiveFollowGate(new Set<string>(), false, VIEWER));
    const gate = hook.result.current;
    const params = makeParams({
      followPubkeysRef: gate.followPubkeysRef,
      followHydratedRef: gate.followHydratedRef,
      followGateBuffer: gate.followGateBufferRef.current,
      setDeferredReplay: gate.setDeferredReplay,
    });
    const stop = startLiveDmSubscription(params);
    await flush();
    jest.mocked(nip04PlaintextCache.get).mockReturnValue('Alice plaintext');
    capturedOnEvent!({
      id: 'closed-hydration',
      kind: 4,
      pubkey: ALICE,
      created_at: Math.floor(Date.now() / 1000) - 600,
      tags: [['p', VIEWER]],
      content: 'ciphertext',
    });
    await flush();
    expect(gate.followGateBufferRef.current.size).toBe(1);
    stop();
    await act(async () => {
      await adoptFollowSnapshot(VIEWER, {
        createdAt: 200,
        contacts: [{ pubkey: ALICE, relay: null, petname: null, profile: null }],
      });
    });
    expect(gate.followHydratedRef.current).toBe(true);
    expect(gate.followGateBufferRef.current.size).toBe(1);
    const stopSecond = startLiveDmSubscription(params);
    await flush();
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: 'closed-hydration', content: 'Alice plaintext' }),
    ]);
    expect(mockNotifyDm).toHaveBeenCalledTimes(1);
    expect(params.setDmInbox).toHaveBeenCalledTimes(1);
    expect(gate.followGateBufferRef.current.size).toBe(0);
    stopSecond();
    hook.unmount();
  });

  it('registers a replay hook on open and clears it on teardown', async () => {
    const setDeferredReplay = jest.fn();
    const buffer = createLiveSubFollowGateBuffer();
    const clearSpy = jest.spyOn(buffer, 'clear');

    const teardown = startLiveDmSubscription(
      makeParams({ setDeferredReplay, followGateBuffer: buffer }),
    );
    await flush();

    // Opened: a replay function was registered (non-null).
    expect(setDeferredReplay).toHaveBeenCalledTimes(1);
    expect(typeof setDeferredReplay.mock.calls[0][0]).toBe('function');

    teardown();
    // Relay-list re-opens detach the old closure and preserve pending entries.
    expect(setDeferredReplay).toHaveBeenLastCalledWith(null);
    expect(clearSpy).not.toHaveBeenCalled();
    expect(mockUnsub).toHaveBeenCalledTimes(1);
  });

  it('a late live callback after teardown no-ops (does not surface)', async () => {
    const setDmInbox = jest.fn();
    const followPubkeysRef = { current: new Set<string>([ALICE]) };
    const teardown = startLiveDmSubscription(makeParams({ setDmInbox, followPubkeysRef }));
    await flush();
    expect(capturedOnEvent).toBeTruthy();

    // Wipe / account switch tears the sub down.
    teardown();

    // A wrap the relay streams late (the race window) must be ignored.
    capturedOnEvent!({
      id: 'late-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: 'x',
      rumor: {
        kind: 14,
        created_at: Math.floor(Date.now() / 1000),
        content: 'late hello',
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    await flush();
    expect(setDmInbox).not.toHaveBeenCalled();
    // The `cancelled` guard short-circuits before any surface side-effect.
    expect(mockNotifyDm).not.toHaveBeenCalled();
  });

  it('buffers a fresh wrap from a not-yet-followed partner instead of losing it', async () => {
    const setDmInbox = jest.fn();
    // Follows empty — simulating the post-switch hydration window.
    const followPubkeysRef = { current: new Set<string>() };
    const buffer = createLiveSubFollowGateBuffer();
    let replay: ((item: unknown) => void) | null = null;

    startLiveDmSubscription(
      makeParams({
        setDmInbox,
        followPubkeysRef,
        followGateBuffer: buffer,
        setDeferredReplay: (fn) => {
          replay = fn as ((item: unknown) => void) | null;
        },
      }),
    );
    await flush();

    const now = Math.floor(Date.now() / 1000);
    capturedOnEvent!({
      id: 'wrap-1',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'x',
      rumor: {
        kind: 14,
        created_at: now,
        content: 'hello while hydrating',
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    await flush();

    // Dropped by the follow-gate → buffered, not surfaced yet.
    expect(setDmInbox).not.toHaveBeenCalled();
    expect(buffer.size).toBe(1);

    // Follows hydrate: re-evaluate replays the buffered entry → it surfaces.
    // The inbox setter is debounced (queueInboxEntry batches over ~150 ms),
    // so assert the post-persistence replay signal (notifyDmMessage) + that
    // the buffer drained, which together prove the entry was recovered.
    expect(replay).toBeTruthy();
    mockNotifyDm.mockClear();
    buffer.reevaluate(new Set([ALICE]), replay!);
    await flush();
    expect(mockNotifyDm).toHaveBeenCalledWith(ALICE);
    expect(buffer.size).toBe(0);
  });

  it('persists a bounded incoming order while the unhydrated Messages gate hides its preview', async () => {
    // Order persistence bypasses follow hydration; Messages keeps its gate.
    const followPubkeysRef = { current: new Set<string>() };
    const buffer = createLiveSubFollowGateBuffer();

    const params = makeParams({ followPubkeysRef, followGateBuffer: buffer });
    startLiveDmSubscription(params);
    await flush();

    const now = Math.floor(Date.now() / 1000);
    // textForRumor is mocked to return rumor.content, so feed it canonical
    // order JSON (what the real textForRumor emits for a kind-16 order).
    const orderJson = JSON.stringify({
      kind: 16,
      type: 'order',
      orderId: 'abc-12345678',
      amountSats: 21,
    });
    capturedOnEvent!({
      id: 'order-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'x',
      rumor: {
        pubkey: ALICE,
        kind: 16,
        tags: [
          ['p', VIEWER],
          ['type', '1'],
          ['order', 'abc-12345678'],
          ['amount', '21'],
        ],
        created_at: now,
        content: orderJson,
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    await flush();
    expect(buffer.size).toBe(0);
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ eventId: 'order-wrap', content: orderJson, wireKind: 16 }),
    ]);
    expect(params.setDmInbox).not.toHaveBeenCalled();
    expect(mockNotifyDm).toHaveBeenCalledWith(ALICE);
  });

  it('un-claims a wrap id from knownWrapIds when teardown lands while parked on the yield (Copilot #1039 review)', async () => {
    // knownWrapIds is claimed eagerly (#505) before the per-wrap budget-gated
    // yield. If teardown (relay-list change / logout) lands while a wrap is
    // parked on that yield, the id must NOT be left "known" — knownWrapIdsRef
    // survives this effect's re-runs (same viewer), so an orphaned claim
    // would silently starve every future live-sub instance of a wrap the
    // store never actually received.
    let releaseYield: (() => void) | null = null;
    (createYieldScheduler as jest.Mock).mockReturnValueOnce({
      maybeYield: () => new Promise<void>((resolve) => (releaseYield = resolve)),
      get yieldCount() {
        return 0;
      },
      dispose: jest.fn(),
    });

    const knownWrapIdsRef = { current: { pubkey: null as string | null, set: new Set<string>() } };
    const followPubkeysRef = { current: new Set<string>([ALICE]) };
    const teardown = startLiveDmSubscription(
      makeParams({ knownWrapIdsRef, followPubkeysRef, followHydratedRef: { current: true } }),
    );
    await flush();
    expect(capturedOnEvent).toBeTruthy();

    const now = Math.floor(Date.now() / 1000);
    capturedOnEvent!({
      id: 'parked-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'x',
      rumor: {
        kind: 14,
        created_at: now,
        content: 'hi',
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    // Claimed synchronously, before the (parked) yield.
    expect(knownWrapIdsRef.current.set.has('parked-wrap')).toBe(true);

    // Teardown lands while still parked on the yield.
    teardown();
    releaseYield!();
    await flush();

    expect(knownWrapIdsRef.current.set.has('parked-wrap')).toBe(false);

    // Re-arm: a fresh live-sub instance sharing the same knownWrapIdsRef
    // (relay-list change, same viewer). The relay re-streams the wrap; it
    // must be processed and surfaced this time, not deduped away.
    mockNotifyDm.mockClear();
    startLiveDmSubscription(
      makeParams({ knownWrapIdsRef, followPubkeysRef, followHydratedRef: { current: true } }),
    );
    await flush();
    capturedOnEvent!({
      id: 'parked-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: now,
      tags: [],
      content: 'x',
      rumor: {
        kind: 14,
        created_at: now,
        content: 'hi',
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    });
    await flush();
    expect(mockNotifyDm).toHaveBeenCalledWith(ALICE);
    expect(knownWrapIdsRef.current.set.has('parked-wrap')).toBe(true);
  });
});

describe('review replay delivery regressions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('routes the full Marmot invitation before hydration and deduplicates after reopening', async () => {
    const buffer = createLiveSubFollowGateBuffer();
    const hydrated = { current: false };
    const follows = { current: new Set<string>() };
    const setDeferredReplay = jest.fn();
    const params = makeParams({
      followGateBuffer: buffer,
      followHydratedRef: hydrated,
      followPubkeysRef: follows,
      setDeferredReplay,
    });
    const stop = startLiveDmSubscription(params);
    await flush();
    const rumor = {
      kind: 444,
      pubkey: ALICE,
      created_at: 100,
      tags: [
        ['p', VIEWER],
        ['relays', 'wss://marmot.example'],
      ],
      content: 'welcome',
      partnership: { partnerPubkey: ALICE, fromMe: false },
    };
    const wrap = {
      id: 'welcome-wrap',
      kind: 1059,
      pubkey: ALICE,
      created_at: 100,
      tags: [],
      content: 'sealed',
      rumor,
    };
    capturedOnEvent!(wrap);
    await flush();
    expect(buffer.size).toBe(0);
    expect(routeMarmotWelcome).toHaveBeenCalledTimes(1);
    stop();
    hydrated.current = true;
    follows.current.add(ALICE);
    startLiveDmSubscription(params);
    await flush();
    const replay = setDeferredReplay.mock.calls.at(-1)![0];
    buffer.reevaluate(follows.current, replay);
    buffer.reevaluate(follows.current, replay);
    await flush();
    capturedOnEvent!(wrap);
    await flush();
    expect(routeMarmotWelcome).toHaveBeenCalledTimes(1);
    expect(routeMarmotWelcome).toHaveBeenCalledWith(
      rumor,
      VIEWER,
      'welcome-wrap',
      false,
      false,
      expect.any(Function),
      false,
    );
    expect(upsertDmMessages).not.toHaveBeenCalled();
    expect(mockFireNotification).not.toHaveBeenCalled();
  });

  it('recovers all 51 backlog wraps across bounded eviction, hydration and reopen', async () => {
    const buffer = createLiveSubFollowGateBuffer();
    const hydrated = { current: false };
    const follows = { current: new Set<string>() };
    const setDeferredReplay = jest.fn();
    const params = makeParams({
      followGateBuffer: buffer,
      followHydratedRef: hydrated,
      followPubkeysRef: follows,
      setDeferredReplay,
    });
    const stop = startLiveDmSubscription(params);
    await flush();
    const wraps = Array.from({ length: 51 }, (_, i) => ({
      id: `overflow-${i}`,
      kind: 1059,
      pubkey: ALICE,
      created_at: 100,
      tags: [],
      content: 'sealed',
      rumor: {
        kind: 14,
        created_at: 100,
        content: `message ${i}`,
        partnership: { partnerPubkey: ALICE, fromMe: false },
      },
    }));
    for (const wrap of wraps) {
      capturedOnEvent!(wrap);
      await flush();
    }
    expect(buffer.size).toBe(50);
    expect(params.knownWrapIdsRef.current.set.has('overflow-0')).toBe(false);
    hydrated.current = true;
    follows.current.add(ALICE);
    buffer.reevaluate(follows.current, setDeferredReplay.mock.calls[0][0]);
    await flush();
    expect(upsertDmMessages).toHaveBeenCalledTimes(50);
    stop();
    startLiveDmSubscription(params);
    await flush();
    for (const wrap of wraps) {
      capturedOnEvent!(wrap);
      await flush();
    }
    const ids = jest
      .mocked(upsertDmMessages)
      .mock.calls.flatMap(([rows]) => rows.map((r) => r.eventId));
    expect(ids).toHaveLength(51);
    expect(new Set(ids).size).toBe(51);
    expect(buffer.size).toBe(0);
    expect(mockFireNotification).not.toHaveBeenCalled();
  });
});

describe('review deferred persistence recovery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(upsertDmMessages).mockReset().mockResolvedValue(undefined);
  });

  it.each(['queued teardown', 'blocked teardown', 'write failure'])(
    'releases unpersisted replay claims after %s and recovers on reopen',
    async (scenario) => {
      const params = makeParams({
        setDeferredReplay: jest.fn(),
        followHydratedRef: { current: false },
      });
      const stop = startLiveDmSubscription(params);
      await flush();
      const wraps = [0, 1].map((i) => ({
        id: `replay-cancel-${i}`,
        kind: 1059,
        pubkey: ALICE,
        created_at: 100,
        tags: [],
        content: 'sealed',
        rumor: {
          kind: 14,
          created_at: 100,
          content: `message ${i}`,
          partnership: { partnerPubkey: ALICE, fromMe: false },
        },
      }));
      for (const wrap of wraps) {
        capturedOnEvent!(wrap);
        await flush();
      }
      expect(params.followGateBuffer.size).toBe(2);
      let finish: (() => void) | undefined;
      if (scenario === 'blocked teardown') {
        jest
          .mocked(upsertDmMessages)
          .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)));
      } else if (scenario === 'write failure') {
        jest.mocked(upsertDmMessages).mockRejectedValue(new Error('disk unavailable'));
      }
      params.followPubkeysRef.current.add(ALICE);
      params.followHydratedRef!.current = true;
      const replay = jest.mocked(params.setDeferredReplay).mock.calls[0][0]!;
      params.followGateBuffer.reevaluate(params.followPubkeysRef.current, replay);
      expect(params.followGateBuffer.size).toBe(0);
      if (scenario !== 'queued teardown') await flush();
      stop();
      // Teardown must release queued claims before a new sub can receive them.
      expect(params.knownWrapIdsRef.current.set.has(wraps[1].id)).toBe(false);
      finish?.();
      await flush();
      jest.mocked(upsertDmMessages).mockReset().mockResolvedValue(undefined);
      startLiveDmSubscription(params);
      await flush();
      capturedOnEvent!(wraps[1]);
      await flush();
      expect(upsertDmMessages).toHaveBeenCalledWith([
        expect.objectContaining({ eventId: wraps[1].id, content: 'message 1' }),
      ]);
    },
  );

  it.each(['current', 'teardown', 'switched'])(
    'announces replay only after a blocked write commits (owner=%s)',
    async (owner) => {
      let current = true;
      const params = makeParams({ isCurrentOwner: () => current, setDeferredReplay: jest.fn() });
      const stop = startLiveDmSubscription(params);
      await flush();
      let commit!: () => void;
      jest.mocked(upsertDmMessages).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            commit = resolve;
          }),
      );
      const replay = jest.mocked(params.setDeferredReplay).mock.calls[0][0]!;
      replay({
        partnerPubkey: ALICE,
        entry: {
          id: 'blocked-replay',
          partnerPubkey: ALICE,
          fromMe: false,
          createdAt: 100,
          text: 'hello',
          wireKind: 4,
        },
      });
      await flush();
      replay({
        partnerPubkey: ALICE,
        entry: {
          id: 'queued-replay',
          partnerPubkey: ALICE,
          fromMe: false,
          createdAt: 101,
          text: 'queued behind the blocked write',
          wireKind: 4,
        },
      });
      // A conversation reload after its 150 ms debounce must not run before SQLite commits.
      await new Promise((resolve) => setTimeout(resolve, 160));
      expect(upsertDmMessages).toHaveBeenCalledTimes(1);
      expect(mockNotifyDm).not.toHaveBeenCalled();
      if (owner === 'teardown') stop();
      if (owner === 'switched') current = false;
      commit();
      await flush();
      expect(mockNotifyDm).toHaveBeenCalledTimes(owner === 'current' ? 2 : 0);
      if (owner === 'current') expect(mockNotifyDm).toHaveBeenCalledWith(ALICE);
    },
  );

  it.each([false, true])(
    'recovers evicted kind-4 backlog after hydration (reopen with advanced cursor=%s)',
    async (reopen) => {
      const params = makeParams({
        setDeferredReplay: jest.fn(),
        followHydratedRef: { current: false },
      });
      const stop = startLiveDmSubscription(params);
      await flush();
      jest.mocked(nip04PlaintextCache.get).mockReturnValue('legacy plaintext');
      const messages = Array.from({ length: 51 }, (_, i) => ({
        id: `kind4-overflow-${i}`,
        kind: 4,
        pubkey: ALICE,
        created_at: 100 + i,
        tags: [['p', VIEWER]],
        content: 'ciphertext',
      }));
      for (const message of messages) {
        capturedOnEvent!(message);
        await flush();
      }
      expect(params.followGateBuffer.size).toBe(50);
      params.followPubkeysRef.current.add(ALICE);
      params.followHydratedRef!.current = true;
      params.followGateBuffer.reevaluate(
        params.followPubkeysRef.current,
        jest.mocked(params.setDeferredReplay).mock.calls[0][0]!,
      );
      await flush();
      expect(upsertDmMessages).toHaveBeenCalledTimes(50);
      // Canonical follow adoption clears the drained buffer.
      params.followGateBuffer.clear();
      if (reopen) {
        stop();
        jest.mocked(loadLastSeen).mockResolvedValueOnce(10_000);
        startLiveDmSubscription(params);
        await flush();
        expect(mockSubscribe).toHaveBeenLastCalledWith(expect.objectContaining({ sinceK4: 100 }));
      }
      // Retained recovery floor redelivers the full backlog, including persisted IDs.
      for (const message of messages) {
        capturedOnEvent!(message);
        await flush();
      }
      const ids = jest
        .mocked(upsertDmMessages)
        .mock.calls.flatMap(([rows]) => rows.map((row) => row.eventId));
      expect(ids).toHaveLength(51);
      expect(new Set(ids).size).toBe(51);
      expect(mockNotifyDm).toHaveBeenCalledTimes(51);
      expect(mockFireNotification).not.toHaveBeenCalled();
    },
  );
});
