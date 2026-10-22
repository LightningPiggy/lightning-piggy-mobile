/**
 * Unit tests for useGroupComposerActions optimistic-bubble + failure-path
 * semantics (#1033). The 1:1 sibling is useConversationComposerActions.test.tsx.
 *
 * Key assertions:
 *  1. `onRumorReady` fires (and the bubble is appended) BEFORE any signing —
 *     verified by passing a signer that never resolves; the row still appears.
 *  2. A failed text send keeps its bubble, marked failed (state + storage),
 *     with pending → failed / sent ticks in the group delivery store.
 *  3. The 'Saved on relay, not on device' case (appendGroupMessage throws after
 *     a successful relay send) does NOT remove the row.
 */

import type { EncryptedUpload } from '../services/imageUploadService';
import { parseFileAttachment } from '../utils/fileAttachment';
import { renderHook, act } from '@testing-library/react-native';
import { useGroupComposerActions } from './useGroupComposerActions';
import type { GroupSendHooks } from '../contexts/useGroupMessaging';
import type { Group } from '../types/groups';
import { __resetGroupDeliveryStore, getGroupDeliveryStatus } from '../utils/groupDeliveryStore';

// ---------------------------------------------------------------------------
// Mocks — note: jest.mock factories are hoisted to module top and cannot
// reference variables defined in the module body. Use string literals or
// `mock`-prefixed vars (allowed by jest's hoisting heuristic) instead.
// ---------------------------------------------------------------------------

let mockSendFile: (file: EncryptedUpload, kind: 'file') => Promise<boolean>;
const mockSendGroupMessage = jest.fn();
const mockNotifyGroupMessage = jest.fn();

// MY_PUBKEY referenced inside the mock factory must use the `mock`-prefix
// convention so jest's babel transform doesn't reject the out-of-scope access.
const mockMyPubkey = 'a'.repeat(64);

jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({
    sendGroupMessage: mockSendGroupMessage,
    pubkey: mockMyPubkey,
    isLoggedIn: true,
    signEvent: jest.fn(),
  }),
  notifyGroupMessage: (...args: unknown[]) => mockNotifyGroupMessage(...args),
}));

const mockFilePicker = jest.fn();
const mockFileUpload = jest.fn();
jest.mock('../services/walletStorageService', () => ({ getActivePubkey: () => mockMyPubkey }));
jest.mock('expo-file-system', () => ({
  File: { pickFileAsync: () => mockFilePicker() },
  Paths: { cache: { uri: 'file:///cache/' } },
}));
jest.mock('../services/imageUploadService', () => ({
  uploadEncryptedBlob: (...args: unknown[]) => mockFileUpload(...args),
}));
jest.mock('../services/documentMetadata', () => ({
  selectedDocumentName: async () => 'invoice.pdf',
}));

// Storage mock: track calls and control return values per-test.
const mockAppendGroupMessage = jest.fn();
const mockRemoveGroupMessage = jest.fn();
const mockMarkGroupMessageSendFailed = jest.fn();

jest.mock('../services/groupMessagesStorageService', () => ({
  appendGroupMessage: (...args: unknown[]) => mockAppendGroupMessage(...args),
  removeGroupMessage: (...args: unknown[]) => mockRemoveGroupMessage(...args),
  markGroupMessageSendFailed: (...args: unknown[]) => mockMarkGroupMessageSendFailed(...args),
}));

const mockAlert = jest.fn();
jest.mock('../components/BrandedAlert', () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
}));

// Identity translator: the hook reads `t` from LocaleContext. A stable
// function so the hook's callbacks keep their identities across renders.
const mockT = (key: string) => key;
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => mockT }));

// useComposerActions has its own side-effects we don't need for these tests.
jest.mock('./useComposerActions', () => ({
  useComposerActions: ({
    strategy,
    draft,
  }: {
    strategy: {
      sendText: (text: string) => Promise<boolean>;
      sendMessage?: (text: string) => Promise<boolean>;
      sendFile: typeof mockSendFile;
    };
    draft: string;
  }) => {
    mockSendFile = strategy.sendFile;
    return { handleSend: () => (strategy.sendMessage ?? strategy.sendText)(draft) };
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MY_PUBKEY = mockMyPubkey;
const GROUP_ID = 'group-001';
const MEMBER_1 = 'b'.repeat(64);
const MEMBER_2 = 'c'.repeat(64);

const GROUP = {
  id: GROUP_ID,
  name: 'Test Group',
  memberPubkeys: [MY_PUBKEY, MEMBER_1, MEMBER_2],
  createdAt: 1700000000,
  updatedAt: 1700000000,
};

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function setup(
  replyTo?: string,
  onReplySent?: (target: string | undefined) => void,
  encodeMessage?: (text: string) => string,
) {
  const setMessages = jest.fn();
  const scrollToEnd = jest.fn();
  const { result, rerender } = renderHook(
    ({ target }: { target: string | undefined }) =>
      useGroupComposerActions({
        group: GROUP,
        replyTo: target,
        onReplySent,
        encodeMessage,
        draft: 'hello',
        setDraft: jest.fn(),
        setMessages,
        scrollToEnd,
        setAttachPanelOpen: jest.fn(),
        setGifPickerOpen: jest.fn(),
        setContactPickerOpen: jest.fn(),
        setVoiceSheetOpen: jest.fn(),
      }),
    { initialProps: { target: replyTo } },
  );
  return { result, rerender, setMessages, scrollToEnd };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAlert.mockReset();
  // By default, appendGroupMessage resolves with a list containing one row.
  mockAppendGroupMessage.mockResolvedValue([
    { id: 'local_stub', senderPubkey: MY_PUBKEY, text: 'hello', createdAt: 1700000001 },
  ]);
  mockRemoveGroupMessage.mockResolvedValue([]);
  mockMarkGroupMessageSendFailed.mockResolvedValue([
    { id: 'local_stub', senderPubkey: MY_PUBKEY, text: 'hello', createdAt: 1, sendFailed: true },
  ]);
});

// ---------------------------------------------------------------------------
// Test 1: onRumorReady fires before signing
// ---------------------------------------------------------------------------

describe('useGroupComposerActions — onRumorReady fires before any signing (#1033)', () => {
  it('appends the optimistic bubble from onRumorReady even when the signer never resolves', async () => {
    // Signer (underlying send) that NEVER resolves — simulates hung Amber or slow bunker.
    mockSendGroupMessage.mockImplementation(
      (_input: unknown, hooks?: GroupSendHooks): Promise<never> => {
        // onRumorReady fires synchronously before any await.
        hooks?.onRumorReady?.({ rumorId: 'test-rumor-id', kind: 14 });
        // Never resolve — signer is hung.
        return new Promise<never>(() => {});
      },
    );

    const { result, setMessages } = setup();

    // Start the send but don't await it (it'll hang).
    act(() => {
      void result.current.sendText('hello');
    });

    // The in-memory setMessages call happened immediately from onRumorReady.
    expect(setMessages).toHaveBeenCalled();
    // The cross-screen notify must NOT fire until the AsyncStorage append
    // has actually settled — GroupConversationScreen/GroupsContext reload
    // from storage on this event, so notifying too early can clobber the
    // just-painted optimistic row with a stale snapshot (the bug fixed by
    // reordering notifyGroupMessage to run inside appendGroupMessage's
    // resolution handler, not synchronously alongside the optimistic paint).
    expect(mockNotifyGroupMessage).not.toHaveBeenCalled();
    // appendGroupMessage was called (fire-and-forget storage write).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockAppendGroupMessage).toHaveBeenCalled();
    // Only now — after the storage write has settled — does the notify fire.
    expect(mockNotifyGroupMessage).toHaveBeenCalledWith(
      GROUP_ID,
      expect.objectContaining({ text: 'hello' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test 2: successful send appends the optimistic row
// ---------------------------------------------------------------------------

describe('useGroupComposerActions — successful send appends the optimistic row', () => {
  it('calls appendGroupMessage and does NOT call removeGroupMessage on success', async () => {
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor-ok', kind: 14 });
      return { success: true, wrapsPublished: 6 };
    });

    const { result } = setup();
    await act(async () => {
      await result.current.sendText('hello');
    });

    expect(mockAppendGroupMessage).toHaveBeenCalled();
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test 3: a failed text send keeps its bubble, marked failed
// ---------------------------------------------------------------------------

const rowIdOf = () => (mockAppendGroupMessage.mock.calls[0][2] as { id: string }).id;

describe('useGroupComposerActions — a failed text send keeps its bubble, marked failed', () => {
  beforeEach(() => __resetGroupDeliveryStore());

  it('shows the row pending, then marks it failed (state + storage) without an alert', async () => {
    let finish: (r: unknown) => void = () => undefined;
    mockSendGroupMessage.mockImplementation((_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor-fail', kind: 14, relays: ['wss://a', 'wss://b'] });
      return new Promise((resolve) => (finish = resolve));
    });

    const { result, setMessages } = setup();
    let sent: Promise<boolean> = Promise.resolve(false);
    act(() => {
      sent = result.current.sendText('hello');
    });
    expect(getGroupDeliveryStatus(rowIdOf())).toMatchObject({
      pending: true,
      eventId: 'rumor-fail',
    });

    await act(async () => {
      finish({ success: false, error: 'all relays rejected' });
      expect(await sent).toBe(true); // the bubble holds it: no draft restore
    });

    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    expect(mockMarkGroupMessageSendFailed).toHaveBeenCalledWith(mockMyPubkey, GROUP_ID, rowIdOf());
    const status = getGroupDeliveryStatus(rowIdOf());
    expect(status?.pending).toBeFalsy();
    expect(Object.values(status?.relayResults ?? {})).toEqual(['failed', 'failed']);
    // The in-memory row is marked too, before storage answers.
    const updaters = setMessages.mock.calls.map((c) => c[0]).filter((a) => typeof a === 'function');
    const marked = updaters
      .map((fn) => fn([{ id: rowIdOf(), senderPubkey: MY_PUBKEY, text: 'hello', createdAt: 1 }]))
      .find((rows: { sendFailed?: boolean }[]) => rows[0]?.sendFailed);
    expect(marked).toBeDefined();
  });

  it('does not wipe the visible thread when marking the row rejects on a storage error', async () => {
    mockMarkGroupMessageSendFailed.mockRejectedValue(new Error('transient storage error'));
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor-fail-storage', kind: 14 });
      return { success: false, error: 'all relays rejected' };
    });

    const { result, setMessages } = setup();
    await act(async () => {
      await result.current.sendText('hello');
    });

    expect(mockMarkGroupMessageSendFailed).toHaveBeenCalled();
    for (const call of setMessages.mock.calls) {
      const arg = call[0];
      if (Array.isArray(arg)) expect(arg.length).toBeGreaterThan(0);
    }
  });

  it('counts a partial send (not every member got it) as failed, even if relays took some wraps', async () => {
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor-partial', kind: 14, relays: ['wss://a'] });
      return {
        success: false,
        wrapsPublished: 2,
        error: 'Sent to 2 of 5 members. Relay refused wrap for member 3.',
        delivery: { delivered: true, relayResults: { 'wss://a': 'ok' }, targetRelayCount: 1 },
      };
    });

    const { result } = setup();
    await act(async () => {
      await result.current.sendText('hello');
    });

    expect(getGroupDeliveryStatus(rowIdOf())?.relayResults).toEqual({ 'wss://a': 'ok' });
    expect(mockMarkGroupMessageSendFailed).toHaveBeenCalled();
  });

  it('settles a successful send to its per-relay result', async () => {
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor-ok', kind: 14, relays: ['wss://a', 'wss://b'] });
      return {
        success: true,
        wrapsPublished: 3,
        delivery: {
          delivered: true,
          relayResults: { 'wss://a': 'ok', 'wss://b': 'failed' },
          targetRelayCount: 2,
          pending: true,
        },
      };
    });

    const { result } = setup();
    await act(async () => {
      await result.current.sendText('hello');
    });

    expect(getGroupDeliveryStatus(rowIdOf())).toMatchObject({
      delivered: true,
      relayResults: { 'wss://a': 'ok', 'wss://b': 'failed' },
      eventId: 'rumor-ok',
      pending: undefined,
    });
    expect(mockMarkGroupMessageSendFailed).not.toHaveBeenCalled();
  });

  it('still alerts when the send failed before any bubble was painted', async () => {
    mockSendGroupMessage.mockResolvedValue({ success: false, error: 'Not logged in' });
    const { result } = setup();
    await act(async () => {
      expect(await result.current.sendText('hello')).toBe(false);
    });
    expect(mockAlert).toHaveBeenCalledWith('Send failed', 'Not logged in');
  });
});

// ---------------------------------------------------------------------------
// Test 4: 'Saved on relay, not on device' case is NOT affected
// ---------------------------------------------------------------------------

describe("useGroupComposerActions — 'Saved on relay, not on device' path intact", () => {
  it('does NOT call removeGroupMessage when appendGroupMessage throws after a successful send', async () => {
    // Storage write throws — but the relay send SUCCEEDED.
    mockAppendGroupMessage.mockRejectedValue(new Error('AsyncStorage full'));

    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor-storage-err', kind: 14 });
      return { success: true, wrapsPublished: 5 };
    });

    const { result } = setup();
    await act(async () => {
      await result.current.sendText('hello');
    });

    // The storage-error alert (not the "Send failed" alert) fires.
    expect(mockAlert).toHaveBeenCalledWith('Saved on relay, not on device', expect.any(String));
    // No removal — the message reached the relay.
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
  });
});

it('sends the quoted group target, persists it in the optimistic row and clears it only on success', async () => {
  const parent = 'd'.repeat(64);
  const clearReply = jest.fn();
  mockSendGroupMessage.mockImplementation((_input: unknown, hooks?: GroupSendHooks) => {
    hooks?.onRumorReady?.({ rumorId: 'sent', kind: 14 });
    return Promise.resolve({ success: true });
  });
  const { result } = setup(parent, clearReply);
  await act(async () => {
    await result.current.handleSend();
  });
  expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({ replyTo: parent, text: 'hello' });
  expect(mockAppendGroupMessage.mock.calls[0][2]).toMatchObject({ replyTo: parent });
  expect(clearReply).toHaveBeenCalledTimes(1);
  mockSendGroupMessage.mockResolvedValue({ success: false });
  await act(async () => {
    await result.current.handleSend();
  });
  expect(clearReply).toHaveBeenCalledTimes(1);
});

it.each(['resendText', 'sendText'] as const)(
  'keeps the active reply out of %s sends and preserves selection',
  async (method) => {
    const clearReply = jest.fn();
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'sent', kind: 14 });
      return { success: true };
    });
    const { result } = setup('parent', clearReply, (text) => `encoded:${text}`);
    await act(async () => {
      await result.current[method]('original payload');
    });
    expect(mockSendGroupMessage.mock.calls[0][0]).toMatchObject({ text: 'original payload' });
    expect(mockSendGroupMessage.mock.calls[0][0].replyTo).toBeUndefined();
    expect(mockAppendGroupMessage.mock.calls[0][2].replyTo).toBeUndefined();
    expect(clearReply).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.handleSend();
    });
    expect(mockSendGroupMessage.mock.calls[1][0]).toMatchObject({
      text: 'encoded:hello',
      replyTo: 'parent',
    });
    expect(clearReply).toHaveBeenCalledTimes(1);
  },
);

it.each(['reply-a', undefined])(
  'reports the send-time reply target %s when a new reply is selected during sending',
  async (target) => {
    let finishSend!: (value: { success: boolean }) => void;
    mockSendGroupMessage.mockImplementation(
      () =>
        new Promise<{ success: boolean }>((resolve) => {
          finishSend = resolve;
        }),
    );
    const onReplySent = jest.fn();
    const { result, rerender } = setup(target, onReplySent);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSend();
    });
    rerender({ target: 'reply-b' });
    expect(onReplySent).not.toHaveBeenCalled();
    await act(async () => {
      finishSend({ success: true });
      await pending;
    });
    expect(mockSendGroupMessage.mock.calls[0][0].replyTo).toBe(target);
    expect(onReplySent).toHaveBeenCalledWith(target);
  },
);

it('retains the encrypted document metadata in NIP-17 group optimistic rows', async () => {
  mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
    hooks?.onRumorReady?.({ rumorId: 'group-file', kind: 15 });
    return { success: true };
  });
  setup();
  const file: EncryptedUpload = {
    url: 'https://example.com/cipher.bin',
    mime: 'application/pdf',
    filename: 'invoice.pdf',
    keyHex: '11'.repeat(32),
    nonceHex: '22'.repeat(12),
    sha256Hex: '33'.repeat(32),
    size: 123,
  };
  await act(async () => {
    await mockSendFile(file, 'file');
  });
  const row = mockAppendGroupMessage.mock.calls[0][2];
  expect(row.wireKind).toBe(15);
  expect(parseFileAttachment(row.text)).toMatchObject({
    available: true,
    name: 'invoice.pdf',
    sha256: file.sha256Hex,
    size: 123,
  });
  expect(mockSendGroupMessage).toHaveBeenCalledWith(
    expect.objectContaining({ file }),
    expect.any(Object),
  );
});

it('excludes a member removed while the document upload is pending', async () => {
  let finishUpload!: (file: EncryptedUpload) => void;
  mockFilePicker.mockResolvedValue({
    uri: 'content://documents/invoice',
    type: 'application/pdf',
    size: 8,
    base64: async () => Buffer.from('%PDF-1.4').toString('base64'),
  });
  mockFileUpload.mockImplementation(
    () =>
      new Promise<EncryptedUpload>((resolve) => {
        finishUpload = resolve;
      }),
  );
  mockSendGroupMessage.mockResolvedValue({ success: true });
  const { result, rerender } = renderHook(
    ({ group }: { group: Group }) =>
      useGroupComposerActions({
        group,
        draft: '',
        setDraft: jest.fn(),
        setMessages: jest.fn(),
        scrollToEnd: jest.fn(),
        setAttachPanelOpen: jest.fn(),
        setGifPickerOpen: jest.fn(),
        setContactPickerOpen: jest.fn(),
        setVoiceSheetOpen: jest.fn(),
      }),
    { initialProps: { group: GROUP } },
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = result.current.handlePickAndSendFile!();
  });
  expect(mockFileUpload).toHaveBeenCalledTimes(1);
  rerender({ group: { ...GROUP, memberPubkeys: [MY_PUBKEY, MEMBER_1] } });
  await act(async () => {
    finishUpload({
      url: 'https://example.com/file',
      mime: 'application/pdf',
      keyHex: 'ab'.repeat(32),
      nonceHex: 'cd'.repeat(12),
    } as EncryptedUpload);
    await pending;
  });
  expect(mockSendGroupMessage).toHaveBeenCalledWith(
    expect.objectContaining({ memberPubkeys: [MY_PUBKEY, MEMBER_1] }),
    expect.anything(),
  );
});

it('retains the visible failed row when append fails and marking returns an empty log', async () => {
  mockAppendGroupMessage.mockRejectedValue(new Error('storage unavailable'));
  mockMarkGroupMessageSendFailed.mockResolvedValue([]);
  mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
    hooks?.onRumorReady?.({ rumorId: 'failed', kind: 14 });
    return { success: false };
  });
  const { result, setMessages } = setup();
  await act(async () => {
    expect(await result.current.sendText('hello')).toBe(true);
  });
  const echoed = { id: 'echo', localId: rowIdOf(), text: 'hello' };
  const lastUpdate = setMessages.mock.calls.at(-1)![0];
  expect(lastUpdate([echoed])).toEqual([{ ...echoed, sendFailed: true }]);
  expect(setMessages.mock.calls.every(([update]) => typeof update === 'function')).toBe(true);
});

it.each(['reply', 'vote'])(
  'rolls back a failed %s after persistence and reports failure',
  async (type) => {
    let persist!: (rows: unknown[]) => void;
    mockAppendGroupMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          persist = resolve;
        }),
    );
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'failed', kind: 14 });
      return { success: false };
    });
    const clearReply = jest.fn();
    const { result, setMessages } = setup(type === 'reply' ? 'parent' : undefined, clearReply);
    let pending!: Promise<unknown>;
    await act(async () => {
      pending =
        type === 'reply'
          ? result.current.handleSend()
          : result.current.sendText('[POLL_VOTE] poll-id 1');
    });
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    await act(async () => {
      persist([mockAppendGroupMessage.mock.calls[0][2]]);
      expect(await pending).toBe(false);
    });
    expect(mockRemoveGroupMessage).toHaveBeenCalledWith(MY_PUBKEY, GROUP_ID, rowIdOf());
    expect(clearReply).not.toHaveBeenCalled();
    expect(mockMarkGroupMessageSendFailed).not.toHaveBeenCalled();
    const remove = setMessages.mock.calls.at(-1)![0];
    expect(remove([{ id: 'echo', localId: rowIdOf() }, { id: 'keep' }])).toEqual([{ id: 'keep' }]);
  },
);

it.each([true, false])(
  'wires final delivery to the composer store (final first: %s)',
  async (finalFirst) => {
    let finalize!: NonNullable<GroupSendHooks['onDeliveryFinalized']>;
    const final = { delivered: true, relayResults: { a: 'ok' as const, b: 'ok' as const } };
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'rumor', kind: 14 });
      finalize = hooks!.onDeliveryFinalized!;
      if (finalFirst) finalize(final);
      return { success: false, delivery: { delivered: true, relayResults: { a: 'ok' } } };
    });
    const { result } = setup();
    await act(async () => {
      await result.current.sendText('hello');
    });
    if (!finalFirst) finalize(final);
    expect(getGroupDeliveryStatus(rowIdOf())).toMatchObject({ ...final, sendFailed: true });
  },
);

describe('group Re-publish replaces a failed original only after confirmed success', () => {
  it('waits for both relay success and local persistence before removing the original', async () => {
    let finish!: (result: { success: boolean }) => void;
    let persist!: (rows: unknown[]) => void;
    mockAppendGroupMessage.mockImplementation(() => new Promise((resolve) => (persist = resolve)));
    mockSendGroupMessage.mockImplementation((_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'retry-rumor', kind: 14 });
      return new Promise((resolve) => (finish = resolve));
    });
    const { result, setMessages } = setup();
    let retry!: Promise<boolean>;
    act(() => {
      retry = result.current.resendText('hello', 'failed-original');
    });
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    await act(async () => finish({ success: true }));
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    await act(async () => {
      persist([mockAppendGroupMessage.mock.calls[0][2]]);
      expect(await retry).toBe(true);
    });
    expect(mockRemoveGroupMessage).toHaveBeenCalledWith(MY_PUBKEY, GROUP_ID, 'failed-original');
    const remove = setMessages.mock.calls.at(-1)![0];
    expect(remove([{ id: 'echo', localId: 'failed-original' }, { id: rowIdOf() }])).toEqual([
      { id: rowIdOf() },
    ]);
  });

  it('reports a failed retry truthfully and keeps the original available', async () => {
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'retry-rumor', kind: 14 });
      return { success: false };
    });
    const { result } = setup();
    await act(async () => {
      expect(await result.current.resendText('hello', 'failed-original')).toBe(false);
    });
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    expect(mockMarkGroupMessageSendFailed).toHaveBeenCalledWith(MY_PUBKEY, GROUP_ID, rowIdOf());
  });

  it('keeps the original when the retry succeeds on relays but cannot be persisted', async () => {
    mockAppendGroupMessage.mockRejectedValue(new Error('storage unavailable'));
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'retry-rumor', kind: 14 });
      return { success: true };
    });
    const { result } = setup();
    await act(async () => {
      expect(await result.current.resendText('hello', 'failed-original')).toBe(false);
    });
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalled();
  });

  it('leaves a successfully sent original alone when re-publishing it', async () => {
    mockSendGroupMessage.mockImplementation(async (_input: unknown, hooks?: GroupSendHooks) => {
      hooks?.onRumorReady?.({ rumorId: 'retry-rumor', kind: 14 });
      return { success: true };
    });
    const { result } = setup();
    await act(async () => {
      expect(await result.current.resendText('hello')).toBe(true);
    });
    expect(mockRemoveGroupMessage).not.toHaveBeenCalled();
  });
});
