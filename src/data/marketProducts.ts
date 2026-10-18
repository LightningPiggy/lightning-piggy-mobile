// Lightning Piggy "Market" PRODUCT catalogue.
//
// The Explore Market section lists PRODUCTS (not shops), mirroring the
// companion website at https://lightningpiggy.com/market/, which presents a
// grid of individual product cards (image, title, price, seller) sourced
// from a curated set of designated Lightning Piggy "preferred seller" shops.
//
// Source of truth for the SELLERS is `src/data/marketVendors.ts` (the same
// hand-ported vendor directory the website renders). This module layers the
// individual PRODUCTS on top, each tagged with the `sellerName` of the
// vendor it comes from, so a product card can show "from <shop>".
//
// --- Why hardcoded, and the live-feed seam (design only) ----------------
// On the website each listing is "pulled live from the vendor's Nostr
// profile". A future enhancement could SUPPLEMENT or REPLACE this static
// list with a live Nostr product feed, pulling the SAME event kinds the
// website's `src/components/market/NostrProducts.astro` already queries:
//   • NIP-15 Marketplace — stalls (kind 30017) + products (kind 30018)
//   • NIP-99 Classified listings — kind 30402
// A loader implementing `MarketProductSource` (below) would fetch those
// kinds from the relevant author set (preferred sellers, or the user's
// web-of-trust follows — see `marketMode.ts`), map each event into a
// `MarketProduct`, and merge with this curated list. The data-source plug
// point is `MarketProductSource.getProducts()`; only the seam is defined —
// the relay fetch is deliberately left unimplemented for now.

import { MARKET_VENDORS, type MarketVendor } from './marketVendors';
import type { MarketListing } from '../utils/marketListings';

/** A single product offered by a Market seller. Field layout mirrors the
 * website's product cards (image, title, price, seller). */
export interface MarketProduct {
  /** Signed relay listing; never implies merchant checkout support. */
  listing?: MarketListing;
  /** Stable id — used as the React key and to build testIDs. */
  id: string;
  /** Product title, e.g. "Lightning Piggy". */
  title: string;
  /** Short marketing blurb (one or two lines on the card). */
  description: string;
  /** Price in satoshis (the app's native unit). Authored from the
   * website's fiat reference price at a documented snapshot rate — see
   * the PRICE_SNAPSHOT note below. */
  priceSats: number;
  /** Original fiat reference price the sats figure was derived from, kept
   * for provenance / a future live re-quote (e.g. "£60"). */
  priceFiatLabel: string;
  /** Product image URL (absolute https). */
  image: string;
  /** Every image of a relay listing, in the seller's order (`image` is the
   * first). Absent for curated products, which carry just `image`. */
  images?: string[];
  /** Display name of the seller/shop this product comes from. Must match a
   * `MarketVendor.name` in {@link MARKET_VENDORS} so the card can resolve
   * the seller (logo, Nostr identity, shop URL). */
  sellerName: string;
  /** Link opened on "Buy" — the product (or seller) page. Absolute https. */
  url: string;
  /** Featured products surface first in the rail/list. */
  featured: boolean;
  /**
   * Explicit opt-in to the in-app (NIP-17 gift-wrapped order) checkout.
   * OMITTED means "Buy" opens the seller's website — the default for every
   * real seller until they have confirmed they run an order service that
   * accepts orders for the listing below. Never infer this from the seller
   * merely having an npub.
   */
  checkout?: MarketProductCheckout;
}

/** Seller-confirmed facts the in-app checkout needs to address an order. */
export interface MarketProductCheckout {
  /** `d` tag of the seller's OWN published listing (kind 30402) that the
   * order's `item` tag references. Must be the seller's real listing id —
   * never an id the app made up for the catalogue. */
  listingDTag: string;
  /**
   * `physical` — the seller's kind-30406 shipping options are required: an
   * empty, invalid or timed-out fetch blocks the order (fail closed).
   * `none` — the seller has confirmed nothing is shipped, so checkout skips
   * the shipping step. Only set `none` on the seller's explicit say-so.
   */
  fulfilment: 'physical' | 'none';
}

// PRICE_SNAPSHOT — the sats figures below were derived from the website's
// GBP reference prices at ~£0.0006/sat (≈ £60k/BTC), the rate at authoring
// time (2026-06). A live feed would quote sats directly (or re-derive from
// the seller's fiat price + a spot rate) instead of baking them in.
const PRICE_SNAPSHOT_SATS_PER_GBP = Math.round(1 / 0.0006);

// Convert an authored GBP reference price into the baked sats figure,
// keeping the data table readable (one place defines the rate).
const gbpToSats = (gbp: number): number => Math.round(gbp * PRICE_SNAPSHOT_SATS_PER_GBP);

// Test-only products (#948 buy-flow validation) — DEV builds ONLY, never
// shipped. Priced at 21 sats and sold by the Big/Little Piggy "(TEST)" sellers
// (see PIG_TEST_VENDORS) so a pig-to-pig NIP-17 order can be exercised on a dev
// build. Titles are clearly marked [TEST] so they can't be mistaken for real
// listings. These are the ONLY entries opted in to in-app checkout; the real
// sellers below keep the website link until they confirm order support.
export const PIG_TEST_PRODUCTS: MarketProduct[] = __DEV__
  ? [
      {
        id: 'test-big-piggy-21sat',
        title: '[TEST] Big Piggy Test Item',
        description: 'TEST product for NIP-17 order-flow validation — please do not buy. ⚠️',
        priceSats: 21,
        priceFiatLabel: '21 sats',
        image:
          'https://cdn.nostrcheck.me/d4a4687a0edb77f57bf30a53e4a886237058a52778c573deb0c63c94da1937fe.webp',
        sellerName: 'Big Piggy (TEST)',
        url: 'https://lightningpiggy.com',
        featured: false,
        checkout: { listingDTag: 'test-big-piggy-21sat', fulfilment: 'physical' },
      },
      {
        id: 'test-little-piggy-21sat',
        title: '[TEST] Little Piggy Test Item',
        description: 'TEST product for NIP-17 order-flow validation — please do not buy. ⚠️',
        priceSats: 21,
        priceFiatLabel: '21 sats',
        image:
          'https://cdn.nostrcheck.me/d4a4687a0edb77f57bf30a53e4a886237058a52778c573deb0c63c94da1937fe.webp',
        sellerName: 'Little Piggy (TEST)',
        url: 'https://lightningpiggy.com',
        featured: false,
        checkout: { listingDTag: 'test-little-piggy-21sat', fulfilment: 'physical' },
      },
    ]
  : [];

export const MARKET_PRODUCTS: MarketProduct[] = [
  ...PIG_TEST_PRODUCTS,
  {
    id: 'robotechy-lightning-piggy',
    title: 'Lightning Piggy',
    description:
      'Electronic cash piggy bank for smart savers and their families that accepts Bitcoin sent over Lightning.',
    priceSats: gbpToSats(60),
    priceFiatLabel: '£60',
    image:
      'https://cdn.nostrcheck.me/d4a4687a0edb77f57bf30a53e4a886237058a52778c573deb0c63c94da1937fe.webp',
    sellerName: 'Robotechy',
    url: 'https://robotechy.com',
    featured: true,
  },
  {
    id: 'robotechy-bag-charm',
    title: 'Lightning Piggy Bag Charm',
    description: 'Keyring / bag charm with an NFC tag you can program with pay links.',
    priceSats: gbpToSats(4.5),
    priceFiatLabel: '£4.50',
    image:
      'https://cdn.nostrcheck.me/8a02bf562b2df6b0138ad2d72d2b9a25c244950012f0e45de966666c3a1a68bc.webp',
    sellerName: 'Robotechy',
    url: 'https://robotechy.com',
    featured: false,
  },
  {
    id: 'robotechy-nostr-badge',
    title: 'Nostr Badge',
    description: 'Keyring with a pin backing — wear your Nostr pride.',
    priceSats: gbpToSats(4.5),
    priceFiatLabel: '£4.50',
    image:
      'https://cdn.nostrcheck.me/0c43c6b00d25917f733a18863857fcb941f8d10f7224e8997e8d6907db00946b.webp',
    sellerName: 'Robotechy',
    url: 'https://robotechy.com',
    featured: false,
  },
  {
    id: 'satoshistore-lightning-piggy-merch',
    title: 'Lightning Piggy Merch',
    description: 'Wonderful Lightning Piggy merch — piggies incoming.',
    priceSats: gbpToSats(25),
    priceFiatLabel: '£25',
    // SatoshiStore's own avatar (their shop og:image is a text-printed t-shirt
    // photo; see the vendor entry in marketVendors.ts) — NOT the Danish Bacon
    // logo, which would mis-brand this seller's product (Copilot review on #948).
    image: 'https://unavatar.io/twitter/satoshistoreio',
    sellerName: 'SatoshiStore.io',
    url: 'https://satoshistore.io/collections/lightning-piggy',
    featured: false,
  },
  {
    id: 'bitcoinstuffstore-lightning-piggy',
    title: 'Lightning Piggy',
    description: 'Lightning Piggy from a European Bitcoin merch store, miners and gadgets.',
    priceSats: gbpToSats(65),
    priceFiatLabel: '£65',
    image: 'https://www.bitcoinstuffstore.com/wp-content/uploads/2024/07/Lightningpiggy.webp',
    sellerName: 'BitcoinStuffStore',
    url: 'https://www.bitcoinstuffstore.com/product/lightning-piggy/',
    featured: false,
  },
  {
    id: 'danish-bacon-lightning-piggy',
    title: 'Lightning Piggy',
    description: 'Get your Lightning Piggy directly from the project team. ⚡',
    priceSats: gbpToSats(55),
    priceFiatLabel: '£55',
    image: 'https://lightningpiggy.com/images/logos/danish-bacon.png',
    sellerName: 'Danish Bacon',
    url: 'https://lightningpiggy.com/market/danish-bacon',
    featured: true,
  },
];

/** Resolve the {@link MarketVendor} a product is sold by, or `undefined`
 * when the catalogue references a seller not in the directory (which the
 * `marketMode.test.ts` "every product references a known seller" invariant
 * forbids, so this is total in practice).
 */
export function sellerOf(product: MarketProduct): MarketVendor | undefined {
  return product.listing?.vendor ?? MARKET_VENDORS.find((v) => v.name === product.sellerName);
}
