import { buyerOrderNote } from './orderPresentation';

// Gamma kind-16 order types 1–4 and kind-17 receipts are ONLY NIP-17 rumors.
// Public events of those kinds have unrelated NIP-18 / NIP-25 meanings.
// parseOrderEvent accepts decoded rumor shapes; transport boundaries reject public events.
export type OrderEventType = 'order' | 'payment' | 'status' | 'shipping' | 'receipt';

/** A product line on an order: its `a`-coordinate ref + quantity. */
export interface OrderItemRef {
  /** Product coordinate, e.g. "30402:<sellerPubkey>:<dTag>". */
  ref: string;
  quantity: number;
}

/** Lightning payment detail off a `["payment","lightning",<addr|invoice>,<preimage?>]` tag. */
export interface OrderPayment {
  method: string;
  /** A bolt11 invoice, lightning address, or other method-specific value. */
  value: string;
  /** Present on a kind-17 receipt: the payment preimage (proof of payment). */
  preimage?: string;
}

/** A parsed marketplace order/receipt event, normalised across kinds 16 & 17. */
export interface ParsedOrderEvent {
  /** Source event kind — 16 (order lifecycle) or 17 (payment receipt). */
  kind: number;
  type: OrderEventType;
  /** The `order` tag value — the order UUID this event belongs to. */
  orderId: string;
  /** `amount` tag parsed as sats, when present and numeric. */
  amountSats?: number;
  /** `status` tag (e.g. "confirmed", "shipped"). */
  status?: string;
  /** `tracking` tag on a shipping update. */
  tracking?: string;
  /** Product lines from `item` tags. */
  items: OrderItemRef[];
  /** `shipping` tag value (a shipping-option coordinate), when present. */
  shipping?: string;
  /** Lightning payment detail (kind-16 type-2 request, or kind-17 receipt). */
  payment?: OrderPayment;
  /** Buyer's shipping address on a type-1 order (Gamma `address` tag). */
  address?: string;
  /** Buyer contact on a type-1 order (Gamma `email` / `phone` tags). */
  email?: string;
  phone?: string;
  contact?: string;
  notes?: string;
  /** Bounded free text, excluding checkout-generated itemisation. */
  message: string;
}

/** Minimal event shape the parser needs — works for a raw event OR an unwrapped rumor. */
export interface OrderEventInput {
  kind: number;
  /** Signed public events must never be interpreted as order rumors. */
  sig?: string;
  tags: string[][];
  content: string;
}

export const MAX_ORDER_ITEMS = 50;
export const MAX_ORDER_ITEM_QUANTITY = 1_000;

const firstTag = (tags: string[][], name: string): string[] | undefined =>
  tags.find((t) => t[0] === name);

const tagValue = (tags: string[][], name: string): string | undefined => firstTag(tags, name)?.[1];

/** kind-16 `type` tag value → our semantic type. */
const KIND16_TYPE: Record<string, OrderEventType> = {
  '1': 'order',
  '2': 'payment',
  '3': 'status',
  '4': 'shipping',
};

const ORDER_TYPES = new Set<OrderEventType>(['order', 'payment', 'status', 'shipping', 'receipt']);

/**
 * Parse a kind-16/17 event into a normalised order, or return null when it
 * isn't a marketplace order event (wrong kind, a NIP-18 repost, or missing the
 * order shape). The `order` tag is mandatory; kind 16 additionally requires a
 * `type` tag of 1..4 — exactly the pair a Gamma order carries and a repost
 * never does.
 */
export function parseOrderEvent(ev: OrderEventInput): ParsedOrderEvent | null {
  if (ev.sig !== undefined || (ev.kind !== 16 && ev.kind !== 17)) return null;
  if (!Array.isArray(ev.tags)) return null;

  // NIP-18 generic-repost guard: reposts ride on kind 16 but advertise
  // themselves via an `alt` repost note or a `k` repost-target-kind tag. Bail
  // before we mistake one for an order.
  const alt = tagValue(ev.tags, 'alt');
  if (alt && /repost/i.test(alt)) return null;
  if (firstTag(ev.tags, 'k')) return null;

  const orderId = tagValue(ev.tags, 'order');
  if (!orderId) return null;

  let type: OrderEventType;
  if (ev.kind === 17) {
    // kind 17 is also used by NIP-25 (reactions to websites), so an `order`
    // tag alone is too weak. A Gamma receipt carries the market receipt
    // subject (spec example) OR a `payment` proof tag (spec: "at least one
    // required" — `["payment", <medium>, <reference>, <proof>]`); clients
    // differ on the subject (Robotechy sends "Payment for order <id>"), but a
    // website reaction never carries a payment proof.
    const payTag = firstTag(ev.tags, 'payment');
    const hasProof =
      typeof payTag?.[1] === 'string' && payTag[1].length > 0 && typeof payTag[2] === 'string';
    if (tagValue(ev.tags, 'subject') !== 'order-receipt' && !hasProof) return null;
    type = 'receipt';
  } else {
    const typeVal = tagValue(ev.tags, 'type');
    const mapped = typeVal ? KIND16_TYPE[typeVal] : undefined;
    if (!mapped) return null; // kind-16 without a 1..4 type tag isn't an order
    type = mapped;
  }

  const amountRaw = tagValue(ev.tags, 'amount');
  const amountSats =
    amountRaw !== undefined && /^\d+$/.test(amountRaw.trim())
      ? Number(amountRaw.trim())
      : undefined;

  const items: OrderItemRef[] = [];
  const byRef = new Map<string, OrderItemRef>();
  let itemTags = 0;
  for (const t of ev.tags) {
    if (t[0] !== 'item') continue;
    if (++itemTags > MAX_ORDER_ITEMS) return null;
    if (typeof t[1] !== 'string') continue;
    // Trim + require a string (mirrors `amount`), then keep a positive integer.
    const qtyRaw = typeof t[2] === 'string' ? t[2].trim() : undefined;
    const qtyNum = qtyRaw !== undefined && /^\d+$/.test(qtyRaw) ? Number(qtyRaw) : 1;
    const quantity = Math.min(MAX_ORDER_ITEM_QUANTITY, qtyNum > 0 ? qtyNum : 1);
    const existing = byRef.get(t[1]);
    if (existing) {
      existing.quantity = Math.min(MAX_ORDER_ITEM_QUANTITY, existing.quantity + quantity);
    } else {
      const item = { ref: t[1], quantity };
      byRef.set(t[1], item);
      items.push(item);
    }
  }

  let payment: OrderPayment | undefined;
  const payTag = firstTag(ev.tags, 'payment');
  if (payTag && typeof payTag[1] === 'string' && typeof payTag[2] === 'string') {
    payment = { method: payTag[1], value: payTag[2] };
    if (typeof payTag[3] === 'string' && payTag[3].length > 0) payment.preimage = payTag[3];
  }

  return {
    kind: ev.kind,
    type,
    orderId,
    amountSats,
    status: boundedText(tagValue(ev.tags, 'status')),
    tracking: boundedText(tagValue(ev.tags, 'tracking')),
    items,
    shipping: tagValue(ev.tags, 'shipping'),
    payment,
    ...(type === 'order' ? contactFields(ev.tags) : {}),
    // Strip the complete generated suffix before the text cap can cut it in half.
    message: typeof ev.content === 'string' ? buyerOrderNote(ev.content).slice(0, 500) : '',
  };
}

/** Longest buyer-supplied contact value kept (an address, not a document). */
const MAX_CONTACT_LENGTH = 500;

/** Bounded string, or undefined. */
const boundedText = (raw: unknown): string | undefined =>
  typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_CONTACT_LENGTH) : undefined;

/** Buyer address / email / phone off a type-1 order's tags. */
function contactFields(
  tags: string[][],
): Pick<ParsedOrderEvent, 'address' | 'email' | 'phone' | 'contact' | 'notes'> {
  const out: Pick<ParsedOrderEvent, 'address' | 'email' | 'phone' | 'contact' | 'notes'> = {};
  const address = boundedText(tagValue(tags, 'address'));
  const email = boundedText(tagValue(tags, 'email'));
  const phone = boundedText(tagValue(tags, 'phone'));
  if (address) out.address = address;
  if (email) out.email = email;
  if (phone) out.phone = phone;
  out.contact = boundedText(tagValue(tags, 'contact'));
  out.notes = boundedText(tagValue(tags, 'notes'));
  return out;
}

/** True when the event is a marketplace order/receipt (vs a repost / unrelated). */
export function isOrderEvent(ev: OrderEventInput): boolean {
  return parseOrderEvent(ev) !== null;
}

/**
 * Canonical storage form. A parsed order is persisted as its JSON in the DM
 * row's `content`, so the conversation renderer can rebuild the full card and
 * the inbox can derive a preview. (The DM store schema is a flat row — there's
 * no extra column to split structured fields into.)
 */
export function serializeOrder(order: ParsedOrderEvent): string {
  return JSON.stringify(order);
}

const isFiniteNonNegInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isFinitePosInt = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n > 0;

/** Validate a stored `payment` object — drop it unless method + value are strings. */
function parseStoredPayment(raw: unknown): OrderPayment | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.method !== 'string' || typeof p.value !== 'string') return undefined;
  const payment: OrderPayment = { method: p.method, value: p.value };
  if (typeof p.preimage === 'string' && p.preimage.length > 0) payment.preimage = p.preimage;
  return payment;
}

/** Inverse of `serializeOrder`; returns null if `content` isn't a stored order. */
export function parseStoredOrder(content: string): ParsedOrderEvent | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if ((o.kind !== 16 && o.kind !== 17) || typeof o.orderId !== 'string') return null;
    // Validate `type` against the known literals — a corrupt / off-schema row
    // with an unexpected `type` would otherwise make `orderCardHeader` return
    // undefined and crash the card renderer reading `header.label`.
    if (typeof o.type !== 'string' || !ORDER_TYPES.has(o.type as OrderEventType)) return null;
    return {
      kind: o.kind as number,
      type: o.type as OrderEventType,
      orderId: o.orderId,
      // Only a finite, non-negative integer — never NaN/Infinity/negative/float
      // (which would surface as "NaN sats" etc. for a corrupt row).
      amountSats: isFiniteNonNegInt(o.amountSats) ? o.amountSats : undefined,
      status: boundedText(o.status),
      tracking: boundedText(o.tracking),
      // Keep only well-formed items and coerce a missing/invalid quantity to 1
      // so a corrupt row can't render NaN totals downstream.
      items: Array.isArray(o.items)
        ? (o.items as unknown[]).flatMap((i) => {
            if (!i || typeof (i as OrderItemRef).ref !== 'string') return [];
            const q = (i as OrderItemRef).quantity;
            return [
              {
                ref: (i as OrderItemRef).ref,
                // Clamp to a positive integer — 0/negative/fractional would make
                // totals and pluralization misleading.
                quantity: isFinitePosInt(q) ? q : 1,
              },
            ];
          })
        : [],
      shipping: typeof o.shipping === 'string' ? o.shipping : undefined,
      payment: parseStoredPayment(o.payment),
      address: boundedText(o.address),
      email: boundedText(o.email),
      phone: boundedText(o.phone),
      contact: boundedText(o.contact),
      notes: boundedText(o.notes),
      message: typeof o.message === 'string' ? buyerOrderNote(o.message).slice(0, 500) : '',
    };
  } catch {
    return null;
  }
}

/** Emoji + human label for an order card header. */
export function orderCardHeader(type: OrderEventType): { emoji: string; label: string } {
  switch (type) {
    case 'order':
      return { emoji: '🛒', label: 'Order Placed' };
    case 'payment':
      return { emoji: '💳', label: 'Payment' };
    case 'status':
      return { emoji: '📋', label: 'Order Status Update' };
    case 'shipping':
      return { emoji: '🚚', label: 'Shipping Update' };
    case 'receipt':
      return { emoji: '🧾', label: 'Payment Receipt' };
  }
}

/** First 8 chars of the order UUID — the user-facing short id. */
export function shortOrderId(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 8);
}

// Match (and normalise) a bolt11 invoice, kept in sync with `INVOICE_REGEX` in
// src/utils/messageContent.ts so the order card accepts exactly what the rest of
// the app parses: an optional `lightning:` URI prefix, then `ln` + a network
// HRP (`bc`/`tb`/`ts`/`bs`) + at least 50 bech32-data chars. The `{50,}` floor
// matches INVOICE_REGEX and rejects too-short "lnbc…"-shaped values (a real
// bolt11 is far longer). Group 1 is the bare bolt11 (prefix stripped). We mirror
// the regex rather than importing `extractInvoice` (which pulls in a bolt11
// decoder) so this parser stays dependency-light for the hot decrypt loop.
const BOLT11_RE = /^(?:lightning:)?(ln(?:bc|tb|ts|bs)[0-9a-z]{50,})$/i;

/**
 * The bolt11 invoice a buyer can pay from a kind-16 **type-2 "Payment"**
 * request, or `null` when this order carries nothing payable.
 *
 * Only a payment *request* is payable: a kind-17 receipt is already settled,
 * and an order-placed / status / shipping update carries no invoice. The
 * payment must use the `lightning` method AND its value must be a bolt11
 * (optionally `lightning:`-prefixed) — a Lightning *address* or a non-Lightning
 * method (whose value might coincidentally resemble a bolt11) isn't a
 * one-tap-payable invoice here, so both are rejected. The returned value has any
 * `lightning:` prefix stripped, ready to pay / QR-encode.
 */
export function payableBolt11(order: ParsedOrderEvent): string | null {
  if (order.kind !== 16 || order.type !== 'payment') return null;
  const payment = order.payment;
  if (!payment || payment.method.toLowerCase() !== 'lightning') return null;
  const match = payment.value.trim().match(BOLT11_RE);
  return match ? match[1].toLowerCase() : null;
}

// Non-anchored sibling of `BOLT11_RE`: pulls the FIRST bolt11 out of free-text
// content (vs `BOLT11_RE`, which requires the whole string to be one invoice).
// Kept in lock-step with `INVOICE_REGEX` in src/utils/messageContent.ts — same
// `\b`-delimited shape — so the dedup below recognises exactly the invoice the
// rest of the app parses. Dependency-light on purpose (no bolt11 decoder).
const BOLT11_IN_TEXT_RE = /\b(?:lightning:)?(ln(?:bc|tb|ts|bs)[0-9a-z]{50,})\b/i;

/**
 * The first bolt11 invoice embedded in a free-text chat message, lowercased
 * (bech32 is case-insensitive; canonical form is lower) with any `lightning:`
 * prefix stripped, or `null` when the text carries none.
 *
 * Used to correlate a kind-14 "order invoice" chat-note fallback with the
 * kind-16 order card that carries the SAME invoice (`payableBolt11`), so the
 * redundant note can be suppressed. Both sides normalise to lowercase here so
 * the comparison is exact regardless of how either client cased the invoice.
 */
export function bolt11FromText(text: string): string | null {
  if (!text) return null;
  const match = text.match(BOLT11_IN_TEXT_RE);
  return match ? match[1].toLowerCase() : null;
}

/** One-line inbox preview, e.g. "🛒 Order Placed · 21 sats". */
export function orderPreviewText(order: ParsedOrderEvent, locale?: string): string {
  const { emoji, label } = orderCardHeader(order.type);
  const parts: string[] = [`${emoji} ${label}`];
  if (order.amountSats !== undefined) parts.push(`${order.amountSats.toLocaleString(locale)} sats`);
  return parts.join(' · ');
}

/**
 * Inbox-preview text for a stored DM row. For an order/receipt row the stored
 * `content` is order JSON, so derive a readable summary; everything else passes
 * through unchanged. Shared by every store→inbox projection so a raw order JSON
 * blob never leaks into a conversation-list preview.
 */
export function orderPreviewFromContent(
  content: string,
  wireKind: number,
  locale?: string,
): string {
  if (wireKind !== 16 && wireKind !== 17) return content;
  const order = parseStoredOrder(content);
  if (order) return orderPreviewText(order, locale);
  // Unparseable kind-16/17 content — a corrupted/legacy row, or a non-order
  // payload sharing the kind (e.g. a NIP-18 repost JSON). Never surface the
  // raw blob; a neutral marketplace label keeps the list readable.
  return '🛍️ Marketplace message';
}
