import AsyncStorage from '@react-native-async-storage/async-storage';
import { fetchConversationFor, type FetchConversationParams } from './nostrFetchConversation';
import * as nostrService from '../services/nostrService';
import { getConversationMessages, hasStoredWraps } from '../services/dmDb';
import { ensureDmStoreMigrated } from './dmStoreMigrationRunner';

// Abort + single-flight coverage for the conversation fetch (#868). We mock the
// relay + DB + migration boundary so the test exercises the control flow around
// the AbortSignal without any real crypto / network / SQLite.

jest.mock('../services/nostrService', () => ({
  fetchDirectMessageEvents: jest.fn(async () => ({ events: [], complete: true })),
  fetchInboxDmEvents: jest.fn(async () => ({ kind1059: [] })),
}));

jest.mock('../services/amberService', () => ({
  requestNip44Decrypt: jest.fn(async () => null),
}));

jest.mock('../services/dmDb', () => ({
  getConversationMessages: jest.fn(async () => []),
  hasStoredWraps: jest.fn(async () => false),
  upsertDmMessages: jest.fn(async () => undefined),
  // DB known-id gate for thread-open kind-4 decrypts (#850, N6).
  selectKnownEventIds: jest.fn(async () => new Set<string>()),
  LOCAL_DM_ID_PREFIX: 'local-',
  LOCAL_DM_ECHO_WINDOW_SECS: 30,
}));

jest.mock('./dmStoreMigrationRunner', () => ({
  ensureDmStoreMigrated: jest.fn(async () => undefined),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => undefined) },
}));

const PEER = 'a'.repeat(64);
const ME = 'b'.repeat(64);

const baseParams = (over: Partial<FetchConversationParams> = {}): FetchConversationParams => ({
  pubkey: ME,
  isLoggedIn: true,
  signerType: 'nsec',
  getReadRelays: () => ['wss://relay.example'],
  decryptNip04ViaSigner: jest.fn(async () => 'plaintext'),
  otherPubkey: PEER,
  ...over,
});

describe('fetchConversationFor abort (#868)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns [] immediately when the signal is already aborted (no relay query)', async () => {
    const controller = new AbortController();
    controller.abort();
    const out = await fetchConversationFor(baseParams({ signal: controller.signal }));
    expect(out).toEqual([]);
    expect(ensureDmStoreMigrated).not.toHaveBeenCalled();
    expect(nostrService.fetchDirectMessageEvents).not.toHaveBeenCalled();
    expect(nostrService.fetchInboxDmEvents).not.toHaveBeenCalled();
  });

  it('skips the inbox-wide wrap fetch when aborted mid-flight', async () => {
    // Store read returns nothing and hasStoredWraps is false, so WITHOUT the
    // abort the code would hit fetchInboxDmEvents. Aborting after the store read
    // must short-circuit that inbox-wide relay fetch + decrypt loop.
    const controller = new AbortController();
    (getConversationMessages as jest.Mock).mockImplementation(async () => {
      controller.abort();
      return [];
    });
    (hasStoredWraps as jest.Mock).mockResolvedValue(false);

    await fetchConversationFor(baseParams({ signal: controller.signal }));

    expect(nostrService.fetchInboxDmEvents).not.toHaveBeenCalled();
  });

  it('runs the inbox-wide wrap fetch when NOT aborted (control)', async () => {
    (getConversationMessages as jest.Mock).mockResolvedValue([]);
    (hasStoredWraps as jest.Mock).mockResolvedValue(false);

    await fetchConversationFor(baseParams());

    expect(nostrService.fetchInboxDmEvents).toHaveBeenCalledTimes(1);
  });

  it('does NOT advance the convLastSeen cursor when aborted mid-flight (Copilot #869)', async () => {
    // Relay returns kind-4 events, but the fetch is aborted after the store
    // read. Persisting convLastSeen from these events would skip them on the
    // next open (they were never decrypted). An aborted run must write nothing.
    const setItem = AsyncStorage.setItem as jest.Mock;
    (nostrService.fetchDirectMessageEvents as jest.Mock).mockResolvedValue({
      events: [
        { id: 'e1', pubkey: PEER, content: 'ct', created_at: 1000 },
        { id: 'e2', pubkey: PEER, content: 'ct', created_at: 2000 },
      ],
      complete: true,
    });
    const controller = new AbortController();
    (getConversationMessages as jest.Mock).mockImplementation(async () => {
      controller.abort();
      return [];
    });

    await fetchConversationFor(baseParams({ signal: controller.signal }));

    // No cache blob and no cursor advance — zero AsyncStorage writes.
    expect(setItem).not.toHaveBeenCalled();
    expect(nostrService.fetchInboxDmEvents).not.toHaveBeenCalled();
  });

  it('persists the convLastSeen cursor on a normal (non-aborted) run', async () => {
    // Control: the same kind-4 events, no abort → the cursor IS written.
    const setItem = AsyncStorage.setItem as jest.Mock;
    (nostrService.fetchDirectMessageEvents as jest.Mock).mockResolvedValue({
      events: [
        { id: 'e1', pubkey: PEER, content: 'ct', created_at: 1000 },
        { id: 'e2', pubkey: PEER, content: 'ct', created_at: 2000 },
      ],
      complete: true,
    });
    (getConversationMessages as jest.Mock).mockResolvedValue([]);
    (hasStoredWraps as jest.Mock).mockResolvedValue(true);

    await fetchConversationFor(baseParams());

    const wroteCursor = setItem.mock.calls.some(([key]: [string]) =>
      key.includes('conv_last_seen'),
    );
    expect(wroteCursor).toBe(true);
  });

  it('does not advance the per-peer cursor from a read that cut a relay off (#1759)', async () => {
    const setItem = AsyncStorage.setItem as jest.Mock;
    (nostrService.fetchDirectMessageEvents as jest.Mock).mockResolvedValue({
      events: [{ id: 'e1', pubkey: PEER, content: 'ct', created_at: 2000 }],
      complete: false,
    });
    (getConversationMessages as jest.Mock).mockResolvedValue([]);
    (hasStoredWraps as jest.Mock).mockResolvedValue(true);

    await fetchConversationFor(baseParams());

    const wroteCursor = setItem.mock.calls.some(([key]: [string]) =>
      key.includes('conv_last_seen'),
    );
    expect(wroteCursor).toBe(false);
  });

  it('never writes decrypted plaintext to AsyncStorage (#850 at-rest invariant)', async () => {
    // A full, successful run that decrypts fresh kind-4 events. The ONLY
    // AsyncStorage write allowed is the bare-timestamp last-seen cursor —
    // the plaintext conversation/inbox blobs are retired; decrypted content
    // persists exclusively in the encrypted store (upsertDmMessages).
    const setItem = AsyncStorage.setItem as jest.Mock;
    (nostrService.fetchDirectMessageEvents as jest.Mock).mockResolvedValue({
      events: [{ id: 'e1', pubkey: PEER, content: 'ct', created_at: 1000 }],
      complete: true,
    });
    (getConversationMessages as jest.Mock).mockResolvedValue([]);
    (hasStoredWraps as jest.Mock).mockResolvedValue(true);

    await fetchConversationFor(baseParams());

    for (const [key, value] of setItem.mock.calls as [string, string][]) {
      expect(key).toContain('last_seen'); // cursors only — no content blobs
      expect(value).not.toContain('plaintext'); // the decrypted text never lands
    }
    expect(setItem.mock.calls.length).toBeGreaterThan(0); // the cursor did write
  });
});
