/**
 * Unit tests for restoreNip46Session — the cold-start NIP-46 session restore.
 * SecureStore, the connect service, and the two post-login side-effect services
 * are mocked so we exercise only the read → parse → re-assert → return logic.
 *
 * Contract (post-hardening): the persisted connection blob is the source of
 * truth. We return `conn.userPubkey` (NOT the legacy PUBKEY_KEY slot, which can
 * diverge), and on a missing/corrupt blob we self-heal by clearing the stale
 * SecureStore slots so a bad state doesn't loop on every cold start.
 */
import { restoreNip46Session } from './useNip46Login';

const mockGetItemAsync = jest.fn();
const mockDeleteItemAsync = jest.fn();
const mockSetActiveConnection = jest.fn(() => Promise.resolve());

jest.mock('expo-secure-store', () => ({
  getItemAsync: (...a: unknown[]) => mockGetItemAsync(...(a as [])),
  setItemAsync: jest.fn(),
  deleteItemAsync: (...a: unknown[]) => mockDeleteItemAsync(...(a as [])),
}));
jest.mock('../services/nostrConnectService', () => ({
  setActiveConnection: (...a: unknown[]) => mockSetActiveConnection(...(a as [])),
}));
jest.mock('../services/migrateToPerAccountStorage', () => ({
  migrateToPerAccountStorage: jest.fn(),
}));
jest.mock('../services/backgroundDmService', () => ({
  syncBackgroundDmWatchFromPreference: jest.fn(),
}));

// Realistic fixture: the pubkeys + client secret must be 64-char hex — the
// restore path validates their shape before trusting the blob (isValidNip46Connection).
const BUNKER_PK = 'b'.repeat(64);
const USER_PK = 'c'.repeat(64);
const CLIENT_SK = 'a'.repeat(64);
const connection = {
  remoteSignerPubkey: BUNKER_PK,
  userPubkey: USER_PK,
  relays: ['wss://r'],
  clientSecretKeyHex: CLIENT_SK,
  perms: 'sign_event',
};

beforeEach(() => jest.clearAllMocks());

it('restores the connection and returns conn.userPubkey (the source of truth)', async () => {
  mockGetItemAsync.mockResolvedValueOnce(JSON.stringify(connection)); // NIP46_CONNECTION_KEY
  await expect(restoreNip46Session()).resolves.toBe(USER_PK);
  expect(mockSetActiveConnection).toHaveBeenCalledWith(connection);
});

it('never installs the bunker of a restore a newer login superseded (#1746)', async () => {
  await expect(restoreNip46Session(JSON.stringify(connection), () => false)).resolves.toBeNull();
  expect(mockSetActiveConnection).not.toHaveBeenCalled();
  // The stored session itself is kept: it is still valid, just not chosen now.
  expect(mockDeleteItemAsync).not.toHaveBeenCalled();
});

it('self-heals when the blob parses but has an invalid shape (non-hex secret)', async () => {
  // JSON-parsable but wrong-shape (e.g. a partial / corrupted write) must be
  // rejected up front rather than installing an all-undefined connection.
  mockGetItemAsync.mockResolvedValueOnce(JSON.stringify({ clientSecretKeyHex: 'zz' }));
  await expect(restoreNip46Session()).resolves.toBeNull();
  // Treated exactly like a corrupt blob: slots cleared + connection released,
  // and we never adopt the bad object as the active connection.
  expect(mockSetActiveConnection).not.toHaveBeenCalledWith({ clientSecretKeyHex: 'zz' });
  expect(mockSetActiveConnection).toHaveBeenCalledWith(null);
  expect(mockDeleteItemAsync).toHaveBeenCalled();
});

it('clears the stale signer-type slot and returns null when the connection blob is missing', async () => {
  mockGetItemAsync.mockResolvedValueOnce(null); // NIP46_CONNECTION_KEY absent
  await expect(restoreNip46Session()).resolves.toBeNull();
  expect(mockSetActiveConnection).not.toHaveBeenCalled();
  // Self-heal: the stale SIGNER_TYPE_KEY slot is cleared.
  expect(mockDeleteItemAsync).toHaveBeenCalled();
});

it('self-heals (clears slots, no throw) when the stored blob is corrupt', async () => {
  mockGetItemAsync.mockResolvedValueOnce('{not json');
  await expect(restoreNip46Session()).resolves.toBeNull();
  // Corrupt blob → both nip46 slots cleared + the active connection released.
  expect(mockDeleteItemAsync).toHaveBeenCalled();
  expect(mockSetActiveConnection).toHaveBeenCalledWith(null);
});
