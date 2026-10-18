import { enabledAppRelays } from './appRelayPrefs';
// Relay fetch for a merchant's kind-30406 shipping options (#948 Option A).
// Thin I/O shell over the PURE parsing/filtering in utils/marketShipping —
// query the merchant's addressable shipping-option events once per checkout
// open, newest-revision-per-d.
import type { Event, Filter } from 'nostr-tools';
import { pool, trackRelays, DEFAULT_RELAYS } from './nostrService';
import { acquireMarketListingsPool } from './marketListingsPool';
import { verifyEventCached } from './nostrVerifyCache';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { addressOf, addressRefs, deletedByAuthor, deletionFilters, idRefs } from '../utils/nip09';
import { querySyncAbortable } from './relayQuery';
import {
  SHIPPING_OPTION_KIND,
  dedupeNewestPerCoordinate,
  parseShippingOptionEvent,
  type ShippingOption,
} from '../utils/marketShipping';

// One relay round-trip is plenty for a checkout sheet — cap the wait so a
// dead relay can't hold the shipping section in a spinner.
const FETCH_MAX_WAIT_MS = 6000;

/**
 * Fetch the merchant's published shipping options. Queries the given read
 * relays unioned with the defaults (the merchant's options live wherever
 * they publish, which may not overlap the buyer's relay set), parses and
 * collapses to the newest revision per `d`. An unfinished relay query is an
 * error, never an empty shipping list. A completed empty query returns `[]`;
 * physical products still require an explicit shipping option in the hook.
 */
export async function fetchShippingOptions(input: {
  merchantPubkey: string;
  relays: string[];
  signal?: AbortSignal;
}): Promise<ShippingOption[]> {
  const relays = Array.from(
    new Set([...input.relays, ...enabledAppRelays('default', DEFAULT_RELAYS)]),
  );
  trackRelays(relays);
  const merchantPubkey = input.merchantPubkey.trim().toLowerCase();
  const events = await querySyncAbortable(
    pool,
    relays,
    { kinds: [SHIPPING_OPTION_KIND], authors: [merchantPubkey], limit: 100 },
    // An unreachable relay set must surface as an ERROR (retry row, submit
    // blocked), including a connected relay that never completes its response.
    {
      maxWait: FETCH_MAX_WAIT_MS,
      signal: input.signal,
      rejectOnAllRelaysFailure: true,
      rejectOnTimeout: true,
    },
  );
  // The `authors` filter is only a relay-side request; a misbehaving relay can
  // still hand back a valid-looking 30406 from another pubkey, whose price
  // would otherwise become a shipping charge on THIS merchant's order. Drop
  // anything not signed by the merchant before parsing.
  // Likewise `kinds` — an unrelated merchant event of another kind is simply
  // not a shipping option, not a malformed one.
  const shippingEvents = events.filter((ev) => ev.kind === SHIPPING_OPTION_KIND);
  const own = shippingEvents.filter((ev) => ev.pubkey.toLowerCase() === merchantPubkey);
  // A response that holds 30406s but NONE from the merchant isn't "the
  // merchant publishes no options" — it's a relay serving someone else's.
  // Fail closed rather than let it read as a digital-goods checkout.
  if (own.length === 0 && shippingEvents.length > 0) {
    throw new Error('Relay returned shipping options from another pubkey only');
  }
  // Invalid options must not turn into an empty list ("no shipping needed").
  const newest = new Map<string, (typeof own)[number]>();
  for (const event of own) {
    const d = event.tags.find((tag) => tag[0] === 'd')?.[1];
    if (!d) throw new Error('Merchant returned invalid shipping options');
    const previous = newest.get(d);
    if (
      !previous ||
      event.created_at > previous.created_at ||
      (event.created_at === previous.created_at && event.id < previous.id)
    )
      newest.set(d, event);
  }
  const parsed = [...newest.values()].map(parseShippingOptionEvent);
  if (parsed.some((option) => option === null)) {
    throw new Error('Merchant returned invalid shipping options');
  }
  return parsed as ShippingOption[];
}

// Bound each query's requested coordinates and response size. Sellers can
// share a filter only when they request exactly the same set of identifiers.
const COORDINATES_PER_QUERY = 100;
const AUTHORS_PER_QUERY = 20;
/** A display fetch must stay bounded even when sellers publish thousands of refs. */
export const MAX_DISPLAY_SHIPPING_REFERENCES = 200;
const MAX_CONCURRENT_DISPLAY_QUERIES = 4;

function displayReferences(coordinates: readonly string[]): Set<string> {
  const references = new Set<string>();
  for (const coordinate of coordinates) {
    if (!/^30406:[a-f0-9]{64}:.+$/.test(coordinate)) continue;
    references.add(coordinate);
    if (references.size === MAX_DISPLAY_SHIPPING_REFERENCES) break;
  }
  return references;
}

/** Drain each small group before starting more work, including on failure.
 * Both shipping and deletion lookups share this concurrency bound. */
async function queryDisplayFilters(
  queryPool: Parameters<typeof querySyncAbortable>[0],
  relays: string[],
  filters: Filter[],
  params: Parameters<typeof querySyncAbortable>[3],
): Promise<Event[]> {
  const events: Event[] = [];
  for (let i = 0; i < filters.length; i += MAX_CONCURRENT_DISPLAY_QUERIES) {
    if (params.signal?.aborted) return [];
    const results = await Promise.allSettled(
      filters
        .slice(i, i + MAX_CONCURRENT_DISPLAY_QUERIES)
        .map((filter) => querySyncAbortable(queryPool, relays, filter, params)),
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      events.push(...result.value);
    }
  }
  return events;
}

/** Filters for at most 200 references; authors × #d matches only requested coordinates. */
export function shippingOptionFilters(coordinates: readonly string[]): Filter[] {
  const byAuthor = new Map<string, string[]>();
  for (const coordinate of displayReferences(coordinates)) {
    const author = coordinate.slice(6, 70);
    const identifiers = byAuthor.get(author) ?? [];
    identifiers.push(coordinate.slice(71));
    byAuthor.set(author, identifiers);
  }
  const filters: Filter[] = [];
  const shared = new Map<string, Filter>();
  for (const [author, identifiers] of byAuthor) {
    identifiers.sort();
    for (let i = 0; i < identifiers.length; i += COORDINATES_PER_QUERY) {
      const dTags = identifiers.slice(i, i + COORDINATES_PER_QUERY);
      const key = JSON.stringify(dTags);
      let filter = shared.get(key);
      if (
        !filter ||
        filter.authors!.length >= AUTHORS_PER_QUERY ||
        (filter.authors!.length + 1) * dTags.length > COORDINATES_PER_QUERY
      ) {
        filter = { kinds: [SHIPPING_OPTION_KIND], authors: [], '#d': dTags, limit: 100 };
        filters.push(filter);
        shared.set(key, filter);
      }
      filter.authors!.push(author);
      // Allow a stale revision per coordinate without admitting cross-matches.
      filter.limit = Math.max(100, 2 * filter.authors!.length * dTags.length);
    }
  }
  return filters;
}

/**
 * Display-only fetch: whatever valid options exist at the given coordinates
 * within the deadline — one listing's for its product page (#1273), or a whole
 * Market page's for the Ships-to filter (batched by `shippingOptionFilters`,
 * cached in `marketShippingCache`). Unlike
 * {@link fetchShippingOptions} (which gates a checkout and so fails closed on
 * any timeout or malformed option), a slow relay or one bad option here just
 * drops out; only a relay set that entirely fails is an error.
 */
export async function fetchShippingOptionsForDisplay(input: {
  coordinates: readonly string[];
  relays: string[];
  signal?: AbortSignal;
}): Promise<ShippingOption[]> {
  const references = displayReferences(input.coordinates);
  if (references.size === 0) return [];
  const relays = Array.from(
    new Set([...input.relays, ...enabledAppRelays('default', DEFAULT_RELAYS)]),
  );
  trackRelays(relays);
  const params = {
    maxWait: FETCH_MAX_WAIT_MS,
    signal: input.signal,
    rejectOnAllRelaysFailure: true,
  };
  const events = (
    await queryDisplayFilters(pool, relays, shippingOptionFilters([...references]), params)
  ).filter(
    (event) => event.kind === SHIPPING_OPTION_KIND && references.has(addressOf(event) ?? ''),
  );
  if (input.signal?.aborted) return [];
  // The shared pool verifies signatures synchronously during delivery. Keep
  // deletion crypto in the budget-paced loop below instead.
  const lease = acquireMarketListingsPool(relays);
  let deletions: Event[];
  try {
    deletions = await queryDisplayFilters(
      lease.pool,
      relays,
      [...deletionFilters('a', addressRefs(events)), ...deletionFilters('e', idRefs(events))],
      params,
    );
  } finally {
    lease.release();
  }
  const scheduler = createYieldScheduler({ signal: input.signal, safetyEvery: 25 });
  const verifiedDeletions: Event[] = [];
  try {
    for (const event of deletions) {
      await scheduler.maybeYield();
      if (input.signal?.aborted) return [];
      // Ignore copied verification symbols supplied by a caller/relay.
      if (
        event.kind === 5 &&
        verifyEventCached({
          id: event.id,
          pubkey: event.pubkey,
          kind: event.kind,
          created_at: event.created_at,
          content: event.content,
          tags: event.tags,
          sig: event.sig,
        })
      )
        verifiedDeletions.push(event);
    }
  } finally {
    scheduler.dispose();
  }
  const deleted = deletedByAuthor(events, verifiedDeletions);
  const options = events
    .filter((event) => !deleted.has(event.id))
    .map(parseShippingOptionEvent)
    .filter((o): o is ShippingOption => o !== null);
  return dedupeNewestPerCoordinate(options);
}
