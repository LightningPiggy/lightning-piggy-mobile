import { merchantId } from './marketMerchants';
import { normalizeCurrencyCode } from './currencyCode';
// Pure search/filter helpers for the Market product list. Kept out of the
// screens and components so the matching + option-derivation logic is
// independently unit-testable (coverage scope: src/utils). No React, no I/O.
//
// The Market screen composes four client-side filters over the visible
// products:
//   • search   — case-insensitive substring over title / description / seller
//   • merchant — the listing author's pubkey (curated fallback: vendor name)
//   • ships to — a destination country, matched against the seller's
//                published kind-30406 shipping options (utils/marketShipsTo)
//   • currency — the listing's currency, else derived from the product's
//                `priceFiatLabel` (e.g. "£60"); normalised so SAT/sats/SATS
//                are one option
//
// Option lists (merchants, ships-to countries, currencies) are DERIVED FROM
// THE LOADED DATA, not hardcoded, so they stay correct as listings change.
import type { MarketProduct } from '../data/marketProducts';
import type { MarketVendor } from '../data/marketVendors';
import { DEFAULT_MARKET_MODE, type MarketMode } from './marketMode';
import { shipsToMatches, type ShipsTo } from './marketShipsTo';

/** Resolve the vendor a product is sold by. Injected (rather than importing
 * `sellerOf` directly) so these helpers stay free of the data module and are
 * trivially testable with a stub directory. */
export type ResolveVendor = (product: MarketProduct) => MarketVendor | undefined;

/** Where a product ships to (see `productShipsTo`); injected like the vendor
 * resolver so filtering stays pure. */
export type ResolveShipsTo = (product: MarketProduct) => ShipsTo;

/** The four composable Market filters. A `null` merchant/shipsTo/currency
 * means "no filter on that axis" (All / Anywhere); an empty/whitespace query
 * means "no search filter". */
export interface MarketFilter {
  query: string;
  merchant: string | null;
  /** Destination country (ISO 3166-1 alpha-2), or null for Anywhere. */
  shipsTo: string | null;
  /** With a destination set, keep listings whose shipping is unknown. */
  includeUnknownShipping: boolean;
  currency: string | null;
}

/** A cleared filter — empty search, no merchant, ships anywhere, no currency. */
export const EMPTY_MARKET_FILTER: MarketFilter = {
  query: '',
  merchant: null,
  shipsTo: null,
  includeUnknownShipping: true,
  currency: null,
};

/** Whether any axis of the filter is active (drives the "Clear" affordance). */
export function isMarketFilterActive(filter: MarketFilter): boolean {
  return (
    filter.query.trim().length > 0 ||
    filter.merchant !== null ||
    filter.shipsTo !== null ||
    filter.currency !== null
  );
}

/**
 * Whether the seller scope narrows the catalogue. Every scope short of All
 * (`wotAll`: listings from anyone, no author filter — experimental) is a
 * subset of what a shopper could see — including the default Lightning Piggy
 * preferred sellers — so it counts as an applied filter on the header button.
 * All is the unfiltered view, so it alone leaves the button without a badge.
 */
export function isMarketScopeNarrowing(mode: MarketMode): boolean {
  return mode !== 'wotAll';
}

/**
 * Count of active panel filter axes (seller scope / merchant / ships to /
 * currency) — the axes housed in the slide-in filter panel. Drives the active
 * state + count badge on the Market header's filter icon so the user can see
 * how many hidden filters narrow the list without opening the panel. The
 * seller scope counts whenever it narrows (see `isMarketScopeNarrowing`), so
 * the default preferred-sellers view shows as filtered. The search query is
 * intentionally EXCLUDED: it has its own always-visible inline field.
 */
export function countActiveMarketFilters(filter: MarketFilter, mode: MarketMode): number {
  let n = isMarketScopeNarrowing(mode) ? 1 : 0;
  if (filter.merchant !== null) n += 1;
  if (filter.shipsTo !== null) n += 1;
  if (filter.currency !== null) n += 1;
  return n;
}

/**
 * Whether any panel axis differs from its default (drives the panel's "Clear
 * filters" action). Distinct from `countActiveMarketFilters`: the default
 * seller scope narrows the list, but Clear can't reset it any further, so it
 * alone doesn't make Clear appear.
 */
export function canClearMarketFilters(filter: MarketFilter, mode: MarketMode): boolean {
  return (
    mode !== DEFAULT_MARKET_MODE ||
    filter.merchant !== null ||
    filter.shipsTo !== null ||
    !filter.includeUnknownShipping ||
    filter.currency !== null
  );
}

// Fiat currency-symbol → ISO 4217 code. The curated catalogue authors prices
// as a short fiat label (e.g. "£60", "$25", "€40"); a future live feed (NIP-99
// classifieds carry a `price` tag with an explicit ISO code) would supply the
// code directly.
const SYMBOL_TO_CURRENCY: Record<string, string> = {
  '£': 'GBP',
  $: 'USD',
  '€': 'EUR',
  '¥': 'JPY',
  '₿': 'BTC',
};

// Letter prefixes that turn `$` into a non-US dollar ("A$30", "CA$25",
// "HK$100"). A `$` preceded by any OTHER letters is ambiguous → no currency.
const DOLLAR_PREFIX_TO_CURRENCY: Record<string, string> = {
  US: 'USD',
  A: 'AUD',
  AU: 'AUD',
  C: 'CAD',
  CA: 'CAD',
  HK: 'HKD',
  NZ: 'NZD',
  S: 'SGD',
  SG: 'SGD',
  MX: 'MXN',
  R: 'BRL',
};

// ISO codes accepted in the bare-code form. A closed list, so any other
// three-letter word ("Ask", "TBC", "POA", "Sat 500") isn't read as a currency.
const KNOWN_CURRENCY_CODES = new Set([
  'AUD',
  'BRL',
  'BTC',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'INR',
  'JPY',
  'MXN',
  'NOK',
  'NZD',
  'PLN',
  'SEK',
  'SGD',
  'USD',
  'ZAR',
]);

/**
 * Derive an ISO-4217-ish currency code from a product's `priceFiatLabel`.
 * In order of precedence:
 *   1. a leading known ISO code ("GBP 60", "usd25", "CAD $25", "CNY ¥50");
 *   2. the EARLIEST fiat symbol in the label (so "$25 (≈ €23)" is USD), where
 *      a `$` directly after letters must be a known prefixed dollar ("A$30"
 *      → AUD) — unknown prefixes are ambiguous and yield `null`.
 * Returns `null` when no currency can be read unambiguously (so such a
 * product is excluded from currency option lists rather than bucketed under a
 * wrong code). Pure + total — never throws.
 */
export function currencyOf(priceFiatLabel: string | null | undefined): string | null {
  if (typeof priceFiatLabel !== 'string') return null;
  const label = priceFiatLabel.trim();
  if (label.length === 0) return null;
  // Bare ISO-code form — exactly three leading letters not run into a longer
  // word (so "free" / "Bitcoin" don't match), from the known list only.
  const codeMatch = label.match(/^([A-Za-z]{3})(?![A-Za-z])/);
  if (codeMatch) {
    const code = codeMatch[1]!.toUpperCase();
    if (KNOWN_CURRENCY_CODES.has(code)) return code;
  }
  // Symbol form, e.g. "£60", "$4.50" — whichever symbol appears first.
  let earliest = -1;
  let symbol: string | null = null;
  for (const sym of Object.keys(SYMBOL_TO_CURRENCY)) {
    const index = label.indexOf(sym);
    if (index !== -1 && (earliest === -1 || index < earliest)) {
      earliest = index;
      symbol = sym;
    }
  }
  if (symbol === null) return null;
  if (symbol === '$') {
    const prefix = label.slice(0, earliest).match(/([A-Za-z]+)$/)?.[1];
    if (prefix) return DOLLAR_PREFIX_TO_CURRENCY[prefix.toUpperCase()] ?? null;
  }
  return SYMBOL_TO_CURRENCY[symbol]!;
}

/** Stable merchant key: listing pubkey, or curated fallback vendor name. */
export function productMerchant(
  product: MarketProduct,
  resolveVendor: ResolveVendor,
): string | null {
  const vendor = resolveVendor(product);
  return product.listing ? merchantId(product) : vendor ? vendor.name : null;
}

/**
 * Case-insensitive substring search across a product's title, description, and
 * its seller's display name (the fields a shopper would type). An empty or
 * whitespace-only query matches everything. Pure — no allocation beyond the
 * lower-cased haystack.
 */
export function productMatchesSearch(
  product: MarketProduct,
  resolveVendor: ResolveVendor,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const vendor = resolveVendor(product);
  const haystack = [product.title, product.description, product.sellerName, vendor?.name ?? '']
    // NUL separator (written as an escape so the source stays plain text): a
    // typed query can't contain it, so a match never spans two fields.
    .join('\u0000')
    .toLowerCase();
  return haystack.includes(q);
}

/** Distinct merchant (vendor) names present in the products, sorted
 * alphabetically. Drives the merchant filter chips (derived from data, not
 * hardcoded). */
export function distinctMerchants(
  products: readonly MarketProduct[],
  resolveVendor: ResolveVendor,
): string[] {
  const set = new Set<string>();
  for (const p of products) {
    const merchant = productMerchant(p, resolveVendor);
    if (merchant) set.add(merchant);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** A product's canonical currency code — the listing's own currency, else
 * one read from its price label — or `null` when none can be read. Normalised
 * so every sats spelling (SAT / sats / SATS) buckets together. */
export function productCurrency(product: MarketProduct): string | null {
  const raw = product.listing?.currency ?? currencyOf(product.priceFiatLabel);
  return raw ? normalizeCurrencyCode(raw) : null;
}

/** Distinct canonical currencies present in the products, sorted
 * alphabetically. Drives the currency filter chips (derived from data, not
 * hardcoded). */
export function distinctCurrencies(products: readonly MarketProduct[]): string[] {
  const set = new Set<string>();
  for (const p of products) {
    const cur = productCurrency(p);
    if (cur) set.add(cur);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

/**
 * Apply the composed filter (search AND merchant AND ships-to AND currency) to
 * the product list. Each axis is independent and ANDs with the others; a `null`
 * merchant/shipsTo/currency or empty query disables that axis. Returns a new
 * array (a subset, original order preserved); never mutates the input.
 */
export function filterMarketProducts(
  products: readonly MarketProduct[],
  filter: MarketFilter,
  resolveVendor: ResolveVendor,
  resolveShipsTo: ResolveShipsTo,
): MarketProduct[] {
  const currency = filter.currency === null ? null : normalizeCurrencyCode(filter.currency);
  return products.filter((p) => {
    if (!productMatchesSearch(p, resolveVendor, filter.query)) return false;
    if (filter.merchant !== null && productMerchant(p, resolveVendor) !== filter.merchant) {
      return false;
    }
    if (
      filter.shipsTo !== null &&
      !shipsToMatches(resolveShipsTo(p), filter.shipsTo, filter.includeUnknownShipping)
    ) {
      return false;
    }
    if (currency !== null && productCurrency(p) !== currency) return false;
    return true;
  });
}
