import type { SharedLocation } from '../services/locationService';
import type { LiveLocationMarker } from '../services/liveLocationService';
import type { TransactionDetailData } from '../components/TransactionDetailSheet';
import type { WalletState } from '../types/wallet';
import { classifyStoredMessage } from './messageContent';
import { POLL_KIND, VOTE_KIND, parseStoredPoll, type DisplayPoll } from './nip88Poll';
import { isChatReactionKind } from './nip17Reactions';
import { sanitizeDisplayText } from './sanitizeDisplayText';
import type { DeliveryStatus } from './dmDeliveryStatus';
import {
  bolt11FromText,
  parseStoredOrder,
  payableBolt11,
  type ParsedOrderEvent,
} from './orderEvents';
import { indexMessagesById, resolveQuote, type MessageQuote } from './messageQuote';
import { NWC_SHARE_KIND, parseNwcShare, type NwcShareCard } from './nwcShareMessage';
import { MARMOT_WELCOME_KIND } from './dmProtocol';

// The row variants ConversationScreen's FlatList renders. Extracted from the
// screen (with the pure build logic below) to keep the screen file under the
// #703 size cap. Kept dependency-light so it stays unit-testable.
export type Item =
  | {
      kind: 'message';
      id: string;
      fromMe: boolean;
      text: string;
      file?: import('./fileAttachment').FileAttachment;
      createdAt: number;
      // Per-relay delivery breakdown for a sent (fromMe) message (#856).
      deliveryStatus?: DeliveryStatus;
      // Wire protocol (4 = NIP-04, 14/15 = NIP-17) for the message-info sheet.
      wireKind?: number;
      // Cross-peer-stable id (NIP-17 inner rumor id / NIP-04 wire id) used as
      // the target for per-message NIP-25 reactions + zaps (#205). Undefined
      // for optimistic-local sends and warm-cache rows without a rumor id.
      rumorId?: string;
      // Marmot reply: the quoted parent shown above the text.
      quote?: MessageQuote;
      // Marmot edit: the text is an author's replacement of the original.
      edited?: boolean;
    }
  | {
      kind: 'zap';
      id: string;
      fromMe: boolean;
      amountSats: number;
      comment: string;
      createdAt: number;
      tx: TransactionDetailData;
    }
  | {
      kind: 'location';
      id: string;
      fromMe: boolean;
      location: SharedLocation;
      createdAt: number;
      // Reaction/zap target (#205) — see the `message` variant.
      rumorId?: string;
      // Marmot reply: the quoted parent (see the `message` variant).
      quote?: MessageQuote;
    }
  | {
      kind: 'liveLocationMarker';
      id: string;
      fromMe: boolean;
      marker: LiveLocationMarker;
      createdAt: number;
    }
  | {
      kind: 'gif';
      id: string;
      fromMe: boolean;
      url: string;
      createdAt: number;
      // Reaction/zap target (#205) — see the `message` variant.
      rumorId?: string;
      // Marmot reply: the quoted parent (see the `message` variant).
      quote?: MessageQuote;
    }
  | {
      // Marketplace order / receipt card (#market) — a kind-16/17 event a
      // Nostr market addressed to the buyer, rendered as a distinct card.
      kind: 'order';
      id: string;
      fromMe: boolean;
      order: ParsedOrderEvent;
      expectedAmountSats?: number;
      /** My own placed order (kind-16 type 1) the seller hasn't answered with
       * a payment request (or cancelled) yet — the card says so. */
      awaitingInvoice?: boolean;
      createdAt: number;
    }
  | {
      // "Add NWC Wallet" card — an NWC wallet a peer shared over an encrypted
      // NIP-17 DM (inner kind NWC_SHARE_KIND). Carries the bearer connection
      // string, rendered as a QR + trust warning + Add button (never a bubble).
      kind: 'nwcShare';
      id: string;
      fromMe: boolean;
      card: NwcShareCard;
      createdAt: number;
    }
  | {
      // Generic fallback for a stored message whose wireKind the app doesn't
      // render (an inner Nostr event of an unhandled kind — now or in future).
      // Rendered as a muted placeholder bubble instead of a blank one (#market
      // follow-up). `rawKind` is the numeric Nostr kind.
      kind: 'unsupported';
      id: string;
      fromMe: boolean;
      rawKind: number;
      createdAt: number;
    }
  | {
      // A Marmot invite (kind-444 Welcome) that couldn't be opened (#1269).
      // Joined / pending invites never become an item — they're hidden.
      kind: 'marmotInviteFailed';
      id: string;
      fromMe: false;
      createdAt: number;
    }
  | {
      kind: 'poll';
      id: string;
      fromMe: boolean;
      // Correlation id — the vote target + tally key. For a structured NIP-88
      // poll it's the poll rumor event id; for a legacy text poll it's the
      // message id (`dm-…`). Kept separate from `id` (the React/FlatList key)
      // so the two don't have to coincide.
      pollId: string;
      poll: DisplayPoll;
      createdAt: number;
      // Marmot reply: the quoted parent (see the `message` variant).
      quote?: MessageQuote;
      // Reaction/zap target + delivery tick, for parity with message/gif/
      // location items. Present on optimistic sent rows (the store has no
      // rumorId column, so incoming rows carry none — same as gif/location).
      rumorId?: string;
      deliveryStatus?: DeliveryStatus;
      wireKind?: number;
    }
  | {
      // Alpha-only device notice (#1267): "Little Piggy · joined on 2
      // devices". Drawn locally from a Marmot commit; never sent.
      kind: 'deviceNotice';
      id: string;
      fromMe: false;
      createdAt: number;
      /** About the viewer ("You") rather than the peer. */
      isSelf: boolean;
      joined: boolean;
      clients: (string | null)[];
    }
  | {
      kind: 'dayHeader';
      id: string;
      label: string;
    };

/** A device notice as the 1:1 timeline takes it (see useDmDevices). */
export interface DeviceNoticeInput {
  id: string;
  createdAt: number;
  isSelf: boolean;
  joined: boolean;
  clients: (string | null)[];
}

// Every Item variant except the dayHeader synthetic row — these are the
// ones that have a real `createdAt` and participate in chronological sort.
export type TimedItem = Exclude<Item, { kind: 'dayHeader' }>;

// The raw 1:1 DM shape ConversationScreen holds in state.
export interface ConversationMessageInput {
  id: string;
  fromMe: boolean;
  text: string;
  createdAt: number;
  // Per-relay delivery breakdown for a sent message (#856), attached by the
  // composer's optimistic append. Carried through to the message Item.
  deliveryStatus?: DeliveryStatus;
  // Wire protocol (4 = NIP-04, 14/15 = NIP-17) for the message-info sheet.
  wireKind?: number;
  // NIP-17 inner-rumor id (#857) — the delivery-store key; stable across the
  // optimistic row and its relay echo. Set on sent rows only.
  rumorId?: string;
  // Marmot reply: id of the message this one quotes.
  replyTo?: string;
  // Marmot edit: `created_at` of the edit the text now holds.
  editedAt?: number;
}

// Local-only formatter — only used for the dayHeader rule between
// chronological message groups, so it stays here rather than in the
// shared `messageContent` util (which sticks to bubble-level concerns).
export function formatDayHeader(epochSeconds: number, locale?: string): string {
  const d = new Date(epochSeconds * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

// Wallet-derived zap rows for a 1:1 thread: Lightning txs whose zap
// counterparty is this conversation's peer. Pulled from the wallet ledger,
// not from Nostr messages.
export function buildZapItems(wallets: WalletState[], pubkey: string): TimedItem[] {
  const out: TimedItem[] = [];
  for (const w of wallets) {
    for (const tx of w.transactions) {
      const cp = tx.zapCounterparty;
      if (!cp || !cp.pubkey || cp.pubkey !== pubkey) continue;
      const when = tx.settled_at ?? tx.created_at;
      if (!when) continue;
      out.push({
        kind: 'zap',
        id: `zap-${tx.paymentHash ?? tx.bolt11 ?? when}-${tx.type}`,
        fromMe: tx.type === 'outgoing',
        amountSats: Math.abs(tx.amount),
        comment: cp.comment ?? '',
        createdAt: when,
        tx,
      });
    }
  }
  return out;
}

// Wire kinds the conversation can actually render: 4 (NIP-04 DM), 14 (NIP-17
// DM text), 15 (NIP-17 file → image/voice/link), 16/17 (marketplace order /
// receipt cards). A stored message whose wireKind isn't one of these is an
// inner event of a kind we don't display — surfaced as the `unsupported`
// placeholder rather than a blank bubble. Plain text rows carry no wireKind
// (`undefined`), so they never hit the fallback.
const RENDERABLE_WIRE_KINDS = new Set<number>([4, 14, 15, 16, 17, POLL_KIND, VOTE_KIND]);

/**
 * Suppress a kind-14 chat-note that merely re-delivers an order's Lightning
 * invoice when the SAME conversation already renders the kind-16 order card for
 * that invoice (#market dedup).
 *
 * The order-service delivers an order's invoice two ways for client
 * compatibility: a kind-16 type-2 payment request (LP's rich "order card") and
 * a kind-14 NIP-17 chat note carrying the same human-readable line + the SAME
 * raw bolt11, so generic DM clients that can't render kind-16 still get a
 * payable invoice. A Gamma-aware client like LP would otherwise show BOTH — the
 * card and a duplicate invoice bubble — so we drop the note.
 *
 * Correlation is by the shared bolt11, not the `["order", …]` tag: LP's
 * dm_messages store retains only a row's content + wireKind, never the kind-14
 * rumor's tags, so the order tag isn't available at render time — but the
 * invoice string IS retained on both sides (the card's `payment.value` and the
 * note's content) and is an exact, hard key. A note is dropped ONLY when its
 * bolt11 equals a payable order card's invoice, so a regular chat message —
 * even one that happens to quote an unrelated invoice — is never suppressed,
 * and a note with no matching card still shows (it may be the only invoice the
 * buyer has — the whole point of the fallback). Operating on the assembled item
 * set means the kind-14 and kind-16 can arrive in either order.
 */
export function suppressDuplicateOrderInvoiceNotes(items: TimedItem[]): TimedItem[] {
  // Every payable bolt11 shown as an order card in this conversation. Only a
  // kind-16 type-2 payment request yields one (`payableBolt11`), so a receipt
  // or order-placed card never suppresses anything.
  const orderInvoices = new Set<string>();
  for (const it of items) {
    if (it.kind !== 'order') continue;
    const invoice = payableBolt11(it.order);
    if (invoice) orderInvoices.add(invoice);
  }
  if (orderInvoices.size === 0) return items;
  return items.filter((it) => {
    // Only a kind-14 chat bubble can be an order-invoice fallback note; leave
    // order cards, zaps, files, NIP-04 (kind-4) rows, etc. untouched.
    if (it.kind !== 'message' || it.wireKind !== 14) return true;
    const invoice = bolt11FromText(it.text);
    return !(invoice && orderInvoices.has(invoice));
  });
}

/**
 * Buyer-approved totals keyed by orderId — ONLY from the buyer's own outgoing
 * kind-16 type-1 orders (a merchant can't author one of those into this
 * thread; its `amount` tag on a payment request is never trusted). Two
 * outgoing orders sharing an id with different totals fail closed
 * (undefined). `olderOrders` seeds totals the screen resolved from the store
 * for orders older than the loaded slice (see `orderIdsNeedingHistory`); an
 * in-slice order that disagrees with a seeded total also fails closed.
 */
export function collectApprovedOrderAmounts(
  messages: ConversationMessageInput[],
  olderOrders?: ReadonlyMap<string, number | undefined>,
): Map<string, number | undefined> {
  const expectedAmounts = new Map<string, number | undefined>(olderOrders ?? []);
  for (const message of messages) {
    if (!message.fromMe || message.wireKind !== 16) continue;
    const order = parseStoredOrder(message.text);
    if (!order || order.type !== 'order') continue;
    const amount = order.amountSats;
    if (!Number.isSafeInteger(amount) || (amount ?? 0) <= 0) continue;
    if (expectedAmounts.has(order.orderId) && expectedAmounts.get(order.orderId) !== amount) {
      expectedAmounts.set(order.orderId, undefined);
    } else if (!expectedAmounts.has(order.orderId)) {
      expectedAmounts.set(order.orderId, amount);
    }
  }
  return expectedAmounts;
}

/**
 * Order ids the peer has answered: a received payment request (kind-16
 * type 2) or a received status update (type 3, e.g. cancelled / confirmed).
 * My placed orders NOT in this set are still waiting for the seller.
 */
export function answeredOrderIds(messages: ConversationMessageInput[]): Set<string> {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.fromMe || message.wireKind !== 16) continue;
    const order = parseStoredOrder(message.text);
    if (order && (order.type === 'payment' || order.type === 'status')) {
      answered.add(order.orderId);
    }
  }
  return answered;
}

/**
 * Order ids of RECEIVED payment requests (kind-16 carrying a payable invoice)
 * and receipts (kind-17) whose originating outgoing order isn't in `messages` — i.e. it's older than
 * the loaded thread slice (DM_CONV_CAP). The screen resolves these from the
 * store (`useOutgoingOrderHistory`) so an old order stays payable instead of
 * sticking on "amount unverified". Sorted, so callers can key on the list.
 */
export function orderIdsNeedingHistory(messages: ConversationMessageInput[]): string[] {
  const outgoing = new Set<string>();
  const wanted = new Set<string>();
  for (const message of messages) {
    if (message.wireKind !== 16 && message.wireKind !== 17) continue;
    const order = parseStoredOrder(message.text);
    if (!order) continue;
    if (message.fromMe) {
      if (order.type === 'order') outgoing.add(order.orderId);
    } else if (payableBolt11(order) || (order.kind === 17 && order.type === 'receipt')) {
      // A payment request AND a receipt both bind to the buyer's own order.
      wanted.add(order.orderId);
    }
  }
  return [...wanted].filter((id) => !outgoing.has(id)).sort();
}

// Merge classified DM messages with wallet zap rows, sort newest-first, and
// interleave "Today / Yesterday / <date>" dividers between day groups.
// `olderOrderAmounts` — approved totals for orders outside the loaded slice
// (see `collectApprovedOrderAmounts`). `failedInvites` — this partner's Marmot
// invites that couldn't be opened, from the Marmot session's record (#1269).
export function buildConversationItems(
  messages: ConversationMessageInput[],
  zapItems: TimedItem[],
  olderOrderAmounts?: ReadonlyMap<string, number | undefined>,
  failedInvites: readonly { id: string; createdAt: number }[] = [],
  locale?: string,
  deviceNotices: readonly DeviceNoticeInput[] = [],
  clearBoundary = 0,
): Item[] {
  const byId = indexMessagesById(messages);
  const approvedAmounts = collectApprovedOrderAmounts(messages, olderOrderAmounts);
  const answered = answeredOrderIds(messages);
  const orderInvoices = new Set(
    messages.flatMap((message) => {
      if (message.wireKind !== 16) return [];
      const order = parseStoredOrder(message.text);
      const bolt11 = order ? payableBolt11(order) : null;
      return bolt11 ? [bolt11] : [];
    }),
  );
  const msgItems: TimedItem[] = messages.flatMap((m): TimedItem[] => {
    // A Marmot invite's gift wrap: never a bubble. Joined ones have their
    // own chat; failed ones are drawn from the session's record below.
    if (m.wireKind === MARMOT_WELCOME_KIND) return [];
    // Structured cards never pass through the free-text/link classifier.
    if (m.wireKind === 16 || m.wireKind === 17) {
      const order = parseStoredOrder(m.text);
      if (!order) return [];
      return [
        {
          kind: 'order',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          createdAt: m.createdAt,
          order,
          expectedAmountSats: approvedAmounts.get(order.orderId),
          awaitingInvoice: m.fromMe && order.type === 'order' && !answered.has(order.orderId),
        },
      ];
    }
    // Older clients also sent a kind-14 copy of the same invoice. Hide that
    // duplicate alongside its order, while ordinary chat invoices still render.
    if (m.wireKind === 14 && orderInvoices.has(bolt11FromText(m.text) ?? '')) return [];
    // NWC wallet share (inner kind NWC_SHARE_KIND) — the row's `text` is the
    // card JSON (bearer connection string + optional name). Render an "Add NWC
    // Wallet" card. An unparseable / corrupt row falls back to the muted
    // placeholder rather than leaking the raw connection string as a bubble.
    if (m.wireKind === NWC_SHARE_KIND) {
      const card = parseNwcShare(m.text);
      if (card) {
        return [
          {
            kind: 'nwcShare',
            id: `dm-${m.id}`,
            fromMe: m.fromMe,
            card,
            createdAt: m.createdAt,
          },
        ];
      }
      return [
        {
          kind: 'unsupported',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          rawKind: m.wireKind,
          createdAt: m.createdAt,
        },
      ];
    }
    // Structured NIP-88 poll (kind 1068) — stored as canonical poll JSON
    // (#203). Render as a poll card keyed by the embedded poll rumor id so
    // votes (which reference that id) correlate. A corrupt/unparseable row
    // falls back to the muted placeholder rather than leaking JSON.
    if (m.wireKind === POLL_KIND) {
      const stored = parseStoredPoll(m.text);
      if (stored) {
        const poll: DisplayPoll = {
          question: stored.question,
          options: stored.options,
          pollType: stored.pollType,
          endsAt: stored.endsAt,
        };
        return [
          {
            kind: 'poll',
            id: `dm-${m.id}`,
            pollId: stored.pollId,
            fromMe: m.fromMe,
            poll,
            createdAt: m.createdAt,
            rumorId: m.rumorId,
            deliveryStatus: m.deliveryStatus,
            wireKind: m.wireKind,
          },
        ];
      }
      return [
        {
          kind: 'unsupported',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          rawKind: m.wireKind,
          createdAt: m.createdAt,
        },
      ];
    }
    // Structured NIP-88 vote (kind 1018) — never a bubble; it's aggregated into
    // the referenced poll's tally by the screen's poll hook. Drop from the list.
    if (m.wireKind === VOTE_KIND) return [];
    // A wrapped reaction / retraction (#1321) renders as a pill on its target
    // (useConversationReactions), never as its own bubble.
    if (isChatReactionKind(m.wireKind)) return [];
    // Generic, future-proof fallback: a stored message whose wireKind we don't
    // render (an inner Nostr event of an unhandled kind) becomes a muted
    // placeholder rather than a blank text bubble. Only fires for a defined
    // wireKind outside the renderable set — plain rows (no wireKind) and the
    // 4/14/15/16/17/1068/1018 kinds handled above/below are unaffected.
    if (m.wireKind !== undefined && !RENDERABLE_WIRE_KINDS.has(m.wireKind)) {
      return [
        {
          kind: 'unsupported',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          rawKind: m.wireKind,
          createdAt: m.createdAt,
        },
      ];
    }
    // Classify each raw DM into the variant the renderer expects. Same
    // shape used by the group screen (via `classifyMessageContent`)
    // — keeps gif / geo / poll detection in one place.
    const classified = classifyStoredMessage(m.text, m.wireKind);
    // A Marmot reply quotes its parent whatever the bubble: text, GIF,
    // location or poll.
    const quoted = m.replyTo ? { quote: resolveQuote(m.replyTo, byId, locale) } : {};
    // Vote messages aren't shown as bubbles — they're aggregated into the
    // referenced poll's tally by the screen, so drop them from the row list.
    if (classified.kind === 'pollVote') return [];
    if (classified.kind === 'gif') {
      return [
        {
          kind: 'gif',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          url: classified.url,
          createdAt: m.createdAt,
          rumorId: m.rumorId,
          ...quoted,
        },
      ];
    }
    if (classified.kind === 'location') {
      return [
        {
          kind: 'location',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          location: classified.location,
          createdAt: m.createdAt,
          rumorId: m.rumorId,
          ...quoted,
        },
      ];
    }
    if (classified.kind === 'poll') {
      // Legacy text-encoded poll: correlation id IS the message id (votes were
      // keyed by it in the MVP), so pollId === id here.
      return [
        {
          kind: 'poll',
          id: `dm-${m.id}`,
          pollId: `dm-${m.id}`,
          fromMe: m.fromMe,
          poll: classified.poll,
          createdAt: m.createdAt,
          rumorId: m.rumorId,
          deliveryStatus: m.deliveryStatus,
          wireKind: m.wireKind,
          ...quoted,
        },
      ];
    }
    if (classified.kind === 'liveLocationMarker') {
      return [
        {
          kind: 'liveLocationMarker',
          id: `dm-${m.id}`,
          fromMe: m.fromMe,
          marker: classified.marker,
          createdAt: m.createdAt,
        },
      ];
    }
    return [
      {
        kind: 'message',
        id: `dm-${m.id}`,
        fromMe: m.fromMe,
        // Drop orphaned object-replacement / zero-width placeholders so an
        // inline-attachment artifact doesn't render as a tofu box (#764).
        text: sanitizeDisplayText(m.text),
        ...(classified.kind === 'file' ? { file: classified.file } : {}),
        createdAt: m.createdAt,
        deliveryStatus: m.deliveryStatus,
        wireKind: m.wireKind,
        rumorId: m.rumorId,
        ...quoted,
        ...(m.editedAt ? { edited: true } : {}),
      },
    ];
  });
  // Drop any kind-14 chat-note that just re-delivers an order's invoice when
  // its kind-16 order card is also present (#market dedup) — a selector over the
  // assembled set, so the two events can arrive in either order.
  const deduped = suppressDuplicateOrderInvoiceNotes(msgItems);
  const supplemental: TimedItem[] = [...zapItems];
  for (const f of failedInvites) {
    supplemental.push({
      kind: 'marmotInviteFailed',
      id: `invite-${f.id}`,
      fromMe: false,
      createdAt: f.createdAt,
    });
  }
  for (const n of deviceNotices) {
    supplemental.push({ kind: 'deviceNotice', ...n, id: `device-${n.id}`, fromMe: false });
  }

  // Descending order — index 0 is newest. The FlatList is `inverted`, so
  // index 0 renders at the visual bottom (chat default) and the
  // RefreshControl attaches to the visual bottom too, which is what
  // drives the pull-up-to-refresh gesture.
  // Messages were already filtered by useChatLocalHistory, including the IDs
  // cleared in this second. Only supplemental rows still need the cutoff.
  const sorted = [
    ...deduped,
    ...supplemental.filter((item) => item.createdAt > clearBoundary),
  ].sort((a, b) => b.createdAt - a.createdAt);

  // Interleave "Today / Yesterday / <date>" dividers between day groups.
  // With an inverted FlatList the array runs newest → oldest, so each
  // divider must sit AFTER its group's oldest entry in array order
  // (= visually above the group's newest entry). This gives the same
  // chat-standard look as Transactions' date headers.
  if (sorted.length === 0) return sorted;
  const withHeaders: Item[] = [];
  const dayKey = (ts: number) => new Date(ts * 1000).toDateString();
  let prevKey: string | null = null;
  let prevTs: number | null = null;
  for (const it of sorted) {
    const key = dayKey(it.createdAt);
    if (prevKey !== null && prevKey !== key && prevTs !== null) {
      withHeaders.push({
        kind: 'dayHeader',
        id: `day-${prevKey}`,
        label: formatDayHeader(prevTs, locale),
      });
    }
    withHeaders.push(it);
    prevKey = key;
    prevTs = it.createdAt;
  }
  if (prevKey !== null && prevTs !== null) {
    withHeaders.push({
      kind: 'dayHeader',
      id: `day-${prevKey}`,
      label: formatDayHeader(prevTs, locale),
    });
  }
  return withHeaders;
}
