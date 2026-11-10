// Jest global setup for Lightning Piggy Mobile.
//
// Kept intentionally small — add mocks here when a test needs to stub a native
// module that `jest-expo` doesn't already mock (e.g. expo-secure-store with
// custom data, react-native-nfc-manager, etc.). Per-test overrides should live
// in the test file itself, not here.

// React Native modules read `__DEV__` (defined globally by Metro at
// runtime). Jest doesn't define it, so `if (__DEV__) console.warn(...)`
// branches in app code throw `__DEV__ is not defined` during a test
// run unless we provide a global stub. Set true here so dev-only
// branches are exercised by tests (matches Metro's `expo start`).
if (typeof global !== 'undefined') {
  global.__DEV__ = true;
}

// react-native-nfc-manager has no Jest mock shipped (and its native
// module throws on import in the Node test env). Provide a minimal stub
// so importing `nfcService.ts` from a unit test doesn't blow up — the
// pure URL-classification helpers (`parseNfcContent`) don't exercise
// any of these methods, but the module-level singleton import still
// has to resolve. Issue #103.
jest.mock('react-native-nfc-manager', () => ({
  __esModule: true,
  default: {
    isSupported: jest.fn().mockResolvedValue(false),
    isEnabled: jest.fn().mockResolvedValue(false),
    start: jest.fn().mockResolvedValue(undefined),
    goToNfcSetting: jest.fn(),
    requestTechnology: jest.fn().mockResolvedValue(null),
    cancelTechnologyRequest: jest.fn().mockResolvedValue(undefined),
    getTag: jest.fn().mockResolvedValue(null),
    registerTagEvent: jest.fn().mockResolvedValue(undefined),
    unregisterTagEvent: jest.fn().mockResolvedValue(undefined),
    setEventListener: jest.fn(),
    ndefHandler: { writeNdefMessage: jest.fn().mockResolvedValue(undefined) },
  },
  NfcTech: { Ndef: 'Ndef', NfcA: 'NfcA', MifareUltralight: 'MifareUltralight' },
  NfcAdapter: {
    FLAG_READER_NFC_A: 1,
    FLAG_READER_NFC_B: 2,
    FLAG_READER_NFC_F: 4,
    FLAG_READER_NFC_V: 8,
    FLAG_READER_NO_PLATFORM_SOUNDS: 256,
  },
  NfcEvents: {
    DiscoverTag: 'NfcManagerDiscoverTag',
    SessionClosed: 'NfcManagerSessionClosed',
    StateChanged: 'NfcManagerStateChanged',
  },
  Ndef: {
    uri: { decodePayload: jest.fn() },
    text: { decodePayload: jest.fn() },
    encodeMessage: jest.fn(() => new Uint8Array()),
    uriRecord: jest.fn(),
  },
}));

// op-sqlite is a native module Jest can't load (ESM entry + native
// bindings). Provide a stub whose open() reports SQLCipher active so the
// localDb plaintext guard passes; tests that exercise the DAL mock
// `./localDb` / `./dmDb` themselves (per-file jest.mock wins over this
// global one). Needed since #848 wired the encrypted DM store into
// NostrContext, which many suites import transitively.
jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({
    execute: jest.fn((sql) =>
      Promise.resolve({
        rows: String(sql).includes('cipher_version') ? [{ cipher_version: 'jest-stub' }] : [],
      }),
    ),
    transaction: jest.fn(async (fn) =>
      fn({ execute: jest.fn(() => Promise.resolve({ rows: [] })) }),
    ),
    delete: jest.fn(),
  })),
}));

// AsyncStorage's native module isn't linked in the Jest environment.
// The package ships an in-memory mock for exactly this case — wire it
// up here so any test that touches storage (e.g. sendThresholdService
// in #82) gets a working get/set/clear without each test file having
// to add its own jest.mock(...) boilerplate.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// RN's idle scheduler is native; model it with cancellable timers in Jest.
global.requestIdleCallback = (callback) =>
  setTimeout(() => callback({ didTimeout: false, timeRemaining: () => 50 }), 0);
global.cancelIdleCallback = (handle) => clearTimeout(handle);
