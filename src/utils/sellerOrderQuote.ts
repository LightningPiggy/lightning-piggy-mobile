// Seller-side pricing of an incoming Gamma order (kind-16 `type 1`). PURE —
// no React, no I/O (coverage scope: src/utils).
//
// The buyer's order names WHAT they want (`item` refs + quantities, the chosen
// `shipping` option) and states an `amount` in sats. The seller must never
// invoice that asserted amount: the total is recomputed here from the
// seller's OWN current listing (30402) and shipping (30406) events at the
// app's current BTC rate (market-spec §4: "Final price may differ from the
// order creation time — merchants decide whether to honor original prices").
// When the buyer's figure disagrees, the seller's figure wins and the
// difference is flagged.
//
// Ownership: every `item` must be `30402:<seller>:<d>` for a listing the
// seller currently publishes. An order that names anyone else's listing (or
// mixes) is not the seller's to invoice.
import type { Event } from 'nostr-tools';
import type { ParsedOrderEvent } from './orderEvents';
import type { ShippingOption } from './marketShipping';
import { normalizeCurrencyCode } from './currencyCode';
import { listingShippingRefs, listingStock } from './marketListingShipping';
import { amountToSats, isSatsDenominated, type BtcRates } from './marketCheckoutPricing';

const HEX64 = /^[0-9a-f]{64}$/;

/** A parsed `30402:<pubkey>:<d>` / `30406:<pubkey>:<d>` coordinate. */
export function parseCoordinate(
  ref: string,
  kind: 30402 | 30406,
): { pubkey: string; dTag: string } | null {
  const match = /^(\d+):([0-9a-fA-F]{64}):(.+)$/.exec(ref ?? '');
  if (!match || Number(match[1]) !== kind) return null;
  const pubkey = match[2].toLowerCase();
  return HEX64.test(pubkey) ? { pubkey, dTag: match[3] } : null;
}

export type OrderOwnership = 'mine' | 'notMine' | 'empty';

/** Whether every item on `order` references a listing authored by `seller`. */
export function orderOwnership(order: ParsedOrderEvent, sellerPubkey: string): OrderOwnership {
  if (order.type !== 'order' || order.kind !== 16 || order.items.length === 0) return 'empty';
  const seller = sellerPubkey.toLowerCase();
  return order.items.every((item) => parseCoordinate(item.ref, 30402)?.pubkey === seller)
    ? 'mine'
    : 'notMine';
}

export interface SellerOrderLine {
  ref: string;
  dTag: string;
  title: string;
  image?: string;
  quantity: number;
  /** Listing price in its own currency. */
  unitAmount: number;
  currency: string;
  /** null when the currency needs a rate we don't have. */
  unitSats: number | null;
  lineSats: number | null;
  /** The listing's `stock` when tracked. */
  stock: number | null;
  /** Ordered more than the listing's stock. */
  overStock: boolean;
}

export interface SellerOrderShipping {
  coordinate: string;
  title: string;
  /** All-in cost in sats (option base + listing surcharges); null = no rate. */
  sats: number | null;
  /** Option base in its own currency, plus surcharges in the listing currency. */
  baseAmount: number;
  baseCurrency: string;
  /** The order's listings reference other options, not this one. */
  notOffered: boolean;
}

export type SellerQuoteProblem =
  /** An item isn't one of this seller's listings. */
  | 'notMine'
  /** An item names a listing the seller no longer publishes. */
  | 'missingListing'
  /** A listing has no usable one-off price. */
  | 'badPrice'
  /** The chosen shipping option isn't one of the seller's published options. */
  | 'unknownShipping'
  /** A fiat figure can't be converted (no BTC rate yet). */
  | 'noRate';

export interface SellerOrderQuote {
  /** Blocking problem, or null when the quote is invoiceable. */
  problem: SellerQuoteProblem | null;
  lines: SellerOrderLine[];
  shipping: SellerOrderShipping | null;
  /** A physical item was ordered without choosing shipping. */
  shippingMissing: boolean;
  subtotalSats: number | null;
  shippingSats: number;
  totalSats: number | null;
  /** The whole order in one fiat currency, when every price shares it. */
  fiatTotal: { amount: number; currency: string } | null;
  /** What the buyer's order asserted. */
  buyerAmountSats: number | null;
  /** Buyer's amount ≠ the seller's computed total. */
  amountMismatch: boolean;
}

export interface QuoteSellerOrderInput {
  order: ParsedOrderEvent;
  sellerPubkey: string;
  /** The seller's own current listings (newest revision per `d`). */
  listings: readonly Event[];
  /** The seller's own published shipping options. */
  zones: readonly ShippingOption[];
  rates: BtcRates;
}

const tag = (event: Event, name: string) => event.tags.find((t) => t[0] === name);

/** Strip binary float noise from a summed money amount. */
const roundMoney = (value: number) => Math.round(value * 1e8) / 1e8;

function emptyQuote(order: ParsedOrderEvent, problem: SellerQuoteProblem): SellerOrderQuote {
  return {
    problem,
    lines: [],
    shipping: null,
    shippingMissing: false,
    subtotalSats: null,
    shippingSats: 0,
    totalSats: null,
    fiatTotal: null,
    buyerAmountSats: order.amountSats ?? null,
    amountMismatch: false,
  };
}

/** Price `order` from the seller's own events. */
export function quoteSellerOrder(input: QuoteSellerOrderInput): SellerOrderQuote {
  const { order, rates } = input;
  const seller = input.sellerPubkey.toLowerCase();
  if (orderOwnership(order, seller) !== 'mine') return emptyQuote(order, 'notMine');

  const byD = new Map<string, Event>();
  for (const event of input.listings) {
    if (event.kind !== 30402 || event.pubkey.toLowerCase() !== seller) continue;
    const d = tag(event, 'd')?.[1];
    if (d) byD.set(d, event);
  }

  let problem: SellerQuoteProblem | null = null;
  let physical = false;
  const lines: SellerOrderLine[] = [];
  const listingsInOrder: Event[] = [];
  for (const item of order.items) {
    const { dTag } = parseCoordinate(item.ref, 30402)!;
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0)
      return emptyQuote(order, 'badPrice');
    const listing = byD.get(dTag);
    if (!listing) return emptyQuote(order, 'missingListing');
    listingsInOrder.push(listing);
    const priceTag = tag(listing, 'price');
    const unitAmount = Number(priceTag?.[1]);
    const currency = normalizeCurrencyCode(priceTag?.[2] ?? '');
    if (!Number.isFinite(unitAmount) || unitAmount <= 0 || !currency || priceTag?.[3]?.trim()) {
      return emptyQuote(order, 'badPrice');
    }
    if (tag(listing, 'type')?.[2]?.trim().toLowerCase() === 'physical') physical = true;
    const unitSats = amountToSats(unitAmount, currency, rates);
    if (unitSats === null) problem = 'noRate';
    const lineSats = unitSats === null ? null : unitSats * item.quantity;
    const stock = listingStock(listing);
    lines.push({
      ref: item.ref,
      dTag,
      title: (tag(listing, 'title')?.[1]?.trim() || dTag).slice(0, 500),
      image: tag(listing, 'image')?.[1],
      quantity: item.quantity,
      unitAmount,
      currency,
      unitSats,
      lineSats,
      stock,
      overStock: stock !== null && item.quantity > stock,
    });
  }

  let shipping: SellerOrderShipping | null = null;
  if (order.shipping) {
    const ref = parseCoordinate(order.shipping, 30406);
    const option =
      ref?.pubkey === seller ? input.zones.find((z) => z.coordinate === order.shipping) : undefined;
    if (!option) {
      problem = problem ?? 'unknownShipping';
    } else {
      // Gamma: a listing's `shipping_option` extra cost is in the PRODUCT's
      // currency, added per ordered line that references this option.
      let sats = amountToSats(option.baseAmount, option.currency, rates);
      let notOffered = false;
      for (let i = 0; i < listingsInOrder.length; i++) {
        const refs = listingShippingRefs(listingsInOrder[i]);
        const match = refs.find((r) => r.coordinate === option.coordinate);
        if (!match) {
          if (refs.length > 0) notOffered = true;
          continue;
        }
        if (match.extraAmount > 0 && sats !== null) {
          const extra = amountToSats(match.extraAmount, lines[i].currency, rates);
          sats = extra === null ? null : sats + extra;
        }
      }
      if (sats === null) problem = problem ?? 'noRate';
      shipping = {
        coordinate: option.coordinate,
        title: option.title,
        sats,
        baseAmount: option.baseAmount,
        baseCurrency: option.currency,
        notOffered,
      };
    }
  }

  if ((physical && !order.shipping) || shipping?.notOffered) problem = problem ?? 'unknownShipping';

  const subtotalSats = lines.every((l) => l.lineSats !== null)
    ? lines.reduce((sum, l) => sum + (l.lineSats ?? 0), 0)
    : null;
  const shippingSats = shipping?.sats ?? 0;
  const totalSats =
    problem === null && subtotalSats !== null && Number.isSafeInteger(subtotalSats + shippingSats)
      ? subtotalSats + shippingSats
      : null;

  // One-currency fiat total (e.g. every price in GBP), shown beside the sats.
  let fiatTotal: SellerOrderQuote['fiatTotal'] = null;
  const fiat = lines[0]?.currency;
  if (
    fiat &&
    !isSatsDenominated(fiat) &&
    lines.every((l) => l.currency === fiat) &&
    (!shipping || normalizeCurrencyCode(shipping.baseCurrency) === fiat)
  ) {
    let amount = lines.reduce((sum, l) => sum + l.unitAmount * l.quantity, 0);
    if (shipping) {
      amount += shipping.baseAmount;
      for (const listing of listingsInOrder) {
        const match = listingShippingRefs(listing).find(
          (r) => r.coordinate === shipping!.coordinate,
        );
        if (match) amount += match.extraAmount;
      }
    }
    fiatTotal = { amount: roundMoney(amount), currency: fiat };
  }

  const buyerAmountSats = order.amountSats ?? null;
  return {
    problem,
    lines,
    shipping,
    shippingMissing: physical && !order.shipping,
    subtotalSats,
    shippingSats,
    totalSats,
    fiatTotal,
    buyerAmountSats,
    amountMismatch: totalSats !== null && buyerAmountSats !== null && buyerAmountSats !== totalSats,
  };
}

/** "Mug × 2, Hat × 1" — the items summary (titles from the quote when known). */
export function orderItemsSummary(
  order: Pick<ParsedOrderEvent, 'items'>,
  titles: ReadonlyMap<string, string> = new Map(),
): string {
  return order.items
    .map((item) => {
      const title = titles.get(item.ref) ?? parseCoordinate(item.ref, 30402)?.dTag ?? item.ref;
      return `${title} × ${item.quantity}`;
    })
    .join(', ');
}
