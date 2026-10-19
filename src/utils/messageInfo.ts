// What the message-info sheet (#856, DeliveryDetailSheet) shows for ONE tapped
// bubble, decided in one pure place so the 1:1 and group screens can't drift
// apart again (#1296: the group screen never said "Marmot", and every Marmot
// message showed NIP-17's "Direct message (kind 14)").
//
// Wire facts the decisions rest on:
// - NIP-04: one kind-4 event, findable on relays by its id.
// - NIP-17: a kind-14 (text) / kind-15 (file) rumor sealed inside kind-1059
//   gift wraps — one wrap per recipient plus a self-copy. Our sent rows carry
//   the rumor id (same for every wrap); received rows are keyed by the wrap
//   id we fetched (`dmWrapIngest`).
// - Marmot: an MLS application message inside a kind-445 group event. Chat
//   is a kind-9 rumor, a photo / voice note is kind 9 + `imeta` (MIP-04). The
//   app STORES them under NIP-17's kinds (14 text, 15 file — marmotInbox's
//   `storedMarmotContent`), so the stored kind must be translated back here.
//   Rows are keyed by the Marmot rumor id (what replies / edits target).

import type { DeliveryStatus, MessageInfo } from './dmDeliveryStatus';
import { protocolForWireKind, type DmProtocol } from './dmProtocol';
import { giphyEnvelope } from '../services/giphyService';
import type { BubbleContent } from './messageContent';

/** Marmot's chat-message rumor kind (`MARMOT_CHAT_KIND` in marmotSession —
 * mirrored so this pure util doesn't pull in the MLS session module). */
const MARMOT_CHAT_RUMOR_KIND = 9;

/** The app's stored text / file kinds (NIP-17's). */
const TEXT_KIND = 14;
const FILE_KIND = 15;
const NIP04_KIND = 4;

/** i18n key (under `deliveryDetailSheet.`) + interpolated kind for the Kind row. */
export type MessageKindLabel =
  | { key: 'kind4' | 'kind14' | 'kind15' | 'unknown' }
  | { key: 'marmotChat' | 'marmotMedia' | 'kindN'; kind: number };

/**
 * The Kind row. NIP-04 / NIP-17 show the event / rumor kind as stored. A
 * Marmot row stored as 14 or 15 was a kind-9 rumor on the wire, so it reads
 * "Chat message (kind 9)" / "Media message (kind 9)"; other Marmot kinds
 * (polls 1068, orders 16/17, …) travel unchanged.
 */
export function messageKindLabel(
  wireKind: number | undefined,
  protocol: DmProtocol,
): MessageKindLabel {
  if (wireKind === undefined) return { key: 'unknown' };
  if (protocol === 'marmot') {
    if (wireKind === TEXT_KIND) return { key: 'marmotChat', kind: MARMOT_CHAT_RUMOR_KIND };
    if (wireKind === FILE_KIND) return { key: 'marmotMedia', kind: MARMOT_CHAT_RUMOR_KIND };
    return { key: 'kindN', kind: wireKind };
  }
  if (wireKind === NIP04_KIND) return { key: 'kind4' };
  if (wireKind === TEXT_KIND) return { key: 'kind14' };
  if (wireKind === FILE_KIND) return { key: 'kind15' };
  return { key: 'kindN', kind: wireKind };
}

/**
 * The bubble's Re-publish payload. The send path takes text, so only bubbles
 * whose message IS its text re-send faithfully: `text` content (which also
 * carries text-encoded invoices / contacts / encrypted-file URLs — files are
 * then gated out by kind in `buildMessageInfo`) and GIFs. Location / poll
 * bubbles get ''. A reply gets '' too — a resend is bare text, so the copy
 * would lose its quote and stop being a reply.
 */
export function resendPayloadFor(
  content: BubbleContent,
  isReply: boolean,
): { resendText: string; resendIsGif?: true } {
  if (isReply) return { resendText: '' };
  if (content.kind === 'text') return { resendText: content.text };
  if (content.kind === 'gif') return { resendText: content.url, resendIsGif: true };
  return { resendText: '' };
}

export interface MessageInfoInput {
  /** The thread's protocol. 1:1 threads are partitioned by protocol; a group
   * is 'marmot' or 'nip17'. A kind-4 row always reads as NIP-04. */
  protocol: DmProtocol;
  fromMe: boolean;
  /** The bubble's row id (`dm-` prefix stripped by the bubble). */
  rowId: string;
  /** The stored app kind (see the header). */
  wireKind?: number;
  /** Sent messages: 1:1 always, group sends made this session. */
  deliveryStatus?: DeliveryStatus;
  /** From `resendPayloadFor`. */
  resendText: string;
  resendIsGif?: boolean;
}

/** Optimistic rows carry a local placeholder id (`local-…` 1:1, `local_…`
 * group) that no relay or peer knows — never show it as an event id. */
const isLocalId = (id: string) => /^local[-_]/.test(id);

/**
 * Builds the sheet's `MessageInfo` plus whether Re-publish is offered.
 *
 * Re-publish re-runs the thread's own send path (`resendText` from the
 * screen's composer hook — Marmot threads/groups send over Marmot, NIP-04
 * threads over NIP-04, NIP-17 over NIP-17), so it's offered only where that
 * path reproduces the message: a SENT text (kind 14, or kind 4 on NIP-04)
 * with a payload. Never for received messages, files (kind 15 would be
 * re-sent as text and lose its file tags) or cards (empty payload).
 */
export function buildMessageInfo(input: MessageInfoInput): {
  info: MessageInfo;
  canResend: boolean;
} {
  const { fromMe, deliveryStatus } = input;
  // A just-sent optimistic row has no stored kind yet; the send result
  // carries the rumor kind (Copilot #858).
  const wireKind = input.wireKind ?? deliveryStatus?.kind;
  // Marmot is explicit (its rumors reuse NIP-17's kinds); otherwise kind 4
  // is NIP-04 and anything else NIP-17.
  const effective: DmProtocol =
    input.protocol === 'marmot' ? 'marmot' : protocolForWireKind(wireKind);

  // Which id this is. A tracked send knows its rumor (Marmot / NIP-17) or
  // event (NIP-04) id; otherwise it's the row id.
  const rawId = deliveryStatus?.eventId ?? input.rowId;
  const eventId = isLocalId(rawId) ? '' : rawId;
  const idKind: MessageInfo['idKind'] =
    effective === 'nip04'
      ? 'event'
      : effective === 'marmot' || deliveryStatus?.eventId
        ? 'rumor'
        : 'wrap';

  // A GIF goes out over Marmot in the same "url + via GIPHY" envelope the
  // composer uses (`gifEnvelope`), so White Noise shows it as a GIF.
  const resendText =
    input.resendIsGif && effective === 'marmot' && input.resendText
      ? giphyEnvelope(input.resendText)
      : input.resendText;

  const resendableKind = effective === 'nip04' ? NIP04_KIND : TEXT_KIND;
  const canResend = fromMe && !!resendText && wireKind === resendableKind;

  return {
    info: {
      direction: fromMe ? 'sent' : 'received',
      eventId,
      idKind,
      wireKind,
      protocol: effective,
      deliveryStatus,
      resendText,
    },
    canResend,
  };
}
