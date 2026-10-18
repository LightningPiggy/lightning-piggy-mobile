// Buyer-side Gamma-marketplace order construction (#market in-app checkout).
//
// A Lightning Piggy buyer places an order by publishing a kind-16 `["type","1"]`
// order event, gift-wrapped (NIP-17) to the merchant, then pays the BOLT11
// invoice the merchant returns as a kind-16 `["type","2"]` payment request
// (which LP already ingests + renders as an order card — see orderEvents.ts /
// OrderPaymentActions). This module is the PURE half: it builds the order rumor
// (kind + structured tags) and derives the order id / total, mirroring the
// merchant/buyer protocol in RobotechyShop's `gammaOrderUtils.createOrderTags`.
//
// It is the inverse of `parseOrderEvent` (orderEvents.ts): what we build here a
// Gamma merchant — and LP's own ingest — parses back out. No React, no I/O
// (coverage scope: src/utils); the signer + relay side lives in
// `useMarketCheckout`.

/** NIP-99 classified-listing kind — the addressable product a line refers to. */
export const PRODUCT_COORD_KIND = 30402;

/** kind-16 order-message type tag values (Gamma commerce). */
export const ORDER_MESSAGE_TYPE = {
  /** Buyer → merchant: a new order. */
  CREATION: '1',
  /** Merchant → buyer: an invoice to pay. */
  PAYMENT_REQUEST: '2',
  /** Merchant → buyer: an order-status update. */
  STATUS_UPDATE: '3',
  /** Merchant → buyer: a shipping update. */
  SHIPPING_UPDATE: '4',
} as const;

/** A single product line on an order. */
export interface MarketOrderLine {
  /** Merchant pubkey (hex) the product coordinate roots on. */
  merchantPubkey: string;
  /** Product `d` tag (LP catalogue uses the product's stable id — see marketFeedback.ts). */
  dTag: string;
  /** Quantity ordered (clamped to a positive integer). */
  quantity: number;
  /** Unit price in satoshis. */
  priceSats: number;
}

/** The buyer's chosen shipping, threaded onto the order (#948 Option A). */
export interface OrderShippingInput {
  /** The chosen option's coordinate — `30406:<merchantPubkey>:<d>`. */
  coordinate: string;
  /** All-in shipping cost (30406 base + product surcharge), in sats. */
  costSats: number;
  /** Human label for the itemised summary (e.g. "Royal Mail Tracked 48"). */
  title: string;
}

export interface BuildOrderInput {
  /** Buyer's Nostr pubkey (hex) — the rumor author. */
  buyerPubkey: string;
  /** Merchant's Nostr pubkey (hex) — the gift-wrap + `p`-tag recipient. */
  vendorPubkey: string;
  /** The product lines. v1 checkout sends a single line, but the shape is general. */
  lines: MarketOrderLine[];
  /** Optional pre-generated order id (else a fresh v4 uuid). */
  orderId?: string;
  /** Optional created_at (unix seconds); defaults to now. Injectable for tests. */
  createdAt?: number;
  /** Optional free-text note to the merchant. */
  note?: string;
  /**
   * The chosen shipping option, when the merchant publishes kind-30406
   * options. Adds a `["shipping", <coordinate>]` tag, folds the cost into
   * `amount` (all-in total per Gamma), and itemises the content summary.
   */
  shipping?: OrderShippingInput;
  /**
   * Shipping address for a physical order — the Gamma `["address", …]` tag.
   * Rides only inside the NIP-17 gift wrap (never a public event). Omitted
   * when blank (digital goods).
   */
  address?: string;
}

/** Longest address we put on an order (a postal address, not a document). */
export const MAX_ORDER_ADDRESS_LENGTH = 500;

/** An unsigned NIP-17 rumor ready to gift-wrap: no `id`/`sig` (that's the seal/wrap's job). */
export interface OrderRumor {
  pubkey: string;
  kind: 16;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface BuiltMarketOrder {
  rumor: OrderRumor;
  orderId: string;
  /** Sum of quantity × unit-price across all lines, in sats. */
  totalSats: number;
}

/**
 * The addressable product coordinate a `["item", …]` tag references —
 * `30402:<merchantPubkey>:<dTag>` (NIP-99). Note this is the BARE coordinate
 * (no `a:` prefix — that prefix is only for the `a`-tag form used by reviews).
 */
export function productCoordinate(merchantPubkey: string, dTag: string): string {
  return `${PRODUCT_COORD_KIND}:${merchantPubkey}:${dTag}`;
}

/** Clamp an untrusted quantity to a positive integer (defaults to 1). */
function normalizeQuantity(quantity: number): number {
  return Number.isFinite(quantity) && quantity >= 1 ? Math.floor(quantity) : 1;
}

/** Total in sats for a set of lines: Σ (positive-int quantity × non-negative price).
 * Prices are rounded to whole sats — `parseOrderEvent` only accepts an
 * integer `amount` tag, so a fractional total would be dropped on parse. */
export function orderTotalSats(lines: MarketOrderLine[]): number {
  return lines.reduce((sum, line) => {
    const qty = normalizeQuantity(line.quantity);
    const price =
      Number.isFinite(line.priceSats) && line.priceSats >= 0 ? Math.round(line.priceSats) : 0;
    return sum + qty * price;
  }, 0);
}

/**
 * A v4 UUID for the order, derived from CSPRNG bytes
 * (`crypto.getRandomValues` — polyfilled on device via
 * react-native-get-random-values, and native in the jest/Node test env). Kept
 * dependency-light: the app carries no uuid library.
 */
export function newOrderId(): string {
  const bytes = new Uint8Array(16);
  // global Crypto — RN polyfill (react-native-get-random-values) + Node webcrypto.
  (globalThis.crypto as Crypto).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** First 8 chars of the order UUID (dashes stripped) — the user-facing short id. */
export function shortOrderId(orderId: string): string {
  return orderId.replace(/-/g, '').slice(0, 8);
}

/**
 * Build the kind-16 `["type","1"]` order rumor a buyer gift-wraps (NIP-17) to
 * the merchant. Tag shape mirrors Gamma's `createOrderTags`:
 *
 *   ["p", <merchant>]               – recipient (gift-wrap + addressing)
 *   ["subject", "Order <short id>"] – human subject line
 *   ["type", "1"]                   – order creation
 *   ["order", <uuid>]              – the order id (threads status/receipt)
 *   ["amount", <totalSats>]        – ALL-IN total in sats (subtotal + shipping)
 *   ["item", "30402:<merchant>:<dTag>", <qty>]  – one per product line
 *   ["shipping", "30406:<merchant>:<dTag>"]     – chosen shipping option, when any
 *   ["address", <postal address>]               – physical orders only
 *
 * Spec: GammaMarkets/market-spec §4 "Order Creation" — `p`, `subject`, `type`,
 * `order`, `amount` (sats) and one `item` per line are required; `shipping`,
 * `address` (and `email` / `phone`, which LP doesn't collect) are optional.
 *
 * The merchant's order-service replies with a kind-16 `["type","2"]` payment
 * request carrying the BOLT11 invoice, which LP renders as a payable order card.
 */
export function buildMarketOrder(input: BuildOrderInput): BuiltMarketOrder {
  const orderId = input.orderId ?? newOrderId();
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1000);
  const subtotalSats = orderTotalSats(input.lines);
  const shippingSats =
    input.shipping && Number.isFinite(input.shipping.costSats) && input.shipping.costSats >= 0
      ? Math.round(input.shipping.costSats)
      : 0;
  const totalSats = subtotalSats + shippingSats;

  const tags: string[][] = [
    ['p', input.vendorPubkey],
    ['subject', `Order ${shortOrderId(orderId)}`],
    ['type', ORDER_MESSAGE_TYPE.CREATION],
    ['order', orderId],
    ['amount', String(totalSats)],
  ];
  for (const line of input.lines) {
    tags.push([
      'item',
      productCoordinate(line.merchantPubkey, line.dTag),
      String(normalizeQuantity(line.quantity)),
    ]);
  }
  if (input.shipping) tags.push(['shipping', input.shipping.coordinate]);
  const address = normalizeOrderAddress(input.address);
  if (address) tags.push(['address', address]);

  // Human-readable itemisation so the merchant's (and the buyer's own echo)
  // DM summary shows exactly how the all-in amount breaks down.
  const contentParts: string[] = [];
  if (input.note?.trim()) contentParts.push(input.note.trim());
  if (input.shipping) {
    contentParts.push(
      [
        `Subtotal: ${subtotalSats.toLocaleString('en-US')} sats`,
        `Shipping (${input.shipping.title}): ${shippingSats.toLocaleString('en-US')} sats`,
        `Total: ${totalSats.toLocaleString('en-US')} sats`,
      ].join('\n'),
    );
  }

  return {
    orderId,
    totalSats,
    rumor: {
      pubkey: input.buyerPubkey,
      kind: 16,
      created_at: createdAt,
      tags,
      content: contentParts.join('\n\n'),
    },
  };
}

/** Trim an address, collapse blank lines, cap its length; '' when empty. */
export function normalizeOrderAddress(address: string | undefined): string {
  if (!address) return '';
  return address
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_ORDER_ADDRESS_LENGTH);
}
