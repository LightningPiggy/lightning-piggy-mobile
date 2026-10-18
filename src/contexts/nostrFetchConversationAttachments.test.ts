import { fetchConversationFor } from './nostrFetchConversation';
import { ingestInboxWraps } from './dmWrapIngest';
import { rowsToInboxEntries } from '../services/dmInbox';
import { getConversationMessages, upsertDmMessages } from '../services/dmDb';
import { textForRumor, unwrapWrapNsec, type DecodedRumor } from '../utils/nip17Unwrap';
import { classifyStoredMessage } from '../utils/messageContent';

jest.mock('../services/nostrService', () => ({
  fetchDirectMessageEvents: jest.fn(async () => []),
  fetchInboxDmEvents: jest.fn(async () => ({ kind1059: [{ id: 'document-wrap' }] })),
}));
jest.mock('../services/dmDb', () => ({
  getConversationMessages: jest.fn(async () => []),
  hasStoredWraps: jest.fn(async () => false),
  selectKnownEventIds: jest.fn(async () => new Set<string>()),
  upsertDmMessages: jest.fn(async () => undefined),
  LOCAL_DM_ID_PREFIX: 'local-',
  LOCAL_DM_ECHO_WINDOW_SECS: 30,
}));
jest.mock('./dmStoreMigrationRunner', () => ({
  ensureDmStoreMigrated: jest.fn(async () => undefined),
}));
jest.mock('./nostrSecretKeyCache', () => ({
  getMemoisedSecretKey: jest.fn(async () => new Uint8Array(32)),
  nip04PlaintextCache: new Map(),
}));
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: jest.fn(async () => ({ kind: 'not-group' })),
}));
jest.mock('../utils/nip17Unwrap', () => ({
  ...jest.requireActual('../utils/nip17Unwrap'),
  unwrapWrapNsec: jest.fn(),
}));
// Observe the real ingest result as well as the final conversation projection.
jest.mock('./dmWrapIngest', () => ({
  ...jest.requireActual('./dmWrapIngest'),
  ingestInboxWraps: jest.fn(jest.requireActual('./dmWrapIngest').ingestInboxWraps),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

it.each([14, 15])(
  'renders a kind-%s document card on the first cold thread load while redacting inbox previews',
  async (kind) => {
    const owner = 'b'.repeat(64);
    const peer = 'a'.repeat(64);
    const content = 'https://files.example/invoice.pdf?token=private';
    const rumor: DecodedRumor = {
      kind,
      pubkey: peer,
      created_at: 100,
      tags: [
        ['p', owner],
        ...(kind === 15
          ? [
              ['file-type', 'application/pdf'],
              ['encryption-algorithm', 'aes-gcm'],
              ['decryption-key', 'a'.repeat(64)],
              ['decryption-nonce', 'b'.repeat(24)],
              ['size', '19723'],
              ['x', 'c'.repeat(64)],
            ]
          : []),
      ],
      content,
    };
    jest.mocked(unwrapWrapNsec).mockReturnValue(rumor);
    const renderText = textForRumor(rumor);
    const preview = kind === 15 ? '📎 Attachment' : '📎 File';

    const messages = await fetchConversationFor({
      pubkey: owner,
      isLoggedIn: true,
      signerType: 'nsec',
      getReadRelays: () => ['wss://relay.example'],
      decryptNip04ViaSigner: jest.fn(),
      otherPubkey: peer,
      protocol: 'nip17',
    });

    expect(getConversationMessages).toHaveBeenCalledTimes(1);
    expect(await jest.mocked(getConversationMessages).mock.results[0].value).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: renderText, wireKind: kind });
    // Use the same classifier as the message bubble to verify card rendering.
    expect(classifyStoredMessage(messages[0].text, messages[0].wireKind)).toMatchObject({
      kind: 'file',
      file: { name: 'invoice.pdf' },
    });

    if (kind === 15) {
      expect(classifyStoredMessage(messages[0].text, messages[0].wireKind)).toMatchObject({
        kind: 'file',
        file: {
          encrypted: true,
          available: true,
          size: 19723,
          keyHex: 'a'.repeat(64),
          nonceHex: 'b'.repeat(24),
        },
      });
    }

    const { entries } = await jest.mocked(ingestInboxWraps).mock.results[0].value;
    expect(entries[0]).toMatchObject({ text: preview, renderText });
    const rows = jest.mocked(upsertDmMessages).mock.calls[0][0];
    expect(rows[0]).toMatchObject({ content: renderText, wireKind: kind });
    expect(rowsToInboxEntries(rows)[0].text).toBe(preview);
  },
);
