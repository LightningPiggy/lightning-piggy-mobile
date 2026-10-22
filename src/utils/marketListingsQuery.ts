import { enabledAppRelays } from '../services/appRelayPrefs';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
// Relay plan for the market snapshots (author-scoped, or the All scope). Pure (no I/O) so the
// bounding rules are unit-testable.
//
// Two passes keep the JS thread out of other people's history:
//   1. listings  — kinds 30018 / 30402 by followed authors only. Friends'
//                  kind-5 deletions are NOT requested here: in practice they
//                  are ~95 % of what a combined query returns (deletions of
//                  ordinary notes), each costs a schnorr verify, and they
//                  crowd real listings out of the per-batch `limit`.
//   2. deletions — kind 5 that reference the listings pass 1 actually found
//                  (`#a` address or `#e` id), by those listings' authors. A
//                  handful of events instead of hundreds, and it still honours
//                  deletions that lack the optional NIP-09 `k` tag.
import type { Event, Filter } from 'nostr-tools';

export const MARKET_LISTING_KINDS = [30018, 30402];

/**
 * Relays marketplace clients publish listings to, queried alongside the
 * user's own read relays. Followed sellers' listings often live ONLY here:
 * Plebeian Market writes to its own relay, and Robotechy's listing is on
 * nostr.mom, which isn't even in Robotechy's own kind-10002 list.
 */
export const MARKET_RELAYS = [
  'wss://relay.plebeian.market',
  'wss://relay.conduit.market',
  'wss://nostr.mom',
];

/** Authors per filter — relays reject very long `authors` arrays. */
export const AUTHOR_BATCH = 64;
/** Per-batch listing cap; a reply this long is flagged as possibly cut off. */
export const LISTING_LIMIT = 500;
/** Tag values per deletion filter, and that filter's result cap. */
export const DELETION_TAG_CHUNK = 100;
export const DELETION_LIMIT = 500;
/** Relays per snapshot (market relays + the user's read relays). */
export const MAX_SNAPSHOT_RELAYS = 8;

const normaliseRelay = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/**
 * Market relays first (they're where listings live), then the user's read
 * relays, de-duplicated and capped. `dropped` reports user relays that didn't
 * fit, so the caller can flag the snapshot as possibly incomplete.
 */
export function marketSnapshotRelays(userRelays: readonly string[]): {
  urls: string[];
  dropped: boolean;
} {
  if (isTestRelayLockdown(getCurrentUserPubkey()))
    return { urls: [TEST_RELAY_URL], dropped: false };
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of [...enabledAppRelays('market', MARKET_RELAYS), ...userRelays]) {
    const url = normaliseRelay(raw);
    if (!/^wss:\/\/[^/\s]+/.test(url) || seen.has(url)) continue;
    seen.add(url);
    all.push(url);
  }
  return { urls: all.slice(0, MAX_SNAPSHOT_RELAYS), dropped: all.length > MAX_SNAPSHOT_RELAYS };
}

/**
 * Per-relay cap for the All scope's author-less listing query. Sized so even
 * fully disjoint replies from every snapshot relay (8 × 150) fit the
 * service's 1,200-event listing budget — the sample never trips its
 * "budget exhausted" path.
 */
export const OPEN_LISTING_LIMIT = 150;
/** How far back the All scope looks for listings. */
export const OPEN_LISTING_WINDOW_DAYS = 90;

/** `since` (epoch seconds) for the All scope's window. */
export function openListingSince(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000) - OPEN_LISTING_WINDOW_DAYS * 24 * 60 * 60;
}

/**
 * All scope, pass 1: the newest listings from ANYONE — no `authors` — bounded
 * by `limit` and a `since` window. Pass 2 (deletions) is unchanged: it is
 * scoped to the authors of the listings this pass found.
 */
export function openListingFilters(since: number): Filter[] {
  return [{ kinds: MARKET_LISTING_KINDS, since, limit: OPEN_LISTING_LIMIT }];
}

/** Pass 1: listing kinds by followed authors, in bounded batches. */
export function listingFilters(authors: readonly string[]): Filter[] {
  const filters: Filter[] = [];
  for (let i = 0; i < authors.length; i += AUTHOR_BATCH) {
    filters.push({
      kinds: MARKET_LISTING_KINDS,
      authors: authors.slice(i, i + AUTHOR_BATCH),
      limit: LISTING_LIMIT,
    });
  }
  return filters;
}

function chunked(values: Map<string, string>, tag: '#a' | '#e', out: Filter[]): void {
  const entries = [...values];
  for (let i = 0; i < entries.length; i += DELETION_TAG_CHUNK) {
    const chunk = entries.slice(i, i + DELETION_TAG_CHUNK);
    const filter: Filter = {
      kinds: [5],
      authors: [...new Set(chunk.map(([, pubkey]) => pubkey))],
      limit: DELETION_LIMIT,
    };
    filter[tag] = chunk.map(([value]) => value);
    out.push(filter);
  }
}

/**
 * Pass 2: deletions that could withdraw one of the listings pass 1 found.
 * Only the listing's own author can delete it, so each filter is scoped to
 * the authors of the addresses / ids it asks about.
 */
export function deletionFilters(listings: readonly Event[]): Filter[] {
  const addresses = new Map<string, string>();
  const ids = new Map<string, string>();
  for (const event of listings) {
    if (!MARKET_LISTING_KINDS.includes(event.kind)) continue;
    ids.set(event.id, event.pubkey);
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    if (d) addresses.set(`${event.kind}:${event.pubkey}:${d}`, event.pubkey);
  }
  const filters: Filter[] = [];
  chunked(addresses, '#a', filters);
  chunked(ids, '#e', filters);
  return filters;
}
