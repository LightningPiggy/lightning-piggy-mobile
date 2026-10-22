import { renderHook, act } from '@testing-library/react-native';
import { useMessageInfoSheet } from './useMessageInfoSheet';
import { protocolLabel, type DeliveryStatus } from '../utils/dmDeliveryStatus';
import { messageKindLabel } from '../utils/messageInfo';

// The message-info sheet (#856): direction mapping + the Re-publish gate.
// Re-publish is offered ONLY for a sent kind-14 text message with a payload —
// never for received messages, non-text (empty payload), or kind-15 files.

const delivery: DeliveryStatus = {
  delivered: true,
  relayResults: { 'wss://a': 'ok' },
};

describe('useMessageInfoSheet', () => {
  it('records who sent the tapped bubble for the Marmot device rows (#1267)', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const senderOf = jest.fn((rowId: string, fromMe: boolean) => (fromMe ? 'me' : `of-${rowId}`));
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'marmot', senderOf));
    expect(result.current.sender).toBeNull();
    act(() => {
      result.current.showInfo({ fromMe: false, eventId: 'abc', wireKind: 14, resendText: '' });
    });
    expect(senderOf).toHaveBeenCalledWith('abc', false);
    expect(result.current.sender).toBe('of-abc');
    act(() => result.current.closeInfo());
    expect(result.current.sender).toBeNull();
  });

  it('has no sender when the screen gives no lookup', () => {
    const { result } = renderHook(() => useMessageInfoSheet(jest.fn(), 'nip17'));
    act(() => {
      result.current.showInfo({ fromMe: true, eventId: 'abc', resendText: 'x' });
    });
    expect(result.current.sender).toBeNull();
  });

  it('maps a tapped sent text bubble to a sent MessageInfo with Re-publish enabled', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({
        fromMe: true,
        eventId: 'abc',
        wireKind: 14,
        deliveryStatus: delivery,
        resendText: 'hello',
      });
    });
    expect(result.current.info?.direction).toBe('sent');
    expect(result.current.info?.wireKind).toBe(14);
    expect(result.current.canResend).toBe(true);
  });

  it('falls back to deliveryStatus.kind when the row has no wireKind yet', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({
        fromMe: true,
        eventId: 'abc',
        // wireKind undefined (optimistic local- row), but the send result
        // carries the rumor kind on deliveryStatus.
        deliveryStatus: { ...delivery, kind: 14 },
        resendText: 'hi',
      });
    });
    expect(result.current.info?.wireKind).toBe(14);
    expect(result.current.canResend).toBe(true);
  });

  it('disables Re-publish for a received message', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({
        fromMe: false,
        eventId: 'abc',
        wireKind: 14,
        resendText: 'hello',
      });
    });
    expect(result.current.info?.direction).toBe('received');
    expect(result.current.canResend).toBe(false);
  });

  it('enables Re-publish for a sent NIP-04 (kind 4) text message', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip04'));
    act(() => {
      result.current.showInfo({
        fromMe: true,
        eventId: 'abc',
        wireKind: 4,
        deliveryStatus: delivery,
        resendText: 'hello',
      });
    });
    expect(result.current.canResend).toBe(true);
  });

  it('disables Re-publish for a sent kind-15 file message', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({
        fromMe: true,
        eventId: 'abc',
        wireKind: 15,
        deliveryStatus: delivery,
        resendText: 'https://blossom/file.mp4#k=…',
      });
    });
    expect(result.current.canResend).toBe(false);
  });

  it('disables Re-publish when the resend payload is empty (non-text)', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({ fromMe: true, eventId: 'abc', wireKind: 14, resendText: '' });
    });
    expect(result.current.canResend).toBe(false);
  });

  it('resendFromInfo calls the send fn with the payload and closes the sheet', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({
        fromMe: true,
        eventId: 'abc',
        wireKind: 14,
        deliveryStatus: delivery,
        resendText: 'hello',
      });
    });
    act(() => result.current.resendFromInfo());
    expect(resend).toHaveBeenCalledWith('hello');
    expect(result.current.info).toBeNull();
  });

  // #1296: the group screen passes its protocol — a Marmot group's message
  // reads Marmot (MLS) / kind 9, and Re-publish goes back through the group's
  // own (Marmot) send fn, never a NIP-17 path.
  it('a Marmot group message reports Marmot and re-publishes through the group send', () => {
    const groupResend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(groupResend, 'marmot'));
    act(() => {
      result.current.showInfo({ fromMe: true, eventId: 'r1', wireKind: 14, resendText: 'hi' });
    });
    const info = result.current.info!;
    expect(info.protocol).toBe('marmot');
    expect(protocolLabel(info.wireKind, info.protocol)).toBe('Marmot (MLS)');
    expect(messageKindLabel(info.wireKind, info.protocol!)).toEqual({ key: 'marmotChat', kind: 9 });
    expect(info.idKind).toBe('rumor');
    act(() => result.current.resendFromInfo());
    expect(groupResend).toHaveBeenCalledWith('hi');
  });

  it('passes the failed storage row id even when delivery has a different rumor id', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17', undefined, resend));
    act(() => {
      result.current.showInfo({
        fromMe: true,
        eventId: 'local_original',
        wireKind: 14,
        deliveryStatus: { ...delivery, eventId: 'rumor-original', sendFailed: true },
        resendText: 'retry me',
      });
    });
    expect(result.current.info?.eventId).toBe('rumor-original');
    act(() => result.current.resendFromInfo());
    expect(resend).toHaveBeenCalledWith('retry me', 'local_original');
    expect(result.current.info).toBeNull();
  });

  it('a NIP-17 group message keeps NIP-17 (gift-wrapped)', () => {
    const { result } = renderHook(() =>
      useMessageInfoSheet(jest.fn().mockResolvedValue(true), 'nip17'),
    );
    act(() => {
      result.current.showInfo({ fromMe: false, eventId: 'w1', wireKind: 14, resendText: 'hi' });
    });
    const info = result.current.info!;
    expect(protocolLabel(info.wireKind, info.protocol)).toBe('NIP-17 (gift-wrapped)');
    expect(info.idKind).toBe('wrap');
  });

  it('closeInfo clears the sheet', () => {
    const resend = jest.fn().mockResolvedValue(true);
    const { result } = renderHook(() => useMessageInfoSheet(resend, 'nip17'));
    act(() => {
      result.current.showInfo({ fromMe: true, eventId: 'a', wireKind: 14, resendText: 'x' });
    });
    expect(result.current.info).not.toBeNull();
    act(() => result.current.closeInfo());
    expect(result.current.info).toBeNull();
  });
});
