import { useCallback, useMemo } from 'react';

import type { GroupMessage } from '../services/groupMessagesStorageService';
import type { DeviceNoticeView } from '../services/marmotDeviceTracker';
import {
  classifyStoredMessage,
  deriveGroupWireKind,
  type BubbleContent,
} from '../utils/messageContent';
import { indexMessagesById, resolveQuote, type MessageQuote } from '../utils/messageQuote';
import { sanitizeDisplayText } from '../utils/sanitizeDisplayText';
import { useStableRows } from './useStableRows';

/** A group message, classified once (not in the hot renderItem path). */
export type ClassifiedMessage = GroupMessage & {
  content: BubbleContent;
  wireKind: number;
  quote?: MessageQuote;
};

/** Alpha-only device notice row (#1267), drawn locally from a commit. */
export interface GroupDeviceNoticeRow {
  deviceNotice: true;
  id: string;
  createdAt: number;
  pubkey: string;
  joined: boolean;
  clients: (string | null)[];
}

export type GroupTimelineRow = ClassifiedMessage | GroupDeviceNoticeRow;

const rowKey = (row: GroupTimelineRow) => row.id;

export const isDeviceNoticeRow = (row: GroupTimelineRow): row is GroupDeviceNoticeRow =>
  'deviceNotice' in row;

/**
 * Merge notices (oldest first) into the chronological message list. Messages
 * keep their stored order; each notice goes before the first message newer
 * than it.
 */
export function mergeDeviceNotices(
  messages: readonly ClassifiedMessage[],
  notices: readonly DeviceNoticeView[],
): GroupTimelineRow[] {
  if (notices.length === 0) return messages as ClassifiedMessage[];
  const rows: GroupTimelineRow[] = [];
  let i = 0;
  const push = (n: DeviceNoticeView) =>
    rows.push({
      deviceNotice: true,
      id: `device-${n.id}`,
      createdAt: n.at,
      pubkey: n.pubkey,
      joined: n.joined,
      clients: n.clients,
    });
  for (const m of messages) {
    while (i < notices.length && notices[i].at < m.createdAt) push(notices[i++]);
    rows.push(m);
  }
  while (i < notices.length) push(notices[i++]);
  return rows;
}

/**
 * The group thread's rows: messages classified once per update (so the
 * FlatList renderItem never classifies), Marmot replies resolved against the
 * loaded history, poll votes dropped (they're rolled into their poll's
 * tally), and the alpha device notices merged in. Also answers "who sent
 * this row?" for the message-info sheet.
 */
export function useGroupTimeline({
  messages,
  myPubkey,
  memberNameByPubkey,
  formatLocale,
  deviceNotices,
  clearBoundary = 0,
}: {
  messages: GroupMessage[];
  myPubkey: string | null | undefined;
  memberNameByPubkey: ReadonlyMap<string, string>;
  formatLocale: string;
  deviceNotices: readonly DeviceNoticeView[];
  clearBoundary?: number;
}) {
  const classified = useMemo<ClassifiedMessage[]>(() => {
    // One id index (with each parent's sender) — no per-reply scan.
    const me = myPubkey?.toLowerCase();
    const byId = indexMessagesById(
      messages.map((m) => ({
        id: m.id,
        senderPubkey: m.senderPubkey,
        fromMe: m.senderPubkey.toLowerCase() === me,
        text: m.text,
        wireKind: m.wireKind ?? deriveGroupWireKind(m.text),
      })),
    );
    const quoteFor = (m: GroupMessage): MessageQuote | undefined => {
      const quote = resolveQuote(m.replyTo, byId, formatLocale);
      const parent = m.replyTo ? byId.get(m.replyTo) : undefined;
      return quote && parent && !parent.fromMe
        ? { ...quote, authorName: memberNameByPubkey.get(parent.senderPubkey) }
        : quote;
    };
    // Sanitise before classify so a tofu placeholder (#764) never reaches
    // the bubble's text branch.
    return messages
      .map((m) => {
        const wireKind = m.wireKind ?? deriveGroupWireKind(m.text);
        return {
          ...m,
          quote: quoteFor(m),
          content: ![4, 14, 15, 16, 17, 1068, 1018].includes(wireKind)
            ? { kind: 'unsupported' as const, rawKind: wireKind }
            : classifyStoredMessage(sanitizeDisplayText(m.text), wireKind),
          // The real stored kind (14 chat / 15 encrypted file), so the info
          // sheet reports kind 15 for voice / image bubbles.
          wireKind,
        };
      })
      .filter((m) => m.content.kind !== 'pollVote');
  }, [messages, myPubkey, memberNameByPubkey, formatLocale]);

  const merged = useMemo(
    () =>
      // Messages already passed the history hook's timestamp and cleared-ID
      // checks; same-second arrivals survive. Notices still need the cutoff.
      mergeDeviceNotices(
        classified,
        deviceNotices.filter((notice) => notice.at > clearBoundary),
      ),
    [classified, deviceNotices, clearBoundary],
  );
  // Unchanged rows keep their identity, so the memoised bubbles skip re-rendering.
  const rows = useStableRows(merged, rowKey);

  const senderById = useMemo(
    () => new Map(messages.map((m) => [m.id, m.senderPubkey.toLowerCase()])),
    [messages],
  );
  const senderOf = useCallback(
    (rowId: string, fromMe: boolean) =>
      fromMe ? (myPubkey?.toLowerCase() ?? null) : (senderById.get(rowId) ?? null),
    [myPubkey, senderById],
  );

  return { rows, senderOf };
}

/** Own unsupported placeholders must name the viewer even in senderless runs. */
export function groupSenderLabel(
  fromMe: boolean,
  kind: BubbleContent['kind'],
  peerName: string,
  you: string,
): string | null {
  return fromMe ? (kind === 'unsupported' ? you : null) : peerName;
}
