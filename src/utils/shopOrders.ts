// Incoming Gamma orders for the seller's OWN listings (#1534), derived from
// rows already in the encrypted DM store. PURE: no I/O. `useShopOrders` reads
// the rows and this shapes them for the hub's Orders summary and the Orders
// screen.
//
// An order is a kind-16 `["type","1"]` rumor (stored with wireKind 16 and
// the canonical `serializeOrder` JSON as content) from a buyer, with at least
// one `item` coordinate rooted on the seller's pubkey. An outgoing kind-16
// `["type","2"]` payment request with the same order id means an invoice has
// already been sent.
import type { DmMessageRow } from '../services/dmDb';
import { parseStoredOrder } from './orderEvents';

export type OrderRowInput = Pick<
  DmMessageRow,
  'eventId' | 'conversation' | 'createdAt' | 'content' | 'fromMe' | 'wireKind'
>;

export interface ShopOrderLine {
  /** `30402:<seller>:<d>` */
  ref: string;
  dTag: string;
  /** The listing's title when it's still in the shop, else its `d` tag. */
  title: string;
  quantity: number;
}

export interface ShopOrder {
  /** Stable row key: buyer + order id. */
  key: string;
  orderId: string;
  /** The stored DM row id of the order message, used to jump to it in the chat. */
  eventId: string;
  /** Buyer pubkey (hex), which is also the NIP-17 conversation id. */
  buyer: string;
  createdAt: number;
  lines: ShopOrderLine[];
  amountSats?: number;
  /** A payment request for this order has been sent to the buyer. */
  invoiceSent: boolean;
}

const orderKey = (buyer: string, orderId: string) => `${buyer}:${orderId}`;

/** Newest first; duplicates of the same order (re-sends) keep the first one. */
export function deriveShopOrders(
  rows: readonly OrderRowInput[],
  sellerPubkey: string,
  titles: ReadonlyMap<string, string> = new Map(),
): ShopOrder[] {
  const prefix = `30402:${sellerPubkey.toLowerCase()}:`;
  const invoiced = new Set<string>();
  const orders = new Map<string, ShopOrder>();
  for (const row of rows) {
    if (row.wireKind !== 16) continue;
    const order = parseStoredOrder(row.content);
    if (!order) continue;
    const buyer = row.conversation.toLowerCase();
    if (row.fromMe) {
      if (order.type === 'payment') invoiced.add(orderKey(buyer, order.orderId));
      continue;
    }
    if (order.type !== 'order') continue;
    const lines: ShopOrderLine[] = [];
    for (const item of order.items) {
      // Coordinates are `kind:pubkey:d`. Compare the pubkey case-insensitively
      // but keep the `d` tag exactly as written.
      const [kind, pubkey, ...rest] = item.ref.split(':');
      if (`${kind}:${pubkey?.toLowerCase()}:` !== prefix || rest.length === 0) continue;
      const dTag = rest.join(':');
      lines.push({
        ref: item.ref,
        dTag,
        title: (titles.get(dTag) || dTag).slice(0, 500),
        quantity: item.quantity,
      });
    }
    if (lines.length === 0) continue;
    const key = orderKey(buyer, order.orderId);
    const existing = orders.get(key);
    if (existing && existing.createdAt <= row.createdAt) continue;
    orders.set(key, {
      key,
      orderId: order.orderId,
      eventId: row.eventId,
      buyer,
      createdAt: row.createdAt,
      lines,
      amountSats: order.amountSats,
      invoiceSent: false,
    });
  }
  return [...orders.values()]
    .map((o) => (invoiced.has(o.key) ? { ...o, invoiceSent: true } : o))
    .sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
}

/** Orders still waiting for the seller's invoice. */
export const ordersNeedingInvoice = (orders: readonly ShopOrder[]): number =>
  orders.reduce((n, o) => (o.invoiceSent ? n : n + 1), 0);

/** `d` tag → title for the seller's listings, for naming order lines. */
export function listingTitleMap(
  listings: readonly { tags: string[][] }[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const event of listings) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    const title = event.tags.find((t) => t[0] === 'title')?.[1];
    if (d && title) map.set(d, title);
  }
  return map;
}
