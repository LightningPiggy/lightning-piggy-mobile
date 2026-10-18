import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DmProtocol } from '../utils/dmProtocol';
import type { BrandedAlertButton } from '../components/BrandedAlert';
import { renderHook, act } from '@testing-library/react-native';
import { useConversationComposerActions } from './useConversationComposerActions';
import { getDmDeliveryStatus, __resetDmDeliveryStore } from '../utils/dmDeliveryStore';
import type { SendHooks, SendResult } from '../contexts/useMessageSend';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';

// Mock the Nostr provider so the hook can run without a full context tree.
// `mockSendDirectMessage` is overridden per-test to drive the send outcome.
// `mock`-prefixed so jest's mock-hoisting allows referencing them in the factory.
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
const mockSendDirectMessage = jest.fn();
const mockAppendLocalDmMessage = jest.fn().mockResolvedValue(undefined);
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({
    sendDirectMessage: mockSendDirectMessage,
    sendFileMessage: jest.fn(),
    appendLocalDmMessage: mockAppendLocalDmMessage,
    pubkey: 'f'.repeat(64),
    isLoggedIn: true,
    signEvent: jest.fn(),
    relays: [],
  }),
  useNostrContacts: () => ({ contacts: [] }),
}));

// Spy on the branded alert so we can assert it does / doesn't fire.
const mockAlert = jest.fn();
jest.mock('../components/BrandedAlert', () => ({
  Alert: { alert: (...args: unknown[]) => mockAlert(...args) },
}));

const EVENT_ID = 'rumor-event-id-857';
const PUBKEY = 'a'.repeat(64);
// Target relays the send fans out to — carried on onRumorReady so the
// pending/failed status can seed its relay breakdown for the info sheet.
const RELAYS = ['wss://a', 'wss://b'];

function setup(protocol?: DmProtocol, onMarmotFallback?: () => void) {
  const setMessages = jest.fn();
  const setDraft = jest.fn();
  const { result } = renderHook(() =>
    useConversationComposerActions({
      protocol,
      pubkey: PUBKEY,
      name: 'Big Piggy',
      draft: 'hi',
      setDraft,
      setMessages,
      setAttachPanelOpen: jest.fn(),
      setContactPickerOpen: jest.fn(),
      setGifPickerOpen: jest.fn(),
      setVoiceSheetOpen: jest.fn(),
      onMarmotFallback,
    }),
  );
  return { result, setMessages, setDraft };
}

// Answer the next branded alert by pressing the button with this label.
function answerAlertWith(label: string) {
  mockAlert.mockImplementation((_title: string, _message: string, buttons: BrandedAlertButton[]) =>
    buttons.find((b) => b.text === label)?.onPress?.(),
  );
}

describe('useConversationComposerActions.sendText — optimistic + failed-keep-bubble (#857)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    __resetDmDeliveryStore();
    mockSendDirectMessage.mockReset();
    mockAppendLocalDmMessage.mockClear();
    mockAlert.mockReset();
  });

  it('uses NIP-04 for typed messages and NIP-17 for GIF attachments', async () => {
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, _text: string, hooks?: SendHooks) => {
        hooks?.onRumorReady?.({
          eventId: EVENT_ID,
          kind: hooks.protocol === 'nip04' ? 4 : 14,
          relays: RELAYS,
        });
        return { success: true };
      },
    );
    const { result } = setup('nip04');
    await act(async () => {
      await result.current.handleSend();
    });
    expect(mockSendDirectMessage).toHaveBeenLastCalledWith(
      PUBKEY,
      'hi',
      expect.objectContaining({ protocol: 'nip04' }),
    );
    expect(mockAppendLocalDmMessage).toHaveBeenLastCalledWith(
      PUBKEY,
      expect.objectContaining({ wireKind: 4 }),
    );
    await act(async () => {
      await result.current.handleSendGif({
        id: 'gif',
        url: 'https://example.com/a.gif',
        previewUrl: '',
        previewStillUrl: '',
        title: '',
      });
    });
    expect(mockSendDirectMessage).toHaveBeenLastCalledWith(
      PUBKEY,
      expect.any(String),
      expect.objectContaining({ protocol: 'nip17' }),
    );
    expect(mockAppendLocalDmMessage).toHaveBeenLastCalledWith(
      PUBKEY,
      expect.objectContaining({ wireKind: 14 }),
    );
  });

  // Marmot fails (no key package) before any bubble; NIP-17 sends succeed.
  function marmotUnreachableThenNip17() {
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, _text: string, hooks?: SendHooks): Promise<SendResult> => {
        if (hooks?.protocol === 'marmot') {
          return { success: false, error: 'no key package', marmotUnreachable: 'noKeyPackage' };
        }
        hooks?.onRumorReady?.({ eventId: `${EVENT_ID}-${_text}`, kind: 14, relays: RELAYS });
        return { success: true };
      },
    );
  }
  const sentProtocols = () =>
    mockSendDirectMessage.mock.calls.map((c) => (c[2] as SendHooks).protocol);
  const sentTexts = () => mockSendDirectMessage.mock.calls.map((c) => c[1] as string);

  it('asks before sending over NIP-17 when Marmot cannot reach the peer', async () => {
    marmotUnreachableThenNip17();
    answerAlertWith('Send with NIP-17');
    const onMarmotFallback = jest.fn();
    const { result, setDraft } = setup('marmot', onMarmotFallback);
    await act(async () => {
      await result.current.handleSend();
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockAlert.mock.calls[0][0]).toBe("Big Piggy isn't on Marmot yet");
    expect(mockAlert.mock.calls[0][1]).toMatch(/let them know you tried Marmot/);
    // The message, then (once) the note telling them we tried Marmot.
    expect(sentProtocols()).toEqual(['marmot', 'nip17', 'nip17']);
    expect(sentTexts()[1]).toBe('hi');
    expect(sentTexts()[2]).toMatch(/^I tried to message you on Marmot/);
    expect(onMarmotFallback).toHaveBeenCalledTimes(1);
    expect(setDraft).toHaveBeenCalledWith('');
    // Both bubbles are NIP-17 rows: not filed under the Marmot thread.
    expect(mockAppendLocalDmMessage).toHaveBeenCalledTimes(2);
    for (const call of mockAppendLocalDmMessage.mock.calls) {
      expect(call[1]).not.toHaveProperty('protocol');
    }
  });

  it('sends the note only once per thread', async () => {
    marmotUnreachableThenNip17();
    answerAlertWith('Send with NIP-17');
    const first = setup('marmot', jest.fn());
    await act(async () => {
      await first.result.current.handleSend();
    });
    mockSendDirectMessage.mockClear();
    const second = setup('marmot', jest.fn());
    await act(async () => {
      await second.result.current.handleSend();
    });
    expect(sentProtocols()).toEqual(['marmot', 'nip17']);
    // …and the dialog no longer promises one.
    expect(mockAlert.mock.calls[1][1]).not.toMatch(/let them know/);
  });

  it('moves the thread to NIP-17 before sending, so a failed send stays visible', async () => {
    const order: string[] = [];
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, _text: string, hooks?: SendHooks): Promise<SendResult> => {
        order.push(`send:${hooks?.protocol}`);
        return hooks?.protocol === 'marmot'
          ? { success: false, error: 'no key package', marmotUnreachable: 'noKeyPackage' }
          : { success: true };
      },
    );
    answerAlertWith('Send with NIP-17');
    const { result } = setup('marmot', () => order.push('switch'));
    await act(async () => {
      await result.current.handleSend();
    });
    expect(order.slice(0, 3)).toEqual(['send:marmot', 'switch', 'send:nip17']);
  });

  it('shares one dialog and one note between overlapping sends', async () => {
    marmotUnreachableThenNip17();
    let pressConfirm: (() => void) | undefined;
    mockAlert.mockImplementation(
      (_title: string, _message: string, buttons: BrandedAlertButton[]) => {
        pressConfirm = buttons[1].onPress;
      },
    );
    const { result } = setup('marmot', jest.fn());
    let both: Promise<unknown> | undefined;
    await act(async () => {
      both = Promise.all([
        result.current.offerNip17ForText('noKeyPackage', 'first'),
        result.current.offerNip17ForText('noKeyPackage', 'second'),
      ]);
      await new Promise((r) => setTimeout(r, 0));
    });
    await act(async () => {
      pressConfirm?.();
      await both;
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);
    const notes = sentTexts().filter((x) => x.startsWith('I tried to message you on Marmot'));
    expect(notes).toHaveLength(1);
    expect(sentTexts()).toEqual(expect.arrayContaining(['first', 'second']));
  });

  it('tries the note again next time if it failed to send', async () => {
    let noteFails = true;
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, text: string, hooks?: SendHooks): Promise<SendResult> => {
        if (hooks?.protocol === 'marmot') {
          return { success: false, error: 'no key package', marmotUnreachable: 'noKeyPackage' };
        }
        if (text.startsWith('I tried') && noteFails) return { success: false, error: 'offline' };
        return { success: true };
      },
    );
    answerAlertWith('Send with NIP-17');
    const first = setup('marmot', jest.fn());
    await act(async () => {
      await first.result.current.handleSend();
    });
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    noteFails = false;
    mockSendDirectMessage.mockClear();
    await act(async () => {
      await first.result.current.handleSend();
    });
    expect(sentTexts().filter((x) => x.startsWith('I tried'))).toHaveLength(1);
    expect(await AsyncStorage.getAllKeys()).toHaveLength(1);
  });

  it('sends nothing and keeps the draft when the user cancels', async () => {
    marmotUnreachableThenNip17();
    answerAlertWith('Cancel');
    const onMarmotFallback = jest.fn();
    const { result, setDraft } = setup('marmot', onMarmotFallback);
    await act(async () => {
      await result.current.handleSend();
    });
    expect(sentProtocols()).toEqual(['marmot']);
    expect(onMarmotFallback).not.toHaveBeenCalled();
    // Cleared on tap, then the draft comes back untouched.
    expect(setDraft.mock.calls).toEqual([[''], ['hi']]);
    expect(mockAppendLocalDmMessage).not.toHaveBeenCalled();
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
  });

  it('offers the same choice for a send made outside the composer (invoice)', async () => {
    marmotUnreachableThenNip17();
    answerAlertWith('Send with NIP-17');
    const onMarmotFallback = jest.fn();
    const { result } = setup('marmot', onMarmotFallback);
    let sent = false;
    await act(async () => {
      sent = await result.current.offerNip17ForText('outdatedKeyPackage', 'lnbc1invoice');
    });
    expect(sent).toBe(true);
    expect(mockAlert.mock.calls[0][0]).toBe("Big Piggy's Marmot app needs opening or updating");
    expect(sentTexts()[0]).toBe('lnbc1invoice');
    expect(sentProtocols()[0]).toBe('nip17');
    expect(onMarmotFallback).toHaveBeenCalledTimes(1);
  });

  it('does not fall back for an ordinary Marmot failure', async () => {
    mockSendDirectMessage.mockResolvedValue({ success: false, error: 'relay down' });
    const onMarmotFallback = jest.fn();
    const { result } = setup('marmot', onMarmotFallback);
    await act(async () => {
      await result.current.handleSend();
    });
    expect(mockSendDirectMessage).toHaveBeenCalledTimes(1);
    expect(onMarmotFallback).not.toHaveBeenCalled();
    expect(mockAlert).toHaveBeenCalledWith('Send failed', 'relay down');
  });

  it('paints a pending bubble immediately, then settles it to delivered', async () => {
    const delivered: DeliveryStatus = {
      delivered: true,
      relayResults: { 'wss://a': 'ok', 'wss://b': 'ok' },
      eventId: EVENT_ID,
      kind: 14,
    };
    let pendingSeenInStore = false;
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, _text: string, hooks?: SendHooks): Promise<SendResult> => {
        // The hook fires onRumorReady synchronously — at that instant the store
        // must already carry a PENDING status (the instant bubble).
        hooks?.onRumorReady?.({ eventId: EVENT_ID, kind: 14, relays: RELAYS });
        const seeded = getDmDeliveryStatus(EVENT_ID);
        pendingSeenInStore = seeded?.pending === true;
        // The pending status seeds its relay breakdown from the target relays
        // (the missing-relays fix): the info sheet can list them while in flight.
        expect(Object.keys(seeded?.relayResults ?? {})).toEqual(RELAYS);
        return { success: true, delivery: delivered };
      },
    );

    const { result, setMessages } = setup();
    await act(async () => {
      await result.current.handleSend?.();
    });

    // Bubble appended optimistically before the send resolved. The row id is
    // `local-` prefixed (so the echo dedups it), and it carries `rumorId` —
    // the stable delivery-store key shared with the echo.
    expect(setMessages).toHaveBeenCalled();
    expect(mockAppendLocalDmMessage).toHaveBeenCalledWith(
      PUBKEY,
      expect.objectContaining({
        id: `local-${EVENT_ID}`,
        rumorId: EVENT_ID,
        fromMe: true,
        wireKind: 14,
      }),
    );
    expect(pendingSeenInStore).toBe(true);
    // Settled to delivered after the send resolved.
    expect(getDmDeliveryStatus(EVENT_ID)?.delivered).toBe(true);
    expect(getDmDeliveryStatus(EVENT_ID)?.pending).toBeFalsy();
  });

  it('keeps the bubble on a failed send (red status in store) instead of dropping it', async () => {
    const failedDelivery: DeliveryStatus = {
      delivered: false,
      relayResults: { 'wss://a': 'failed', 'wss://b': 'failed' },
      eventId: EVENT_ID,
      kind: 14,
    };
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, _text: string, hooks?: SendHooks): Promise<SendResult> => {
        hooks?.onRumorReady?.({ eventId: EVENT_ID, kind: 14, relays: RELAYS });
        return { success: false, delivery: failedDelivery, error: 'all relays down' };
      },
    );

    const { result } = setup();
    await act(async () => {
      await result.current.handleSend?.();
    });

    // The bubble survives: a settled, non-pending, failed status sits in the
    // store keyed by eventId — the red tick the user taps to Re-publish.
    const status = getDmDeliveryStatus(EVENT_ID);
    expect(status?.pending).toBeFalsy();
    expect(status?.delivered).toBe(false);
    // No dead-end alert — the bubble itself carries the failure.
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('watchdog flips the bubble to failed if the send hangs (offline, never settles)', async () => {
    jest.useFakeTimers();
    try {
      // Offline: the send never resolves (pool.publish promises hang). The
      // watchdog must still flip the pending bubble to a red failed tick.
      mockSendDirectMessage.mockImplementation(
        (_pk: string, _text: string, hooks?: SendHooks): Promise<SendResult> => {
          hooks?.onRumorReady?.({ eventId: EVENT_ID, kind: 14, relays: RELAYS });
          return new Promise<SendResult>(() => {}); // never settles
        },
      );

      const { result } = setup();
      act(() => {
        void result.current.handleSend?.();
      });
      // Pending immediately.
      expect(getDmDeliveryStatus(EVENT_ID)?.pending).toBe(true);
      // After the watchdog window (20s — covers the publish layer's
      // stale-socket retry, two 8s attempts), the bubble settles to failed.
      act(() => {
        jest.advanceTimersByTime(21_000);
      });
      const status = getDmDeliveryStatus(EVENT_ID);
      expect(status?.pending).toBeFalsy();
      expect(status?.delivered).toBe(false);
      // The hung-send failed status still carries the attempted relays (seeded
      // as failed) so the info sheet lists them — not an empty breakdown.
      expect(Object.keys(status?.relayResults ?? {})).toEqual(RELAYS);
    } finally {
      jest.useRealTimers();
    }
  });

  it('settles to the finalized breakdown when slow relays ack after the early resolve', async () => {
    const earlySingle: DeliveryStatus = {
      delivered: true,
      relayResults: { 'wss://a': 'ok' },
      eventId: EVENT_ID,
      kind: 14,
    };
    const finalDouble: DeliveryStatus = {
      delivered: true,
      relayResults: { 'wss://a': 'ok', 'wss://b': 'ok' },
      eventId: EVENT_ID,
      kind: 14,
    };
    // Capture the finalize callback so the test fires it deterministically
    // (rather than racing a timer against the early assertion).
    let finalize: ((d: DeliveryStatus) => void) | undefined;
    mockSendDirectMessage.mockImplementation(
      async (_pk: string, _text: string, hooks?: SendHooks): Promise<SendResult> => {
        hooks?.onRumorReady?.({ eventId: EVENT_ID, kind: 14, relays: RELAYS });
        finalize = hooks?.onDeliveryFinalized;
        return { success: true, delivery: earlySingle };
      },
    );

    const { result } = setup();
    await act(async () => {
      await result.current.handleSend?.();
    });
    // Early: single relay.
    expect(Object.keys(getDmDeliveryStatus(EVENT_ID)?.relayResults ?? {})).toHaveLength(1);
    // Slow relay acks → the finalized breakdown upgrades the store to both.
    act(() => finalize?.(finalDouble));
    expect(Object.keys(getDmDeliveryStatus(EVENT_ID)?.relayResults ?? {})).toHaveLength(2);
  });
});
