import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAppRelayEnabled, forgetAppRelayPrefs } from './appRelayPrefs';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import {
  startBackgroundDmWatch,
  stopBackgroundDmWatch,
  __isWatchActiveForTests,
  __resetForTests,
} from './backgroundDmService';

let mockWatchEnabled = true;
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null) }));

const mockSubscribe = jest.fn();
const mockLoadIdentities = jest.fn();
const mockGetUserRelays = jest.fn();
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
  default: jest.requireActual('@react-native-async-storage/async-storage/jest/async-storage-mock'),
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
jest.mock('./backgroundDmPreference', () => ({ loadBackgroundDmEnabled: () => mockWatchEnabled }));

const ME = 'a'.repeat(64);

beforeEach(async () => {
  jest.clearAllMocks();
  __resetForTests();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(ME);
  await AsyncStorage.clear();
  mockWatchEnabled = true;
  mockLoadIdentities.mockResolvedValue({
    identities: [{ pubkey: ME, signerType: 'nsec', nsec: 'nsec1test', lastUsedAt: 1 }],
    activePubkey: ME,
  });
  mockDecodeNsec.mockReturnValue({ pubkey: ME, secretKey: new Uint8Array(32) });
  mockGetUserRelays.mockResolvedValue([]);
  mockHasPermission.mockResolvedValue(true);
  mockCanWatchPayments.mockResolvedValue(false);
  mockPaymentsRunning.mockReturnValue(false);
  mockSubscribe.mockReturnValue(jest.fn());
  setCurrentUserPubkey(ME);
});

afterEach(async () => {
  await stopBackgroundDmWatch();
  setCurrentUserPubkey(null);
});

it('restarts the preference-enabled watch after all default relays were disabled', async () => {
  await startBackgroundDmWatch();
  expect(__isWatchActiveForTests()).toBe(true);
  await setAppRelayEnabled(ME, 'default', 'wss://default.example', false);
  expect(__isWatchActiveForTests()).toBe(false);
  expect(mockDismissForeground).toHaveBeenCalled();
  mockSubscribe.mockClear();

  await setAppRelayEnabled(ME, 'default', 'wss://default.example', true);
  expect(__isWatchActiveForTests()).toBe(true);
  expect(mockSubscribe).toHaveBeenCalledTimes(1);
  expect(mockSubscribe).toHaveBeenCalledWith(
    expect.objectContaining({ relays: ['wss://default.example'], viewerPubkey: ME }),
  );
});

it.each(['preference off', 'permission missing'])('does not restart when %s', async (reason) => {
  await setAppRelayEnabled(ME, 'default', 'wss://default.example', false);
  mockSubscribe.mockClear();
  mockShowForeground.mockClear();
  if (reason === 'preference off') mockWatchEnabled = false;
  else mockHasPermission.mockResolvedValue(false);

  await setAppRelayEnabled(ME, 'default', 'wss://default.example', true);
  expect(__isWatchActiveForTests()).toBe(false);
  expect(mockSubscribe).not.toHaveBeenCalled();
  expect(mockShowForeground).not.toHaveBeenCalled();
});
