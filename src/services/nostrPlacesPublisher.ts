import { enabledAppRelays } from './appRelayPrefs';
import type { Event as NostrEvent, Filter, VerifiedEvent } from 'nostr-tools';
import { DEFAULT_RELAYS, pool, publishSignedEvent } from './nostrService';
import { GC_RELAYS } from './geocacheRelays';
import {
  GC_COMMENT_KIND,
  GC_FOUND_LOG_KIND,
  GC_LISTING_KIND,
  NIP52_TIME_BASED_KIND,
  parseCache,
  parseFoundLogEvent,
  parseNip52Event,
  type ParsedCache,
  type ParsedEvent,
  type ParsedFoundLog,
} from './nostrPlacesService';
import { isDevLeftover } from './devEventDenylist';
import { notifyOwnCachesChanged } from './ownCachesBus';

/** Structural shape of an event as returned by NostrContext.signEvent —
 * matches VerifiedEvent's data fields without the runtime brand symbol
 * nostr-tools attaches after `finalizeEvent`. publishSignedEvent
 * re-casts internally so the brand mismatch is harmless. */
export interface SignedEventLike {
  id: string;
  pubkey: string;
  sig: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Runtime-only side of NIP-GC publish/subscribe. Lives separately from
 * `nostrPlacesService.ts` (the pure builders / parsers / predicates) so
 * jest can transform the pure module without tripping over
 * `nostr-tools/pool`'s ESM-only entry. Production code reaches the
 * publisher through this module; tests only need the pure side.
 */

/**
 * Union the geo-cache backbone (`GC_RELAYS`) into whatever relays the
 * caller passes, deduped. Every NIP-GC publish/read goes through here so
 * mobile treasures always reach (and are read back from) exactly the
 * relays treasures.to uses — `nos.lol`, Damus, ditto.pub, dreamith.to —
 * even when the caller supplies the user's own NIP-65 / override relays
 * (which would otherwise *replace* the defaults and silently exclude the
 * Ditto search relays). Without GC_RELAYS the set degrades to whatever the
 * caller passed; with it the backbone is guaranteed. See #907.
 */
export const withGcRelays = (
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): string[] => [...new Set([...relays, ...enabledAppRelays('geocache', GC_RELAYS)])];

export const publishCacheEvent = async (
  signed: SignedEventLike,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): Promise<void> => {
  await publishSignedEvent(signed, withGcRelays(relays));
  // Every own-cache mutation (create / edit / expire / NIP-09 delete)
  // funnels through here — tell useCacheNotifications to re-arm its live
  // sub now instead of waiting for the safety-net poll (#1016).
  notifyOwnCachesChanged();
};

export interface NearbyCachesCompletion {
  allRelaysFailed: boolean;
}

/**
 * Subscribe to nearby caches by geohash prefix. `prefixes` should
 * come from `geohashPrefixes(currentGh, 5)` — yields a single filter
 * returning 37516 events whose `g` tag starts with any prefix (both
 * LP Piggies AND treasures.to / TapTheSatsMap caches; caller branches
 * on `parsed.isLpPiggy` to render the 🐷 vs 📍 pin distinction).
 *
 * `onEose` fires once after all queried relays reach EOSE/close, or after
 * eight seconds. Total closure without any event is a failure; a timeout
 * alone is inconclusive. Completion does not stop live event delivery.
 * Returns a closer that cancels pending completion and event delivery.
 */
export const subscribeNearbyCaches = (
  prefixes: string[],
  onEvent: (cache: ParsedCache) => void,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
  filterExtras: Partial<Filter> = {},
  onEose?: (result: NearbyCachesCompletion) => void,
): (() => void) => {
  if (prefixes.length === 0) {
    onEose?.({ allRelaysFailed: false });
    return () => {};
  }
  relays = withGcRelays(relays);
  const filter: Filter = {
    kinds: [GC_LISTING_KIND],
    '#g': prefixes,
    // Listings may be years old and still active; bound count rather than age.
    limit: 200,
    ...filterExtras,
  };
  // [PerfBlock] event-burst accounting — relay onevent fires
  // synchronously per arriving event; a burst of 50+ on screen mount
  // can pin the JS thread for seconds while each parseCache + the
  // caller's setCaches map-clone run back-to-back. We aggregate
  // cumulative wall-clock and log every 10 events so logcat shows
  // both the *count* and *cost* of the burst, then a final summary
  // 250 ms after the last event arrives (idle window). #554.
  let __burstCount = 0;
  let __burstMs = 0;
  let __burstFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const __flushBurst = (): void => {
    if (__burstCount === 0) return;
    console.log(
      `[PerfBlock] subscribeNearbyCaches burst: ${__burstCount} events in ${Math.round(__burstMs)}ms`,
    );
    __burstCount = 0;
    __burstMs = 0;
    __burstFlushTimer = null;
  };
  let cancelled = false;
  let completed = false;
  let receivedEvent = false;
  const complete = (allRelaysFailed: boolean): void => {
    if (cancelled || completed) return;
    completed = true;
    clearTimeout(completionTimer);
    onEose?.({ allRelaysFailed });
  };
  // Independent of the SDK's connection/EOSE timers: even a stalled relay
  // must not leave the rail loading forever. Keep the live sub for late data.
  const completionTimer = setTimeout(() => complete(false), 8000);
  const sub = pool.subscribeMany(relays, filter, {
    // SimplePool counts both EOSE and close towards this aggregate signal.
    // On total connection failure it calls oneose immediately BEFORE onclose.
    // Defer success one microtask so onclose can report failure first.
    oneose: () => {
      void Promise.resolve().then(() => complete(false));
    },
    onclose: () => complete(!receivedEvent),
    onevent: (e: NostrEvent) => {
      if (cancelled) return;
      receivedEvent = true;
      // Filter out orphaned dev-leftover signers (see devEventDenylist.ts)
      // before parsing — these are kind-37516 events from disposable nsecs
      // we no longer hold a key for, so they sit on relays forever.
      if (isDevLeftover(e.pubkey)) return;
      const __t0 = performance.now();
      const parsed = parseCache(e as VerifiedEvent);
      if (parsed) onEvent(parsed);
      const __dt = performance.now() - __t0;
      __burstMs += __dt;
      __burstCount += 1;
      // Log individual SLOW events synchronously — the setTimeout-based
      // summary below is useless when the JS thread is blocked (timers
      // queue but don't fire). >50 ms in a single onevent likely means
      // the setCaches reducer + downstream render is the hot path.
      if (__dt > 50) {
        console.log(
          `[PerfBlock] subscribeNearbyCaches SLOW event: ${Math.round(__dt)}ms (kind=${e.kind} d=${parsed?.d ?? '?'})`,
        );
      }
      if (__burstCount % 10 === 0) {
        console.log(
          `[PerfBlock] subscribeNearbyCaches: ${__burstCount} events, ${Math.round(__burstMs)}ms cumulative`,
        );
      }
      if (__burstFlushTimer) clearTimeout(__burstFlushTimer);
      __burstFlushTimer = setTimeout(__flushBurst, 250);
    },
  });
  return () => {
    cancelled = true;
    clearTimeout(completionTimer);
    if (__burstFlushTimer) clearTimeout(__burstFlushTimer);
    sub.close();
  };
};

// 30-day window used by the global "recent" subscriptions below. Chosen to
// match the community sections' freshness assumption (the "Recently added" rail
// and Finders leaderboard show activity that's still relevant to hunters) while
// bounding both relay-side scope (open-ended `{kinds, limit}` filters ask the
// relay to scan its entire event store) and the mount-time parse burst (a busy
// relay could return a 400-event backfill if no `since` is set). #1029 Fix 2.
const RECENT_SINCE_SECS = (): number => Math.floor(Date.now() / 1000) - 30 * 24 * 3600;

/**
 * Subscribe to the most-recently-published caches across the geo-cache
 * relay backbone — NOT geohash-scoped, so it surfaces global activity for
 * the "Recently added" rail and the Hiders leaderboard. `limit` bounds the
 * relay backfill (newest-first per NIP-01) so a busy relay can't firehose
 * years of history into the client. `since` further bounds the relay-side
 * scan to the last 30 days, capping the mount-time parse burst and keeping
 * the result set relevant. The same event stream feeds the hider ranking
 * (distinct caches per author), so callers only open one sub.
 *
 * Returns a closer; call it to terminate the subscription.
 */
export const subscribeRecentCaches = (
  onEvent: (cache: ParsedCache) => void,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
  limit = 200,
): (() => void) => {
  const filter: Filter = { kinds: [GC_LISTING_KIND], limit, since: RECENT_SINCE_SECS() };
  const sub = pool.subscribeMany(withGcRelays(relays), filter, {
    onevent: (e: NostrEvent) => {
      if (isDevLeftover(e.pubkey)) return;
      const parsed = parseCache(e as VerifiedEvent);
      if (parsed) onEvent(parsed);
    },
  });
  return () => sub.close();
};

/**
 * Subscribe to the most-recent found-logs across the geo-cache relay
 * backbone — no author filter, so it feeds the global "Recently found"
 * feed AND the Finders leaderboard (distinct caches per finder) from one
 * sub. The friends-only toggle is applied client-side at render time so
 * flipping it re-filters instantly with no re-subscribe. `limit` bounds
 * the backfill (newest-first). `since` bounds the relay-side scan to the
 * last 30 days, capping the mount-time parse burst; the community sections
 * only surface recent activity so older logs wouldn't be shown anyway.
 *
 * Returns a closer; call it to terminate the subscription.
 */
export const subscribeRecentFoundLogs = (
  onEvent: (log: ParsedFoundLog) => void,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
  limit = 200,
): (() => void) => {
  const filter: Filter = { kinds: [GC_FOUND_LOG_KIND], limit, since: RECENT_SINCE_SECS() };
  const sub = pool.subscribeMany(withGcRelays(relays), filter, {
    onevent: (e: NostrEvent) => {
      if (isDevLeftover(e.pubkey)) return;
      const parsed = parseFoundLogEvent(e as VerifiedEvent);
      if (parsed) onEvent(parsed);
    },
  });
  return () => sub.close();
};

export const subscribeFoundLogs = (
  cacheCoord: string,
  onEvent: (event: VerifiedEvent) => void,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): (() => void) => {
  const filter: Filter = { kinds: [GC_FOUND_LOG_KIND], '#a': [cacheCoord] };
  const sub = pool.subscribeMany(withGcRelays(relays), filter, {
    onevent: (e: NostrEvent) => onEvent(e as VerifiedEvent),
  });
  return () => sub.close();
};

// Subscribe to every kind 7516 found-log published by a given author
// (set). MyPigletsScreen uses this twice: once with `[myPubkey]` for
// the "Found" section and once with the WoT-trusted set (minus me) for
// "Friends' finds". Empty list short-circuits — relays reject empty
// `authors` filters as a free-firehose request.
export const subscribeFoundLogsByAuthors = (
  authors: string[],
  onEvent: (event: VerifiedEvent) => void,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): (() => void) => {
  if (authors.length === 0) return () => {};
  const filter: Filter = { kinds: [GC_FOUND_LOG_KIND], authors };
  const sub = pool.subscribeMany(withGcRelays(relays), filter, {
    onevent: (e: NostrEvent) => onEvent(e as VerifiedEvent),
  });
  return () => sub.close();
};

export const subscribeComments = (
  cacheCoord: string,
  onEvent: (event: VerifiedEvent) => void,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): (() => void) => {
  const filter: Filter = { kinds: [GC_COMMENT_KIND], '#A': [cacheCoord] };
  const sub = pool.subscribeMany(withGcRelays(relays), filter, {
    onevent: (e: NostrEvent) => onEvent(e as VerifiedEvent),
  });
  return () => sub.close();
};

/**
 * Subscribe to nearby NIP-52 calendar events. **Runs two parallel
 * subscriptions and unions the results** because filtering by `g`
 * tag alone is too restrictive in 2026 — most NIP-52 publishers
 * (notably OrangePillApp, the dominant Bitcoin-meetup source) don't
 * add `g` tags consistently. We complement the geohash sub with a
 * hashtag sub on `#t in [bitcoin, lightning, meetup]` so topical
 * matches surface even without a geohash. The caller's `onEvent`
 * fires once per unique event; downstream code already de-dupes
 * by coord so the union is safe.
 *
 * @param prefixes  geohash prefixes for the nearby filter
 * @param topicTags lowercased hashtag list for the topical filter
 *                  (default ['bitcoin','lightning','meetup'])
 * @param onEvent   called per parsed event
 */
// [PerfBlock] same shape as subscribeNearbyCaches above — bracket
// the event burst so we can see if NIP-52 floods are contributing
// to the post-mount freezes. #554.
export const subscribeNearbyEvents = (
  prefixes: string[],
  onEvent: (parsed: ParsedEvent) => void,
  relays: string[] = enabledAppRelays('default', DEFAULT_RELAYS),
  topicTags: string[] = ['bitcoin', 'lightning', 'meetup'],
): (() => void) => {
  const closers: (() => void)[] = [];

  // (1) Geohash-prefix filter — nearby events (the original behaviour).
  if (prefixes.length > 0) {
    // A future meetup can have been announced months ago. Keep those while
    // bounding each initial backfill, just like the topical filter below.
    const geoFilter: Filter = { kinds: [NIP52_TIME_BASED_KIND], '#g': prefixes, limit: 200 };
    const geoSub = pool.subscribeMany(relays, geoFilter, {
      onevent: (e: NostrEvent) => {
        if (isDevLeftover(e.pubkey)) return;
        const __t0 = performance.now();
        const parsed = parseNip52Event(e as VerifiedEvent);
        if (parsed) onEvent(parsed);
        const __dt = performance.now() - __t0;
        if (__dt > 50) {
          console.log(`[PerfBlock] subscribeNearbyEvents geo SLOW: ${Math.round(__dt)}ms`);
        }
      },
    });
    closers.push(() => geoSub.close());
  }

  // (2) Topical-hashtag filter — Bitcoin-tagged events anywhere on
  // the planet, including ones with no `g` tag. Capacity-bounded via
  // `limit` so the union doesn't drown the UI on relays that return
  // years of history.
  if (topicTags.length > 0) {
    const tagFilter: Filter = {
      kinds: [NIP52_TIME_BASED_KIND],
      '#t': topicTags,
      limit: 200,
    };
    const tagSub = pool.subscribeMany(relays, tagFilter, {
      onevent: (e: NostrEvent) => {
        if (isDevLeftover(e.pubkey)) return;
        const __t0 = performance.now();
        const parsed = parseNip52Event(e as VerifiedEvent);
        if (parsed) onEvent(parsed);
        const __dt = performance.now() - __t0;
        if (__dt > 50) {
          console.log(`[PerfBlock] subscribeNearbyEvents tag SLOW: ${Math.round(__dt)}ms`);
        }
      },
    });
    closers.push(() => tagSub.close());
  }

  return () => closers.forEach((c) => c());
};

/**
 * One-shot fetch of the latest revision of a single cache. Used by
 * HuntPiggyDetailScreen on mount when the user navigates from a
 * `nostr:naddr` deep-link or a Discover tap.
 */
/**
 * Pull every kind 37516 listing authored by `hiderPubkey` from the
 * given relays. Used by MyPigletsScreen on mount + pull-to-refresh to
 * surface a hider's own Piggies even when no nearby NIP-GC subscription
 * has echoed them back — particularly the case after a fresh cold
 * start, OR for Piggies hidden in geohashes outside the user's current
 * "nearby" window, OR if the publish happened before this device first
 * cached the relay-derived ParsedCache (#73 follow-up).
 */
export const fetchCachesByAuthor = async (
  hiderPubkey: string,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): Promise<ParsedCache[]> => {
  relays = withGcRelays(relays);
  // Cap the relay query at 5 s via nostr-tools' built-in `maxWait` so a
  // slow relay doesn't pin pull-to-refresh in a "still refreshing"
  // state. Pre-fix we used Promise.race + setTimeout — but Hermes
  // timers can be starved when the JS thread is busy (relay event
  // bursts on Explore mount), so the timeout fired late and querySync
  // kept its WebSocket open for the full ~28 s anyway. maxWait closes
  // the underlying sub from inside the pool, which is timer-independent.
  const __t0 = performance.now();
  const events = await pool.querySync(
    relays,
    {
      kinds: [GC_LISTING_KIND],
      authors: [hiderPubkey],
    },
    { maxWait: 5000 },
  );
  console.log(
    `[PerfBlock] fetchCachesByAuthor: ${events.length} events in ${Math.round(performance.now() - __t0)}ms (relays=${relays.length})`,
  );
  const seen = new Map<string, ParsedCache>();
  for (const e of events) {
    // Skip orphaned dev-leftover signers — see devEventDenylist.ts.
    if (isDevLeftover(e.pubkey)) continue;
    const parsed = parseCache(e as VerifiedEvent);
    if (!parsed) continue;
    // Replaceable-event semantics: dedupe by coord, latest createdAt wins.
    const existing = seen.get(parsed.coord);
    if (!existing || parsed.createdAt > existing.createdAt) {
      seen.set(parsed.coord, parsed);
    }
  }
  return [...seen.values()];
};

export const fetchCache = async (
  hiderPubkey: string,
  d: string,
  relays: string[] = enabledAppRelays('geocache', GC_RELAYS),
): Promise<ParsedCache | null> => {
  // 5 s maxWait — same Hermes timer-starvation rationale as
  // fetchCachesByAuthor above. Without it a slow relay leaves
  // HuntPiggyDetailScreen / EventDetailScreen on a spinner indefinitely.
  const events = await pool.querySync(
    withGcRelays(relays),
    {
      kinds: [GC_LISTING_KIND],
      authors: [hiderPubkey],
      '#d': [d],
    },
    { maxWait: 5000 },
  );
  if (events.length === 0) return null;
  // Sort created_at desc — replaceable, latest wins; defensive vs
  // a misbehaving relay returning multiple revisions.
  events.sort((a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at);
  // Skip orphaned dev-leftover signers — see devEventDenylist.ts.
  if (isDevLeftover(events[0].pubkey)) return null;
  return parseCache(events[0] as VerifiedEvent);
};

/**
 * One-shot lookup for a single NIP-52 calendar event by coord. Used by
 * EventDetailScreen on mount when the event isn't in the AsyncStorage
 * mirror (deep-link, Share / Linking handoff). Without this fallback the
 * screen settles on a permanent "This event isn't in our local feed"
 * empty state — Copilot review on PR #488 flagged the regression.
 */
export const fetchEvent = async (
  organiserPubkey: string,
  d: string,
  relays: string[] = enabledAppRelays('default', DEFAULT_RELAYS),
): Promise<ParsedEvent | null> => {
  // 5 s maxWait — same rationale as fetchCache above.
  const events = await pool.querySync(
    relays,
    {
      kinds: [NIP52_TIME_BASED_KIND],
      authors: [organiserPubkey],
      '#d': [d],
    },
    { maxWait: 5000 },
  );
  if (events.length === 0) return null;
  events.sort((a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at);
  if (isDevLeftover(events[0].pubkey)) return null;
  return parseNip52Event(events[0] as VerifiedEvent);
};
