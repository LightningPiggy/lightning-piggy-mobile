// The background watch's contentless "New encrypted message" (remote signer)
// is a placeholder: once the live sub decrypts the wrap, the real alert
// replaces it — or, when the wrap shows nothing new (our own sent copy), it
// is retracted from the tray and the history.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetSellerStore } from '../services/sellerEventStore';
import { upsertDmMessages } from '../services/dmDb';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import {
  claimWrapNotification,
  noteContentlessWrapAlert,
  takeContentlessWrapAlert,
  wasWrapHandled,
  __resetForTests,
} from '../services/dmWrapNotificationDedupe';

const mockFire = jest.fn().mockResolvedValue('id');
const mockDismiss = jest.fn().mockResolvedValue(0);
const mockRemove = jest.fn().mockResolvedValue([]);
const mockCancelInFlight = jest.fn();

jest.mock('../services/notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFire(...a),
  dismissNotificationsFor: (...a: unknown[]) => mockDismiss(...a),
  cancelInFlightNotifications: (...a: unknown[]) => mockCancelInFlight(...a),
  isThreadActivelyViewed: () => false,
}));
jest.mock('../services/notificationHistory', () => ({
  removeNotificationsWhere: (...a: unknown[]) => mockRemove(...a),
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

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const now = () => Math.floor(Date.now() / 1000);

const flush = () => new Promise((r) => setTimeout(r, 0));

function surfacer({
  fresh = true,
  follows = new Set([PEER]),
  hydrated = true,
  overrides = {} as Partial<Parameters<typeof createLiveRumorSurfacer>[0]>,
} = {}) {
  return createLiveRumorSurfacer({
    viewerPubkey: ME,
    isCancelled: () => false,
    shouldAbort: () => false,
    followPubkeysRef: { current: follows },
    isFollowHydrated: () => hydrated,
    followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
    isFreshArrival: () => fresh,
    queueInboxEntry: jest.fn(),
    knownWrapIds: new Set(),
    seen: new Set(),
    chainWrite: (task) => void task(),
    ...overrides,
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
  resetSellerStore();
  jest.clearAllMocks();
  __resetForTests();
});

it('replaces the contentless alert with the real one — recorded first, then the placeholder goes', async () => {
  // The watch posted (and claimed) its contentless alert first.
  claimWrapNotification('w1');
  noteContentlessWrapAlert('w1');
  let recorded = false;
  mockFire.mockImplementationOnce(async () => {
    await flush();
    recorded = true;
    return 'id';
  });
  mockDismiss.mockImplementationOnce(async () => {
    expect(recorded).toBe(true); // never delete before the replacement exists
    return 0;
  });
  await surfacer()(
    { pubkey: PEER, created_at: now(), kind: 14, tags: [['p', ME]], content: 'hi' },
    'w1',
  );
  await flush();
  await flush();
  expect(mockFire).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ conversationPubkey: PEER }) }),
  );
  expect(mockDismiss).toHaveBeenCalledWith({ wrapId: 'w1' });
  expect(mockRemove).toHaveBeenCalledWith(ME, expect.any(Function));
  expect(wasWrapHandled('w1')).toBe(true);
});

it('retracts it when the wrap was the copy of our own message', async () => {
  claimWrapNotification('own');
  noteContentlessWrapAlert('own');
  await surfacer()(
    { pubkey: ME, created_at: now(), kind: 14, tags: [['p', PEER]], content: 'sent' },
    'own',
  );
  expect(mockFire).not.toHaveBeenCalled();
  expect(mockDismiss).toHaveBeenCalledWith({ wrapId: 'own' });
  // One still being posted is cancelled too.
  const inFlight = mockCancelInFlight.mock.calls[0][0] as (d: { wrapId?: string }) => boolean;
  expect(inFlight({ wrapId: 'own' })).toBe(true);
  expect(inFlight({ wrapId: 'x' })).toBe(false);
  const match = mockRemove.mock.calls[0][1] as (e: { data: { wrapId?: string } }) => boolean;
  expect(match({ data: { wrapId: 'own' } })).toBe(true);
  expect(match({ data: { wrapId: 'other' } })).toBe(false);
});

it('touches nothing when no contentless alert was posted, and still marks the wrap handled', async () => {
  await surfacer()(
    { pubkey: ME, created_at: now(), kind: 14, tags: [['p', PEER]], content: 'sent' },
    'w2',
  );
  expect(mockDismiss).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
  expect(wasWrapHandled('w2')).toBe(true);
});

it("retracts a stranger's contentless alert once the follow list is known", async () => {
  claimWrapNotification('stranger');
  noteContentlessWrapAlert('stranger');
  const STRANGER = 'c'.repeat(64);
  await surfacer()(
    { pubkey: STRANGER, created_at: now(), kind: 14, tags: [['p', ME]], content: 'hey' },
    'stranger',
  );
  expect(mockFire).not.toHaveBeenCalled();
  expect(mockDismiss).toHaveBeenCalledWith({ wrapId: 'stranger' });
  expect(takeContentlessWrapAlert('stranger')).toBe(false);
});

it('keeps it while follows are still loading (may be a friend), for the replay to replace', async () => {
  claimWrapNotification('maybe');
  noteContentlessWrapAlert('maybe');
  await surfacer({ follows: new Set(), hydrated: false })(
    { pubkey: PEER, created_at: now(), kind: 14, tags: [['p', ME]], content: 'hey' },
    'maybe',
  );
  expect(mockDismiss).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
  expect(takeContentlessWrapAlert('maybe')).toBe(true);
});

it("a late decrypt (sub opened after the message) keeps a friend's placeholder — the only alert it has", async () => {
  // e.g. Amber cold start: the watch alerted; Messages opened 20 min later.
  claimWrapNotification('late');
  noteContentlessWrapAlert('late');
  await surfacer({ fresh: false })(
    { pubkey: PEER, created_at: now() - 1200, kind: 14, tags: [['p', ME]], content: 'hi' },
    'late',
  );
  await flush();
  expect(mockFire).not.toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
  // Undecided: the background sync may still ping for it.
  expect(wasWrapHandled('late')).toBe(false);
});

it('keeps the placeholder when the real alert could not be written', async () => {
  claimWrapNotification('failed');
  noteContentlessWrapAlert('failed');
  mockFire.mockResolvedValueOnce(null); // e.g. no owner / storage failure, thread not on screen
  await surfacer()(
    { pubkey: PEER, created_at: now(), kind: 14, tags: [['p', ME]], content: 'hi' },
    'failed',
  );
  await flush();
  expect(mockFire).toHaveBeenCalled();
  expect(mockDismiss).not.toHaveBeenCalled();
  expect(mockRemove).not.toHaveBeenCalled();
});

it.each(['failure', 'cancelled'])(
  'releases live order claims after %s and suppresses pending copies',
  async (reason) => {
    const tasks: (() => Promise<void>)[] = [];
    let cancelled = false;
    const queueInboxEntry = jest.fn();
    const surface = surfacer({
      overrides: {
        chainWrite: (task) => {
          tasks.push(task);
        },
        isCancelled: () => cancelled,
        queueInboxEntry,
      },
    });
    const order = {
      pubkey: PEER,
      created_at: now(),
      kind: 16,
      tags: [
        ['p', ME],
        ['order', 'live-order'],
        ['type', '1'],
      ],
      content: '',
    };
    await surface(order, 'first-order-wrap');
    await surface(order, 'duplicate-order-wrap');
    expect(tasks).toHaveLength(1);
    expect(queueInboxEntry).not.toHaveBeenCalled();
    if (reason === 'failure') {
      (upsertDmMessages as jest.Mock).mockRejectedValueOnce(new Error('disk'));
      await expect(tasks.shift()!()).rejects.toThrow('disk');
    } else {
      cancelled = true;
      await tasks.shift()!();
      cancelled = false;
    }
    await surface(order, 'retry-order-wrap');
    expect(tasks).toHaveLength(1);
    await tasks.shift()!();
    expect(queueInboxEntry).toHaveBeenCalledTimes(1);
    await surface(order, 'committed-duplicate-wrap');
    expect(tasks).toHaveLength(0);
  },
);
