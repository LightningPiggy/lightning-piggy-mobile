// Gate for the in-app Market checkout: decides whether "Buy" places a NIP-17
// Gamma order (and with what terms) or, for curated products, opens the
// seller's website.
//
// Two sources reach checkout:
//
//   - **curated** catalogue products carry an explicit `checkout` opt-in (the
//     seller's real listing `d` tag + fulfilment) — an npub alone doesn't prove
//     a curated shop's order service recognises the listing (#948).
//   - **listing** — any signed kind-30402 relay listing (Gamma Markets /
//     NIP-99) with a valid one-off price that isn't the viewer's own. The
//     order references the listing's own coordinate, so the seller (or their
//     Gamma-aware client) can price it from their own events; a seller who
//     doesn't run one still gets the order card / can be messaged.
//
// No React, no I/O (coverage scope: src/utils).
import type { MarketProduct, MarketProductCheckout } from '../data/marketProducts';
import type { MarketVendor } from '../data/marketVendors';
import { CURRENCIES } from '../services/fiatService';
import { normalizeCurrencyCode } from './currencyCode';
import {
  listingShippingRefs,
  listingStock,
  type ListingShippingRef,
} from './marketListingShipping';
import { vendorNostrPubkey } from './marketVendors';

export interface MarketCheckoutTarget extends MarketProductCheckout {
  /** Seller's Nostr pubkey (hex) — the order recipient. */
  vendorPubkey: string;
  source: 'curated' | 'listing';
  /** Listing price in its own currency — `listing` source only. */
  price?: { amount: number; currency: string };
  /** Units the seller says are available (`stock` tag); null = not tracked. */
  stock: number | null;
  /**
   * The listing's `shipping_option` refs (surcharges in the LISTING currency).
   * Empty → offer every shipping option the seller publishes.
   */
  shippingRefs: ListingShippingRef[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Currencies a listing price can be ordered in: sats/BTC, or a fiat the
 * app has a BTC rate for (so the order `amount` can be stated in sats). */
export function isOrderableCurrency(currency: string): boolean {
  const cur = normalizeCurrencyCode(currency);
  return cur === 'SATS' || cur === 'BTC' || CURRENCIES.includes(cur);
}

/** The in-app checkout target for a kind-30402 listing, or null. */
function listingCheckoutTarget(
  product: MarketProduct,
  viewerPubkey: string | null | undefined,
): MarketCheckoutTarget | null {
  const event = product.listing?.event;
  if (!event || event.kind !== 30402) return null;
  const vendorPubkey = event.pubkey.toLowerCase();
  if (!HEX64.test(vendorPubkey)) return null;
  // Your own listing gets "Edit listing", not Buy.
  if (viewerPubkey && viewerPubkey.toLowerCase() === vendorPubkey) return null;
  const listingDTag = event.tags.find((t) => t[0] === 'd')?.[1]?.trim();
  if (!listingDTag) return null;

  const priceTag = event.tags.find((t) => t[0] === 'price');
  const amount = Number(priceTag?.[1]);
  const currency = normalizeCurrencyCode(priceTag?.[2] ?? '');
  if (!Number.isFinite(amount) || amount <= 0 || !isOrderableCurrency(currency)) return null;
  // A subscription (`price` frequency) isn't a one-off order.
  if (priceTag?.[3]?.trim()) return null;

  // Gamma `type`: [simple|variable|variation, digital|physical]; defaults to
  // simple + digital. A `variable` parent isn't itself purchasable — the
  // buyer orders one of its variations.
  const typeTag = event.tags.find((t) => t[0] === 'type');
  if (typeTag?.[1]?.trim().toLowerCase() === 'variable') return null;
  const physical = typeTag?.[2]?.trim().toLowerCase() === 'physical';

  return {
    vendorPubkey,
    listingDTag,
    fulfilment: physical ? 'physical' : 'none',
    source: 'listing',
    price: { amount, currency },
    stock: listingStock(event),
    shippingRefs: physical ? listingShippingRefs(event) : [],
  };
}

/**
 * The in-app checkout target for `product`, or null to fall back (curated →
 * website; listing → Message seller only). `viewerPubkey` keeps the signed-in
 * user from ordering their own listing.
 */
export function marketCheckoutTarget(
  product: MarketProduct,
  vendor: MarketVendor | undefined,
  viewerPubkey?: string | null,
): MarketCheckoutTarget | null {
  if (product.listing) return listingCheckoutTarget(product, viewerPubkey);
  const checkout = product.checkout;
  if (!checkout || !vendor) return null;
  const listingDTag = checkout.listingDTag.trim();
  if (!listingDTag) return null;
  if (checkout.fulfilment !== 'physical' && checkout.fulfilment !== 'none') return null;
  const vendorPubkey = vendorNostrPubkey(vendor);
  if (!vendorPubkey) return null;
  return {
    vendorPubkey,
    listingDTag,
    fulfilment: checkout.fulfilment,
    source: 'curated',
    stock: null,
    shippingRefs: [],
  };
}

/** Most units one order may ask for: the stock when tracked, capped at `cap`. */
export function maxOrderQuantity(target: Pick<MarketCheckoutTarget, 'stock'>, cap = 99): number {
  return target.stock === null ? cap : Math.max(0, Math.min(cap, target.stock));
}
