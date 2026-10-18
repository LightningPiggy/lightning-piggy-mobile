import { sanitizeDisplayText } from './sanitizeDisplayText';
import { nip19, type Event } from 'nostr-tools';
import type { MarketProduct } from '../data/marketProducts';
import type { MarketVendor } from '../data/marketVendors';
import { isPublicHttpUrl } from './publicUrl';

export interface MarketListing {
  event: Event;
  currency: string;
  priceLabel: string;
  /** Numeric price in `currency` units (the parsed `price` tag / field).
   * Optional so hand-built fixtures without it still type-check; display
   * code falls back to `priceLabel` when it's absent. */
  amount?: number;
  /** Billing-period suffix such as `/month`, or `''` for one-off prices. */
  recurrence?: string;
  vendor: MarketVendor;
  /**
   * Relays that served this listing (any revision) in the snapshot that last
   * fetched it. A refresh keeps the listing while none of them answers, and
   * drops it once one answers without it (see `mergeMarketSnapshot`).
   */
  seenOn?: string[];
}

/** Authors a reduction accepts: a Set, or `{ has: () => true }` for everyone
 * (the Market's All scope). Only membership is ever asked. */
export type AuthorScope = Pick<ReadonlySet<string>, 'has'>;

/** Stable product id of a listing address (`kind` + author + `d`). */
export function marketListingProductId(kind: number, pubkey: string, d: string): string {
  return `nostr-${kind}-${pubkey}-${encodeURIComponent(d)}`;
}

const tag = (event: Event, name: string) => event.tags.find((t) => t[0] === name)?.[1];

export function safeMarketUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    // Listing URLs are other people's data that the app loads automatically
    // (product images), so they must also be public addresses (#1338).
    return url.protocol === 'https:' && !url.username && !url.password && isPublicHttpUrl(url.href)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Most images a listing's gallery keeps — plenty for a product page. */
const MAX_LISTING_IMAGES = 20;

/**
 * A listing's images in the seller's order: each passed through
 * {@link safeMarketUrl} (unsafe ones dropped, never replaced), de-duplicated,
 * capped at {@link MAX_LISTING_IMAGES}.
 */
export function safeMarketImages(values: readonly unknown[]): string[] {
  const images: string[] = [];
  for (const value of values) {
    const url = safeMarketUrl(value);
    if (url && !images.includes(url)) images.push(url);
    if (images.length >= MAX_LISTING_IMAGES) break;
  }
  return images;
}

/** Parse only supported, active listings; retain the signed event's actual identity. */
export function parseMarketListing(event: Event, now = Date.now() / 1000): MarketProduct | null {
  if (![30018, 30402].includes(event.kind) || event.content.length > 32768) return null;
  const d = tag(event, 'd');
  // NIP-19 TLV lengths are one byte, so naddr can't encode an identifier over
  // 255 UTF-8 bytes — reject it rather than build a broken "Open listing" link.
  if (!d || new TextEncoder().encode(d).length > 255 || event.tags.length > 256) return null;
  // A lone surrogate makes encodeURIComponent (used for the product id) throw,
  // which would abort the whole snapshot — drop just this listing.
  try {
    encodeURIComponent(d);
  } catch {
    return null;
  }
  const expiry = tag(event, 'expiration');
  if (expiry && (!Number.isFinite(Number(expiry)) || Number(expiry) <= now)) return null;
  let title: unknown;
  let description: unknown;
  let amount: unknown;
  let unit: unknown;
  let rawImages: readonly unknown[] = [];
  let frequency: unknown;
  if (event.kind === 30018) {
    try {
      const p = JSON.parse(event.content);
      if (
        !p ||
        p.id !== d ||
        (p.quantity !== null && (!Number.isInteger(p.quantity) || p.quantity <= 0))
      )
        return null;
      title = p.name;
      description = p.description;
      amount = p.price;
      unit = p.currency;
      rawImages = Array.isArray(p.images) ? p.images : [];
    } catch {
      return null;
    }
  } else {
    const status = tag(event, 'status');
    if (status && status !== 'active') return null;
    // Gamma Markets: `visibility` hidden = not for display (default on-sale).
    if (tag(event, 'visibility') === 'hidden') return null;
    const price = event.tags.find((t) => t[0] === 'price');
    title = tag(event, 'title');
    description = event.content;
    amount = price?.[1];
    unit = price?.[2];
    frequency = price?.[3];
    // NIP-99 / Gamma: one `["image", url, dimensions?]` tag per image.
    rawImages = event.tags.filter((t) => t[0] === 'image').map((t) => t[1]);
  }
  if (typeof title !== 'string' || !title.trim() || title.length > 200) return null;
  if (typeof unit !== 'string' || !/^[a-zA-Z]{3,8}$/.test(unit)) return null;
  if ((typeof amount !== 'string' && typeof amount !== 'number') || String(amount).trim() === '')
    return null;
  const price = Number(amount);
  if (!Number.isFinite(price) || price < 0 || price > 1e12) return null;
  const currency = unit.toUpperCase();
  const isSats = ['SAT', 'SATS'].includes(currency);
  const sats = isSats ? price : currency === 'BTC' ? price * 1e8 : 0;
  if (
    (isSats || currency === 'BTC') &&
    (!Number.isSafeInteger(Math.round(sats)) || Math.abs(sats - Math.round(sats)) > 1e-6)
  )
    return null;
  const recurrence =
    typeof frequency === 'string' && /^[a-z]{1,16}$/.test(frequency) ? `/${frequency}` : '';
  const priceLabel = `${String(amount)} ${currency}${recurrence}`;
  const address = nip19.naddrEncode({ identifier: d, pubkey: event.pubkey, kind: event.kind });
  const url = safeMarketUrl(tag(event, 'r')) ?? `https://njump.me/${address}`;
  // Placeholder until a profile name resolves: a short npub, never raw hex.
  const npub = nip19.npubEncode(event.pubkey);
  const sellerName = `${npub.slice(0, 12)}…${npub.slice(-4)}`;
  const images = safeMarketImages(rawImages);
  const vendor: MarketVendor = {
    name: sellerName,
    country: '',
    shippingRegions: [],
    shopType: 'online',
    description: '',
    url,
    logo: '',
    nostrUrl: `https://njump.me/${npub}`,
    xUrl: '',
    featured: false,
  };
  return {
    id: marketListingProductId(event.kind, event.pubkey, d),
    title: sanitizeDisplayText(title, { maxLen: 200 }),
    description: typeof description === 'string' ? description.slice(0, 12000) : '',
    priceSats: Math.round(sats),
    priceFiatLabel: priceLabel,
    image: images[0] ?? '',
    images,
    sellerName,
    url,
    featured: false,
    listing: { event, currency, priceLabel, amount: price, recurrence, vendor },
  };
}

/** Newest revision first; on a timestamp tie the lowest id wins. */
const newerFirst = (a: Event, b: Event) =>
  b.created_at - a.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `kind:pubkey:d` for a listing kind with a `d` tag, else null. */
function listingAddress(event: Event): string | null {
  if (![30018, 30402].includes(event.kind)) return null;
  const d = tag(event, 'd');
  return d ? `${event.kind}:${event.pubkey}:${d}` : null;
}

/** NIP-09: whether an author's own kind-5 withdrew this listing revision. */
function deletionIndex(
  events: readonly Event[],
  authors: AuthorScope,
): (event: Event, address: string) => boolean {
  const deletedIds = new Set<string>();
  const deletedAddresses = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== 5 || !authors.has(event.pubkey)) continue;
    for (const t of event.tags) {
      if (t[0] === 'e') deletedIds.add(`${event.pubkey}:${t[1]}`);
      if (t[0] === 'a' && t[1]?.split(':')[1] === event.pubkey) {
        deletedAddresses.set(t[1], Math.max(deletedAddresses.get(t[1]) ?? 0, event.created_at));
      }
    }
  }
  return (event, address) =>
    deletedIds.has(`${event.pubkey}:${event.id}`) ||
    (deletedAddresses.get(address) ?? -1) >= event.created_at;
}

/** Newest addressable revision wins, including sold/malformed revisions. */
export function reduceMarketListings(
  events: readonly Event[],
  authors: AuthorScope,
  now?: number,
): MarketProduct[] {
  const isDeleted = deletionIndex(events, authors);
  const latest = new Map<string, Event>();
  for (const event of events) {
    if (!authors.has(event.pubkey)) continue;
    const address = listingAddress(event);
    if (!address) continue;
    const previous = latest.get(address);
    if (!previous || newerFirst(event, previous) < 0) latest.set(address, event);
  }
  const products: MarketProduct[] = [];
  for (const [address, event] of latest) {
    if (isDeleted(event, address)) continue;
    const product = parseMarketListing(event, now);
    if (product) products.push(product);
  }
  return products.sort(
    (a, b) => b.listing!.event.created_at - a.listing!.event.created_at || a.id.localeCompare(b.id),
  );
}

interface Candidate {
  address: string;
  index: number;
  event: Event;
}

/** Binary heap of candidate revisions, newest first (`newerFirst` order). */
function createCandidateHeap() {
  const items: Candidate[] = [];
  const before = (a: number, b: number) => newerFirst(items[a].event, items[b].event) < 0;
  const swap = (a: number, b: number) => ([items[a], items[b]] = [items[b], items[a]]);
  return {
    push(candidate: Candidate) {
      items.push(candidate);
      for (let i = items.length - 1; i > 0; ) {
        const parent = (i - 1) >> 1;
        if (!before(i, parent)) break;
        swap(i, parent);
        i = parent;
      }
    },
    pop(): Candidate | undefined {
      if (items.length === 0) return undefined;
      const top = items[0];
      const last = items.pop()!;
      if (items.length > 0) {
        items[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          const r = l + 1;
          let best = i;
          if (l < items.length && before(l, best)) best = l;
          if (r < items.length && before(r, best)) best = r;
          if (best === i) break;
          swap(i, best);
          i = best;
        }
      }
      return top;
    },
  };
}

/**
 * Verify lazily: only the revision that would win each address, newest
 * listings first, and stop once `cap` renderable products are confirmed.
 *
 * A follow set's listings can run to ~1,200 events and a schnorr check costs
 * ~25 ms on a phone, so verifying everything up front pinned the JS thread
 * for tens of seconds (#1274). A revision that fails verification is skipped,
 * so a forged newer copy can't hide the real listing. Copies that share an id
 * but differ in signature are separate candidates: a bad-signature copy of a
 * genuine payload just falls through to the good one. Deletions (kind 5) are
 * passed through: the caller verifies those as they arrive (there are few).
 *
 * Returns the events to hand to `reduceMarketListings`, whether more
 * renderable listings existed beyond `cap`, and how many checks ran.
 * `firstPage` lets the caller paint the newest listings before the rest are
 * checked.
 */
export async function selectVerifiedListings(
  events: readonly Event[],
  authors: AuthorScope,
  opts: {
    verify: (event: Event) => boolean;
    maybeYield: () => Promise<void>;
    cap: number;
    now?: number;
    /**
     * Stop after this many failed checks. Every candidate passed an id-hash
     * check, so failures mean forged signatures — a hostile relay flooding
     * fakes must not buy unbounded verification work.
     */
    maxFailures?: number;
    /** Called once, as soon as `firstPage.size` renderable winners are verified. */
    firstPage?: { size: number; ready: (events: Event[]) => void };
  },
): Promise<{ events: Event[]; overflow: boolean; checked: number; gaveUp: boolean }> {
  const isDeleted = deletionIndex(events, authors);
  const deletions: Event[] = [];
  const revisions = new Map<string, Event[]>();
  for (const event of events) {
    if (!authors.has(event.pubkey)) continue;
    if (event.kind === 5) {
      deletions.push(event);
      continue;
    }
    const address = listingAddress(event);
    if (!address) continue;
    const list = revisions.get(address);
    if (list) list.push(event);
    else revisions.set(address, [event]);
  }
  for (const list of revisions.values()) list.sort(newerFirst);
  // Candidates are taken newest-first across ALL addresses. When a revision
  // fails verification, that address's next revision re-enters at ITS own
  // time — so a forged newer copy can't let an old fallback take a cap slot
  // ahead of genuinely newer listings.
  const heap = createCandidateHeap();
  for (const [address, list] of revisions) heap.push({ address, index: 0, event: list[0] });
  const winners: Event[] = [];
  let rendered = 0;
  let checked = 0;
  let overflow = false;
  let failures = 0;
  let gaveUp = false;
  for (let next = heap.pop(); next; next = heap.pop()) {
    await opts.maybeYield();
    checked++;
    if (!opts.verify(next.event)) {
      if (opts.maxFailures !== undefined && ++failures >= opts.maxFailures) {
        gaveUp = true;
        break;
      }
      const list = revisions.get(next.address)!;
      const index = next.index + 1;
      if (index < list.length) heap.push({ address: next.address, index, event: list[index] });
      continue;
    }
    const winner = next.event;
    if (!isDeleted(winner, next.address) && parseMarketListing(winner, opts.now)) {
      if (++rendered > opts.cap) {
        overflow = true;
        break;
      }
    }
    winners.push(winner);
    if (rendered === opts.firstPage?.size) {
      opts.firstPage.ready([...winners, ...deletions]);
      opts.firstPage = undefined;
    }
  }
  return { events: [...winners, ...deletions], overflow, checked, gaveUp };
}
