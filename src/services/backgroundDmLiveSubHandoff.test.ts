// The nsec background watch and the app's live DM sub run in the same JS
// context and see the same gift wraps. The watch must not decrypt a wrap the
// live sub has already decided (alerted, or nothing to alert), yet must still
// alert for every other wrap: when no live sub runs (headless, after a
// swipe-away), when it never got the wrap, keeps it silent as not fresh to
// it, or was torn down before deciding.
import {
  runBackgroundDmWatch,
  stopBackgroundDmWatch,
  __resetForTests,
  LIVE_SUB_DECRYPT_GRACE_MS,
} from './backgroundDmService';
import {
  claimWrapNotification,
  markWrapHandled,
  noteLiveDmSubArmed,
  __resetForTests as __resetDedupeForTests,
} from './dmWrapNotificationDedupe';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null) }));
const mockSubscribe = jest.fn();
const mockLoadIdentities = jest.fn();
const mockFireMessageNotification = jest.fn().mockResolvedValue('id');
const mockUnwrapWrapNsec = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('nostr-tools/nip44', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn().mockResolvedValue(null) },
}));
jest.mock('./identitiesStore', () => ({ loadIdentities: () => mockLoadIdentities() }));
jest.mock('./nostrRelayStorage', () => ({
  getUserRelays: () => Promise.resolve([{ url: 'wss://r.example', read: true, write: true }]),
  mergeRelays: jest.requireActual('./nostrRelayStorage').mergeRelays,
}));
jest.mock('./nostrService', () => ({
  decodeNsec: () => ({ pubkey: 'a'.repeat(64), secretKey: new Uint8Array(32) }),
  fetchProfile: jest.fn().mockResolvedValue(null),
  DEFAULT_RELAYS: ['wss://default.example'],
}));
jest.mock('./dmLiveSubscription', () => ({
  subscribeInboxDmsForViewer: (...a: unknown[]) => mockSubscribe(...a),
}));
jest.mock('./notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireMessageNotification(...a),
  hasNotificationPermission: () => Promise.resolve(true),
  showForegroundServiceNotification: jest.fn().mockResolvedValue('fg'),
  dismissForegroundServiceNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./zapSenderProfileStorage', () => ({
  peekSync: () => ({ name: 'Bob' }),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: (...a: unknown[]) => mockUnwrapWrapNsec(...a),
  partnerFromRumor: () => ({ partnerPubkey: 'b'.repeat(64), fromMe: false }),
  textForRumor: () => 'hi',
}));
jest.mock('./backgroundPaymentService', () => ({
  canWatchBackgroundPayments: () => Promise.resolve(false),
  isBackgroundPaymentWatchRunning: () => false,
  startBackgroundPaymentWatch: jest.fn(),
  stopBackgroundPaymentWatch: jest.fn(),
}));
jest.mock('./backgroundDmPreference', () => ({ loadBackgroundDmEnabled: jest.fn() }));

const ME = 'a'.repeat(64);
const OTHER = 'c'.repeat(64);

function identity(pubkey: string) {
  return {
    identities: [{ pubkey, signerType: 'nsec', nsec: 'nsec1xxx', lastUsedAt: 1 }],
    activePubkey: pubkey,
  };
}

function deliver(id: string): void {
  const call = mockSubscribe.mock.calls.at(-1)?.[0] as { onEvent: (ev: unknown) => void };
  call.onEvent({ id, kind: 1059, pubkey: 'd'.repeat(64), tags: [], content: '' });
}

/** The app's live sub as the watch sees it: armed, deciding wraps. */
function armLiveSub() {
  noteLiveDmSubArmed(true);
  return {
    /** Decided and alerted (claims the notification, marks it handled). */
    alert: (id: string) => {
      claimWrapNotification(id);
      markWrapHandled(id);
    },
    /** Decided there is nothing to alert (own copy, stranger, already stored). */
    nothingToSee: (id: string) => markWrapHandled(id),
    tearDown: () => noteLiveDmSubArmed(false),
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useRealTimers();
  __resetForTests();
  __resetDedupeForTests();
  mockSubscribe.mockReturnValue(() => {});
  mockLoadIdentities.mockResolvedValue(identity(ME));
  mockUnwrapWrapNsec.mockImplementation(() => ({
    kind: 14,
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    content: 'hi',
    tags: [],
  }));
  await runBackgroundDmWatch();
  jest.useFakeTimers();
});

afterEach(async () => {
  jest.useRealTimers();
  // Clears the watch's safety re-arm interval, which would keep Jest alive.
  await stopBackgroundDmWatch();
});

it('does not decrypt a wrap the live sub decided and alerted for (app open)', async () => {
  const live = armLiveSub();
  deliver('w1');
  live.alert('w1'); // the live sub got the same wrap a moment later
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('stays silent without decrypting when the live sub decided there is nothing to alert', async () => {
  const live = armLiveSub();
  deliver('own-copy');
  live.nothingToSee('own-copy'); // handled, never claimed
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('skips the backlog the live sub already handled when the watch re-arms', async () => {
  const live = armLiveSub();
  for (let i = 0; i < 50; i++) {
    live.nothingToSee(`old${i}`); // known on receipt: already stored
    deliver(`old${i}`);
  }
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
});

it('still alerts for a wrap the live sub has but never decides (silent as not fresh to it)', async () => {
  armLiveSub(); // stays armed, takes the wrap, never marks it handled
  deliver('kept-silent');
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
});

it('decrypts and alerts, after the grace, for a wrap the live sub never got', async () => {
  armLiveSub();
  deliver('only-on-a-watch-relay');
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS - 1);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
});

it('decrypts and alerts straight away with no live sub (headless / swiped away)', async () => {
  deliver('headless');
  await jest.advanceTimersByTimeAsync(0);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
});

it('takes over a wrap the live sub dropped when it was torn down before deciding', async () => {
  const live = armLiveSub();
  deliver('w2');
  live.tearDown(); // app closed before the live sub decided
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
});

it('never alerts twice when the live sub alerted before it was torn down', async () => {
  const live = armLiveSub();
  deliver('w3');
  live.alert('w3');
  live.tearDown();
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('never alerts twice when the live sub alerts after the watch took over', async () => {
  armLiveSub();
  deliver('late');
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
  // The live sub's own claim for the same wrap now fails.
  expect(claimWrapNotification('late')).toBe(false);
});

it('defers again once the app reopens and its live sub re-arms', async () => {
  const first = armLiveSub();
  first.tearDown();
  deliver('while-closed');
  await jest.advanceTimersByTimeAsync(0);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  const reopened = armLiveSub();
  deliver('after-reopen');
  reopened.alert('after-reopen');
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
});

it('does not alert for a wrap of an account switched away from during the grace', async () => {
  armLiveSub();
  deliver('old-account');
  mockLoadIdentities.mockResolvedValue(identity(OTHER));
  jest.useRealTimers();
  await runBackgroundDmWatch();
  jest.useFakeTimers();
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});
