import { useCallback, useState } from 'react';
import type { DeliveryStatus, MessageInfo } from '../utils/dmDeliveryStatus';
import type { DmProtocol } from '../utils/dmProtocol';
import { buildMessageInfo } from '../utils/messageInfo';

// Args MessageBubble hands up when a bubble is tapped (#856). The hook turns
// these into a `MessageInfo` for the detail sheet and tracks the resend payload.
export interface ShowMessageInfoArgs {
  fromMe: boolean;
  eventId: string;
  wireKind?: number;
  deliveryStatus?: DeliveryStatus;
  resendText: string;
  resendIsGif?: boolean;
  /** When the message was sent (unix seconds) — the Marmot device rows
   * count only devices that were in the chat then (#1267). */
  createdAt?: number;
}

/**
 * Owns a conversation's message-info sheet (#856) — 1:1 and group: the
 * open/closed state, the tap handler, and the Re-publish action. What the
 * sheet shows (protocol, kind, id, whether Re-publish applies) is decided by
 * the pure `buildMessageInfo` (#1296), so both screens agree.
 *
 * `resendText` is the screen's send function — Re-publish runs that thread's
 * own send path again (Marmot over Marmot, NIP-04 over NIP-04, NIP-17 over
 * NIP-17), so it gets its own bubble + fresh tick. `protocol` is the thread's
 * (a group passes 'marmot' or 'nip17').
 */
export function useMessageInfoSheet(
  resendText: (text: string) => Promise<boolean>,
  protocol: DmProtocol,
  // Who sent the tapped bubble — the sheet's Marmot device rows need it
  // (#1267). 1:1: us or the peer; group: looked up by row id.
  senderOf?: (rowId: string, fromMe: boolean) => string | null,
  /** Group retries replace a failed storage row after a successful send. */
  resendFailedText?: (text: string, rowId: string) => Promise<boolean>,
) {
  const [messageInfo, setMessageInfo] = useState<{
    info: MessageInfo;
    canResend: boolean;
    sender: string | null;
    failedRowId?: string;
    sentAt?: number;
  } | null>(null);

  const showInfo = useCallback(
    (args: ShowMessageInfoArgs) => {
      setMessageInfo({
        ...buildMessageInfo({
          protocol,
          fromMe: args.fromMe,
          rowId: args.eventId,
          wireKind: args.wireKind,
          deliveryStatus: args.deliveryStatus,
          resendText: args.resendText,
          resendIsGif: args.resendIsGif,
        }),
        sender: senderOf?.(args.eventId, args.fromMe) ?? null,
        sentAt: args.createdAt,
        // Keep the storage row id: info.eventId can be a different rumor id.
        failedRowId: args.deliveryStatus?.sendFailed ? args.eventId : undefined,
      });
    },
    [protocol, senderOf],
  );

  const closeInfo = useCallback(() => setMessageInfo(null), []);

  const resendFromInfo = useCallback(() => {
    const text = messageInfo?.canResend ? messageInfo.info.resendText : undefined;
    setMessageInfo(null);
    if (text) {
      if (messageInfo?.failedRowId && resendFailedText)
        void resendFailedText(text, messageInfo.failedRowId);
      else void resendText(text);
    }
  }, [messageInfo, resendText, resendFailedText]);

  return {
    info: messageInfo?.info ?? null,
    sender: messageInfo?.sender ?? null,
    sentAt: messageInfo?.sentAt,
    showInfo,
    closeInfo,
    resendFromInfo,
    canResend: !!messageInfo?.canResend,
  };
}
