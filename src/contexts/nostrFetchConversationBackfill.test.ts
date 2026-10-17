import { fetchConversationFor, type FetchConversationParams } from './nostrFetchConversation';
import { backfillThreadRumorIds } from './dmRumorIdBackfill';

// The thread-open rumor-id backfill (#1319) only gets a wrap fetcher when
// there are relays to ask: with none, the rows must stay retryable.

jest.mock('../services/nostrService', () => ({
  fetchDirectMessageEvents: jest.fn(async () => []),
  fetchInboxDmEvents: jest.fn(async () => ({ kind1059: [] })),
}));
jest.mock('../services/amberService', () => ({ requestNip44Decrypt: jest.fn(async () => null) }));
jest.mock('../services/dmDb', () => ({
  getConversationMessages: jest.fn(async () => []),
  hasStoredWraps: jest.fn(async () => true),
  upsertDmMessages: jest.fn(async () => undefined),
  selectKnownEventIds: jest.fn(async () => new Set<string>()),
  LOCAL_DM_ID_PREFIX: 'local-',
  LOCAL_DM_ECHO_WINDOW_SECS: 30,
}));
jest.mock('./dmStoreMigrationRunner', () => ({
  ensureDmStoreMigrated: jest.fn(async () => undefined),
}));
jest.mock('./dmRumorIdBackfill', () => ({
  backfillThreadRumorIds: jest.fn(async () => new Map()),
  fetchWrapsByIds: jest.fn(async () => []),
}));
jest.mock('./nostrSecretKeyCache', () => ({
  ...jest.requireActual('./nostrSecretKeyCache'),
  getMemoisedSecretKey: jest.fn(async () => new Uint8Array(32)),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined) },
}));

const params = (relays: string[]): FetchConversationParams => ({
  pubkey: 'b'.repeat(64),
  isLoggedIn: true,
  signerType: 'nsec',
  getReadRelays: () => relays,
  decryptNip04ViaSigner: jest.fn(async () => 'plaintext'),
  otherPubkey: 'a'.repeat(64),
});

const backfill = backfillThreadRumorIds as jest.Mock;

beforeEach(() => jest.clearAllMocks());

it('passes no wrap fetcher when there are no read relays', async () => {
  await fetchConversationFor(params([]));
  expect(backfill).toHaveBeenCalledTimes(1);
  expect(backfill.mock.calls[0][0].fetchWraps).toBeUndefined();
});

it('passes a wrap fetcher when there are relays (control)', async () => {
  await fetchConversationFor(params(['wss://relay.example']));
  expect(backfill.mock.calls[0][0].fetchWraps).toEqual(expect.any(Function));
});
