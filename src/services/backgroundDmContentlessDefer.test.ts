import {
  runBackgroundDmWatch,
  stopBackgroundDmWatch,
  __resetForTests,
  LIVE_SUB_DECRYPT_GRACE_MS,
} from './backgroundDmService';
import {
  markWrapAlreadyStored,
  markWrapHandled,
  noteLiveDmSubArmed,
  takeContentlessWrapAlert,
  __resetForTests as __resetDedupeForTests,
} from './dmWrapNotificationDedupe';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null) }));
// A remote signer (Amber / NIP-46) can't decrypt in the background, so the
// watch's alert is contentless — and used to fire for every gift wrap,
// including the copy of each message we SEND (NIP-17 wraps one to the sender)
// and other wraps that never show a new message. When the app's live sub runs
// in the same JS context it decrypts them, so the watch defers to it.
const mockSubscribe = jest.fn();
const mockLoadIdentities = jest.fn();
const mockGetUserRelays = jest.fn();
const mockAsyncGetItem = jest.fn();
const mockFireMessageNotification = jest.fn().mockResolvedValue('id');
const mockHasPermission = jest.fn();
const mockShowForeground = jest.fn().mockResolvedValue('fg');
const mockDismissForeground = jest.fn().mockResolvedValue(undefined);
const mockUnwrapWrapNsec = jest.fn();
const mockPartnerFromRumor = jest.fn();
const mockTextForRumor = jest.fn();
const mockDecodeNsec = jest.fn();
const mockFetchProfile = jest.fn().mockResolvedValue(null);
const mockPeekSync = jest.fn().mockReturnValue(null);
const mockGet = jest.fn().mockResolvedValue(null);
const mockCanWatchPayments = jest.fn();
const mockPaymentsRunning = jest.fn();
const mockStartPayments = jest.fn();
const mockStopPayments = jest.fn();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('nostr-tools/nip44', () => ({}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: (...a: unknown[]) => mockAsyncGetItem(...a) },
}));
jest.mock('./identitiesStore', () => ({ loadIdentities: () => mockLoadIdentities() }));
// mergeRelays is the real one — the relay-resolution fix under test IS the
// defaults + nip65-cache + overrides merge, so don't stub it out.
jest.mock('./nostrRelayStorage', () => ({
  getUserRelays: () => mockGetUserRelays(),
  mergeRelays: jest.requireActual('./nostrRelayStorage').mergeRelays,
}));
jest.mock('./nostrService', () => ({
  decodeNsec: (...a: unknown[]) => mockDecodeNsec(...a),
  fetchProfile: (...a: unknown[]) => mockFetchProfile(...a),
  DEFAULT_RELAYS: ['wss://default.example'],
}));
jest.mock('./dmLiveSubscription', () => ({
  subscribeInboxDmsForViewer: (...a: unknown[]) => mockSubscribe(...a),
}));
jest.mock('./notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireMessageNotification(...a),
  hasNotificationPermission: () => mockHasPermission(),
  showForegroundServiceNotification: (...a: unknown[]) => mockShowForeground(...a),
  dismissForegroundServiceNotification: (...a: unknown[]) => mockDismissForeground(...a),
}));
jest.mock('./zapSenderProfileStorage', () => ({
  peekSync: (...a: unknown[]) => mockPeekSync(...a),
  get: (...a: unknown[]) => mockGet(...a),
}));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: (...a: unknown[]) => mockUnwrapWrapNsec(...a),
  partnerFromRumor: (...a: unknown[]) => mockPartnerFromRumor(...a),
  textForRumor: (...a: unknown[]) => mockTextForRumor(...a),
}));
jest.mock('./backgroundPaymentService', () => ({
  canWatchBackgroundPayments: () => mockCanWatchPayments(),
  isBackgroundPaymentWatchRunning: () => mockPaymentsRunning(),
  startBackgroundPaymentWatch: (...a: unknown[]) => mockStartPayments(...a),
  stopBackgroundPaymentWatch: (...a: unknown[]) => mockStopPayments(...a),
}));
jest.mock('./backgroundDmPreference', () => ({ loadBackgroundDmEnabled: jest.fn() }));

const ME = 'a'.repeat(64);

function onEvent(): (ev: unknown) => Promise<void> {
  const call = mockSubscribe.mock.calls.at(-1);
  return (call?.[0] as { onEvent: (ev: unknown) => Promise<void> }).onEvent;
}

async function armAmberWatch(): Promise<void> {
  mockLoadIdentities.mockResolvedValue({
    identities: [{ pubkey: ME, signerType: 'amber', lastUsedAt: 1 }],
    activePubkey: ME,
  });
  await runBackgroundDmWatch();
  const call = mockSubscribe.mock.calls.at(-1);
  (call?.[0] as { onEose?: () => void }).onEose?.();
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  __resetForTests();
  __resetDedupeForTests();
  mockSubscribe.mockReturnValue(() => {});
  mockGetUserRelays.mockResolvedValue([{ url: 'wss://r.example', read: true, write: true }]);
  mockAsyncGetItem.mockResolvedValue(null);
  mockHasPermission.mockResolvedValue(true);
  mockCanWatchPayments.mockResolvedValue(false);
  mockPaymentsRunning.mockReturnValue(false);
});

afterEach(async () => {
  jest.useRealTimers();
  // Clears the watch's safety re-arm interval, which would keep Jest alive.
  await stopBackgroundDmWatch();
});

it('stays silent for a wrap the live sub decoded (e.g. the copy of our own message)', async () => {
  await armAmberWatch();
  noteLiveDmSubArmed(true);
  jest.useFakeTimers();
  onEvent()({ id: 'own-copy', kind: 1059 });
  // The live sub decrypts it within the grace and decides it shows nothing new.
  markWrapHandled('own-copy');
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('stays silent for a re-delivered wrap the live sub already has stored', async () => {
  await armAmberWatch();
  noteLiveDmSubArmed(true);
  jest.useFakeTimers();
  onEvent()({ id: 'stored', kind: 1059 });
  // No freshness gate here, so "already stored" must keep it silent (#1279).
  markWrapAlreadyStored('stored');
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS);
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
});

it('still alerts when the live sub could not decrypt in time — and lets it replace the alert', async () => {
  await armAmberWatch();
  noteLiveDmSubArmed(true);
  jest.useFakeTimers();
  onEvent()({ id: 'slow', kind: 1059 });
  await jest.advanceTimersByTimeAsync(LIVE_SUB_DECRYPT_GRACE_MS - 1);
  expect(mockFireMessageNotification).not.toHaveBeenCalled();
  await jest.advanceTimersByTimeAsync(1);
  expect(mockFireMessageNotification).toHaveBeenCalledWith(
    expect.objectContaining({ title: 'New encrypted message', data: { wrapId: 'slow' } }),
  );
  expect(takeContentlessWrapAlert('slow')).toBe(true);
});

it('alerts straight away when no live sub runs here (headless)', async () => {
  await armAmberWatch();
  await onEvent()({ id: 'headless', kind: 1059 });
  expect(mockFireMessageNotification).toHaveBeenCalledTimes(1);
});
