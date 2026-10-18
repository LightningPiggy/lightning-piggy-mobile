// Seller → buyer Gamma order messages (market-spec §4). PURE — builds the
// unsigned NIP-17 rumors; services/nip17RumorSend seals + gift-wraps them.
// Kinds 16/17 never leave a gift wrap (utils/wrapOnlyKinds).
//
//   Payment request (kind 16, type 2) — "Manual Processing (merchant → buyer)":
//     ["p", <buyer>] ["subject", "order-payment"] ["type", "2"]
//     ["order", <id>] ["amount", <sats>] ["payment", "lightning", <bolt11>]
//     ["expiration", <unix>]   (optional — the bolt11's own expiry)
//
//   Status update (kind 16, type 3):
//     ["p", <buyer>] ["subject", "order-info"] ["type", "3"]
//     ["order", <id>] ["status", pending|confirmed|processing|completed|cancelled]
//
// Plus the kind-14 chat note Robotechy's order service sends alongside the
// payment request: generic NIP-17 clients (0xchat, Amethyst's DM view) can't
// render a kind-16 card, so the SAME bolt11 also rides as readable text. LP
// drops that note when it matches an order card's invoice
// (conversationItems.suppressDuplicateOrderInvoiceNotes).
import { ORDER_MESSAGE_TYPE, shortOrderId } from './marketOrder';

export interface UnsignedOrderRumor {
  pubkey: string;
  kind: 14 | 16;
  created_at: number;
  tags: string[][];
  content: string;
}

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'processing',
  'completed',
  'cancelled',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const now = () => Math.floor(Date.now() / 1000);

export interface PaymentRequestInput {
  sellerPubkey: string;
  buyerPubkey: string;
  orderId: string;
  amountSats: number;
  bolt11: string;
  /** Invoice expiry (unix seconds), when the bolt11 carries one. */
  expiresAt?: number | null;
  /** Human note in the content (e.g. "Invoice for order #ab12cd34 — 21,000 sats"). */
  note?: string;
  createdAt?: number;
}

/** The kind-16 type-2 payment request a seller sends for `orderId`. */
export function buildPaymentRequestRumor(input: PaymentRequestInput): UnsignedOrderRumor {
  if (!Number.isSafeInteger(input.amountSats) || input.amountSats <= 0) {
    throw new Error('Payment request amount must be a positive whole number of sats');
  }
  const tags: string[][] = [
    ['p', input.buyerPubkey],
    ['subject', 'order-payment'],
    ['type', ORDER_MESSAGE_TYPE.PAYMENT_REQUEST],
    ['order', input.orderId],
    ['amount', String(input.amountSats)],
    ['payment', 'lightning', input.bolt11],
  ];
  if (input.expiresAt && Number.isSafeInteger(input.expiresAt)) {
    tags.push(['expiration', String(input.expiresAt)]);
  }
  return {
    pubkey: input.sellerPubkey,
    kind: 16,
    created_at: input.createdAt ?? now(),
    tags,
    content: input.note ?? '',
  };
}

export interface StatusUpdateInput {
  sellerPubkey: string;
  buyerPubkey: string;
  orderId: string;
  status: OrderStatus;
  note?: string;
  createdAt?: number;
}

/** The kind-16 type-3 status update (e.g. `confirmed` once paid). */
export function buildStatusUpdateRumor(input: StatusUpdateInput): UnsignedOrderRumor {
  if (!ORDER_STATUSES.includes(input.status)) throw new Error(`Unknown status ${input.status}`);
  return {
    pubkey: input.sellerPubkey,
    kind: 16,
    created_at: input.createdAt ?? now(),
    tags: [
      ['p', input.buyerPubkey],
      ['subject', 'order-info'],
      ['type', ORDER_MESSAGE_TYPE.STATUS_UPDATE],
      ['order', input.orderId],
      ['status', input.status],
    ],
    content: input.note ?? '',
  };
}

/** The readable kind-14 copy of the invoice for clients without order cards. */
export function buildInvoiceChatNote(input: {
  sellerPubkey: string;
  buyerPubkey: string;
  orderId: string;
  amountSats: number;
  bolt11: string;
  createdAt?: number;
}): UnsignedOrderRumor {
  return {
    pubkey: input.sellerPubkey,
    kind: 14,
    created_at: input.createdAt ?? now(),
    tags: [
      ['p', input.buyerPubkey],
      ['order', input.orderId],
    ],
    content: `⚡ Invoice for order #${shortOrderId(input.orderId)} — ${input.amountSats.toLocaleString('en-US')} sats:\n${input.bolt11}`,
  };
}
