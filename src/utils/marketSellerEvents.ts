// Seller-side event building + parsing for the Market (#1273). PURE — no
// React, no I/O — so every byte we sign is unit-tested.
//
// Format: the Gamma Markets spec (NIP-99 based,
// https://github.com/GammaMarkets/market-spec), the same events the Market
// reader (`marketListings.ts`) and the buyer checkout (`marketShipping.ts`,
// `orderEvents.ts`) already consume, and what Robotechy and Eden Weeks
// publish in the wild:
//
//   kind 30402  product listing   d, title, price, type, visibility, stock,
//                                 image × n, t × n, shipping_option × n,
//                                 a → selected product collections, published_at
//   kind 30406  shipping option   one per zone: d, title, price, country,
//                                 service
//   kind 30405  collection        product groups: title, summary, image, a →
//                                 products, optional shipping_option → shared zones
//   kind 5      NIP-09 deletion   a + e + k
//
// Edits republish the addressable event under the SAME `d`, and keep any tag
// we don't manage (summary, spec, weight, another client's extensions …) so
// editing a listing made in another Gamma client doesn't strip its data.
import type { Event } from 'nostr-tools';
import { CURRENCIES } from '../services/fiatService';
import { isKnownCountry } from '../data/countries';
import { normalizeCurrencyCode } from './currencyCode';
import { SHIPPING_OPTION_KIND, type ShippingOption } from './marketShipping';

export const LISTING_KIND = 30402;
export const COLLECTION_KIND = 30405;
export const DELETION_KIND = 5;
export { SHIPPING_OPTION_KIND };

/** Legacy identifier: only used to detect and delete pre-1376 shop events. */
export const SHOP_COLLECTION_D = 'lightning-piggy-shop';
/** Currencies a seller may price in: sats first, then the app's fiat list. */
export const SELLER_CURRENCIES: readonly string[] = ['SATS', ...CURRENCIES, 'BTC'];

/** Upper-case a currency, folding the `SAT` spelling into `SATS`. */
export const normaliseCurrency = normalizeCurrencyCode;
export const MAX_LISTING_IMAGES = 8;
export const MAX_LISTING_CATEGORIES = 10;
export const MAX_SHIPPING_ZONES = 10;

export interface EventTemplate {
  kind: number;
  content: string;
  tags: string[][];
}

/** App-side defaults; the merchant identity lives in kind 0. */
export interface ShopDraft {
  /** Default currency for new listings and new shipping options. */
  currency: string;
}

/** One shipping zone (a 30406 option). New zones start in the shop
 * currency; an existing zone keeps its own (a shop can price UK shipping in
 * GBP and US shipping in USD). */
export interface ShippingZoneDraft {
  dTag: string;
  name: string;
  /** ISO 3166-1 alpha-2 codes; EMPTY = worldwide. */
  countries: string[];
  /** Decimal string, e.g. "3.50". */
  cost: string;
  currency: string;
}

/** A listing's link to one shipping option plus its per-product surcharge. */
export interface ListingShippingDraft {
  coordinate: string;
  /** Decimal string in the LISTING's currency (spec), '' = no surcharge. */
  extraCost: string;
}

export interface ListingDraft {
  dTag: string;
  title: string;
  description: string;
  images: string[];
  price: string;
  currency: string;
  /** Integer string; '' = stock not tracked. */
  quantity: string;
  categories: string[];
  shipping: ListingShippingDraft[];
  collections?: string[];
  /** Gamma `type` format (3rd element). A digital item never ships. Unset =
   * derived from shipping, as before the editor exposed it. */
  format?: 'physical' | 'digital';
}

export type SellerDraftError =
  | 'title'
  | 'price'
  | 'currency'
  | 'quantity'
  | 'images'
  | 'categories'
  | 'shipping'
  | 'shopName'
  | 'zones'
  | 'zoneName'
  | 'zoneCost'
  | 'zoneCountries';

const tagValue = (tags: readonly string[][], name: string) => tags.find((t) => t[0] === name)?.[1];

/** Fresh addressable identifier, e.g. `item-m1x2y3-k9f2ab`. */
export function newIdentifier(
  prefix: string,
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const suffix = random().toString(36).slice(2, 8).padEnd(6, '0');
  return `${prefix}-${now.toString(36)}-${suffix}`;
}

/**
 * A user-typed amount as the spec's decimal string ("10.99"), or null when it
 * isn't one. Accepts a comma decimal separator (most of Europe types "3,50").
 * Sats must be whole.
 */
export function normaliseAmount(raw: string, currency: string): string | null {
  const value = raw.trim().replace(',', '.');
  if (!/^\d{1,12}(\.\d{1,8})?$/.test(value)) return null;
  const isSats = ['SATS', 'SAT'].includes(currency.toUpperCase());
  if (isSats && value.includes('.')) return null;
  // Drop redundant leading zeros ("007" → "7") but keep "0.50".
  return value.replace(/^0+(?=\d)/, '');
}

/** Normalise categories: trimmed, lower-case, de-duplicated, no '#'. */
export function normaliseCategories(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of raw) {
    const value = entry.trim().replace(/^#+/, '').toLowerCase();
    if (value && value.length <= 40 && !out.includes(value)) out.push(value);
  }
  return out;
}

/** Split a comma / newline separated categories field. */
export function splitCategories(text: string): string[] {
  return normaliseCategories(text.split(/[,\n]/));
}

export function validateListingDraft(draft: ListingDraft): SellerDraftError[] {
  const errors: SellerDraftError[] = [];
  const title = draft.title.trim();
  if (!title || title.length > 200) errors.push('title');
  if (!SELLER_CURRENCIES.includes(normaliseCurrency(draft.currency))) errors.push('currency');
  else if (normaliseAmount(draft.price, draft.currency) === null) errors.push('price');
  const quantity = draft.quantity.trim();
  if (quantity && (!/^\d{1,9}$/.test(quantity) || Number(quantity) > 1e9)) errors.push('quantity');
  if (draft.images.length > MAX_LISTING_IMAGES || draft.images.some((u) => !isHttpsUrl(u)))
    errors.push('images');
  if (draft.categories.length > MAX_LISTING_CATEGORIES) errors.push('categories');
  if (
    (draft.collections?.length ?? 0) > 100 ||
    draft.collections?.some((c) => !/^30405:[0-9a-f]{64}:.+$/.test(c))
  )
    errors.push('categories');
  // Digital events omit shipping; retained physical values are hidden in the editor.
  if (
    draft.format !== 'digital' &&
    draft.shipping.some(
      (s) =>
        !/^3040[56]:[0-9a-f]{64}:.+/.test(s.coordinate) ||
        (s.extraCost.trim() !== '' && normaliseAmount(s.extraCost, draft.currency) === null),
    )
  )
    errors.push('shipping');
  return errors;
}

export function validateShop(
  shop: ShopDraft,
  zones: readonly ShippingZoneDraft[],
): SellerDraftError[] {
  const errors: SellerDraftError[] = [];
  if (!SELLER_CURRENCIES.includes(normaliseCurrency(shop.currency))) errors.push('currency');
  if (zones.length > MAX_SHIPPING_ZONES) errors.push('zones');
  const perZone = new Set(zones.flatMap(validateZone));
  for (const error of ['zoneName', 'zoneCost', 'zoneCountries'] as const)
    if (perZone.has(error)) errors.push(error);
  return errors;
}

/** One zone's errors: the same checks `validateShop` runs, so the editor can
 * point at the exact card Save rejected. */
export function validateZone(zone: ShippingZoneDraft): SellerDraftError[] {
  const errors: SellerDraftError[] = [];
  if (!zone.name.trim() || zone.name.trim().length > 100) errors.push('zoneName');
  if (
    !SELLER_CURRENCIES.includes(normaliseCurrency(zone.currency)) ||
    normaliseAmount(zone.cost, zone.currency) === null
  )
    errors.push('zoneCost');
  if (zone.countries.some((c) => !isKnownCountry(c))) errors.push('zoneCountries');
  return errors;
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/** created_at for a revision: never at or before the one it replaces, so a
 * quick second edit can't lose the replaceable-event tie-break. */
export function nextCreatedAt(nowSeconds: number, previous?: Pick<Event, 'created_at'> | null) {
  const now = Math.floor(nowSeconds);
  return previous ? Math.max(now, previous.created_at + 1) : now;
}

/** Keep the previous revision's tags we don't manage. */
function preservedTags(previous: Event | null | undefined, managed: (tag: string[]) => boolean) {
  return previous ? previous.tags.filter((t) => !managed(t)).map((t) => [...t]) : [];
}

export const coordinateOf = (kind: number, pubkey: string, dTag: string) =>
  `${kind}:${pubkey}:${dTag}`;

export const shopCoordinate = (pubkey: string) =>
  coordinateOf(COLLECTION_KIND, pubkey, SHOP_COLLECTION_D);

/** kind-30406 shipping option for one zone. Worldwide (no countries) omits
 * the `country` tag — the Market reader treats an absent tag as worldwide and
 * rejects an empty one. */
export function buildShippingZoneTemplate(
  zone: ShippingZoneDraft,
  previous?: Event | null,
): EventTemplate {
  const currency = normaliseCurrency(zone.currency);
  const cost = normaliseAmount(zone.cost, currency);
  if (cost === null) throw new Error('Invalid shipping cost');
  const countries = [...new Set(zone.countries.map((c) => c.trim().toUpperCase()))].filter(Boolean);
  const tags: string[][] = [
    ['d', zone.dTag],
    ['title', zone.name.trim()],
    ['price', cost, currency],
  ];
  if (countries.length > 0) tags.push(['country', ...countries]);
  const service = tagValue(previous?.tags ?? [], 'service') ?? 'standard';
  tags.push(['service', service]);
  const managed = new Set(['d', 'title', 'price', 'country', 'service']);
  tags.push(...preservedTags(previous, (t) => managed.has(t[0])));
  return { kind: SHIPPING_OPTION_KIND, content: previous?.content ?? '', tags };
}

/** kind-30402 product listing. */
export function buildListingTemplate(input: {
  draft: ListingDraft;
  pubkey: string;
  nowSeconds: number;
  previous?: Event | null;
}): EventTemplate {
  const { draft, previous } = input;
  const currency = normaliseCurrency(draft.currency);
  const price = normaliseAmount(draft.price, currency);
  if (price === null) throw new Error('Invalid price');
  const prevTags = previous?.tags ?? [];
  const prevType = prevTags.find((t) => t[0] === 'type');
  const prevFrequency = prevTags.find((t) => t[0] === 'price')?.[3];

  const shipping =
    draft.format === 'digital'
      ? []
      : draft.shipping.filter(
          (s, i, all) => all.findIndex((o) => o.coordinate === s.coordinate) === i,
        );
  const tags: string[][] = [
    ['d', draft.dTag],
    ['title', draft.title.trim()],
    // Keep a subscription interval (4th element) the editor doesn't expose.
    prevFrequency ? ['price', price, currency, prevFrequency] : ['price', price, currency],
    [
      'type',
      prevType?.[1] || 'simple',
      // The editor's explicit choice wins. Otherwise shipping implies
      // physical, else keep the published format (a physical item can be
      // collect-in-person), defaulting to digital.
      draft.format ?? (shipping.length > 0 ? 'physical' : prevType?.[2] || 'digital'),
    ],
    ['visibility', tagValue(prevTags, 'visibility') || 'on-sale'],
  ];
  const quantity = draft.quantity.trim();
  if (quantity) tags.push(['stock', String(Number(quantity))]);
  // Keep the dimensions another client published for an image we still use.
  const dims = new Map(
    prevTags.filter((t) => t[0] === 'image' && t[1]).map((t) => [t[1], t[2] ?? '']),
  );
  draft.images.forEach((url, i) => tags.push(['image', url, dims.get(url) ?? '', String(i)]));
  for (const category of normaliseCategories(draft.categories)) tags.push(['t', category]);
  for (const s of shipping) {
    const extra = s.extraCost.trim() ? normaliseAmount(s.extraCost, currency) : null;
    tags.push(
      extra && Number(extra) > 0
        ? ['shipping_option', s.coordinate, extra]
        : ['shipping_option', s.coordinate],
    );
  }
  // An identifier alone cannot prove this is a legacy shop. Honour the
  // explicit selection; verified legacy cleanup belongs to migration.
  for (const collection of new Set(draft.collections ?? [])) tags.push(['a', collection]);
  tags.push(['published_at', tagValue(prevTags, 'published_at') ?? String(input.nowSeconds)]);
  const managed = new Set([
    'd',
    'title',
    'price',
    'type',
    'visibility',
    'stock',
    'image',
    't',
    'shipping_option',
    'published_at',
  ]);
  tags.push(
    ...preservedTags(
      previous,
      (t) => managed.has(t[0]) || (t[0] === 'a' && t[1]?.startsWith('30405:')),
    ),
  );
  return { kind: LISTING_KIND, content: draft.description.trim(), tags };
}

/** A published listing back into the editor's draft. */
export function parseListingDraft(event: Pick<Event, 'tags' | 'content'>): ListingDraft {
  const images = event.tags
    .filter((t) => t[0] === 'image' && typeof t[1] === 'string' && t[1])
    .map((t, index) => ({
      url: t[1],
      order:
        Number.isFinite(Number(t[3])) && t[3] !== '' && t[3] !== undefined ? Number(t[3]) : index,
    }))
    .sort((a, b) => a.order - b.order)
    .map((i) => i.url);
  const price = event.tags.find((t) => t[0] === 'price');
  const shipping = event.tags
    .filter((t) => t[0] === 'shipping_option' && typeof t[1] === 'string')
    .map((t) => ({ coordinate: t[1], extraCost: t[2] ?? '' }));
  const typeFormat = event.tags.find((t) => t[0] === 'type')?.[2];
  return {
    dTag: tagValue(event.tags, 'd') ?? '',
    title: tagValue(event.tags, 'title') ?? '',
    description: event.content,
    images: [...new Set(images)],
    price: price?.[1] ?? '',
    currency: normaliseCurrency(price?.[2] ?? 'SATS'),
    quantity: tagValue(event.tags, 'stock') ?? '',
    categories: normaliseCategories(event.tags.filter((t) => t[0] === 't').map((t) => t[1] ?? '')),
    collections: event.tags
      .filter((t) => t[0] === 'a' && /^30405:[0-9a-f]{64}:.+/.test(t[1] ?? ''))
      .map((t) => t[1]),
    shipping,
    format:
      typeFormat === 'digital' || typeFormat === 'physical'
        ? typeFormat
        : shipping.length > 0
          ? 'physical'
          : 'digital',
  };
}

export function zoneDraftFromOption(option: ShippingOption): ShippingZoneDraft {
  return {
    dTag: option.dTag,
    name: option.title,
    countries: [...option.countries],
    cost: String(option.baseAmount),
    currency: normaliseCurrency(option.currency),
  };
}

/** NIP-09 deletion for addressable events: `a` (every revision), `e` (the
 * exact revision, for relays that only index ids) and `k`. */
export function buildDeletionTemplate(
  targets: readonly { kind: number; coordinate: string; eventId?: string }[],
): EventTemplate {
  const tags: string[][] = [];
  for (const target of targets) {
    tags.push(['a', target.coordinate]);
    if (target.eventId) tags.push(['e', target.eventId]);
  }
  for (const kind of new Set(targets.map((t) => t.kind))) tags.push(['k', String(kind)]);
  return { kind: DELETION_KIND, content: '', tags };
}

/** Quick-pick regions for a shipping zone (ISO 3166-1 alpha-2). */
export const SHIPPING_REGION_PRESETS = {
  worldwide: [] as string[],
  uk: ['GB'],
  // The 27 EU member states.
  eu: [
    'AT',
    'BE',
    'BG',
    'HR',
    'CY',
    'CZ',
    'DK',
    'EE',
    'FI',
    'FR',
    'DE',
    'GR',
    'HU',
    'IE',
    'IT',
    'LV',
    'LT',
    'LU',
    'MT',
    'NL',
    'PL',
    'PT',
    'RO',
    'SK',
    'SI',
    'ES',
    'SE',
  ],
  northAmerica: ['US', 'CA'],
} as const;

export type ShippingRegionPreset = keyof typeof SHIPPING_REGION_PRESETS;
