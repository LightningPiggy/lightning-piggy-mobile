// The nsec background watch and the app's live DM sub run in the same JS
// context and see the same gift wraps. The live sub decrypts and alerts for
// every wrap it takes in, so the watch must not decrypt those a second time,
// yet must still alert for anything the live sub doesn't have: when no live
// sub runs (headless, after a swipe-away) or when it was torn down mid-wrap.
import {
  runBackgroundDmWatch,
  stopBackgroundDmWatch,
  __resetForTests,
  LIVE_SUB_DECRYPT_GRACE_MS,
} from './backgroundDmService';
import {
  claimWrapNotification,
  noteLiveDmSubArmed,
  registerLiveDmWrapIndex,
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

/** The app's live sub as the watch sees it: armed, with a wrap-id index. */
function armLiveSub() {
  const known = new Set<string>();
  noteLiveDmSubArmed(true);
  const unregister = registerLiveDmWrapIndex((id) => known.has(id));
  return {
    take: (id: string) => known.add(id),
    tearDown: () => {
      noteLiveDmSubArmed(false);
      unregister();
    },
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

it('does not decrypt a wrap the live sub has taken (app open)', async () => {
  const live = armLiveSub();
  deliver('w1');
  live.take('w1'); // the live sub got the same wrap a moment later
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('skips the backlog the inbox already stored when the watch re-arms', async () => {
  const live = armLiveSub();
  for (let i = 0; i < 50; i++) {
    live.take(`old${i}`);
    deliver(`old${i}`);
  }
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).not.toHaveBeenCalled();
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

it('takes over a wrap the live sub dropped when it was torn down mid-wrap', async () => {
  const live = armLiveSub();
  deliver('w2');
  live.take('w2');
  live.tearDown(); // app closed before the live sub alerted
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
});

it('never alerts twice when the live sub alerted before it was torn down', async () => {
  const live = armLiveSub();
  deliver('w3');
  live.take('w3');
  claimWrapNotification('w3'); // the live sub's alert
  live.tearDown();
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('defers again once the app reopens and its live sub re-arms', async () => {
  const first = armLiveSub();
  first.tearDown();
  deliver('while-closed');
  await jest.advanceTimersByTimeAsync(0);
  expect(mockUnwrapWrapNsec).toHaveBeenCalledTimes(1);
  const reopened = armLiveSub();
  deliver('after-reopen');
  reopened.take('after-reopen');
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
