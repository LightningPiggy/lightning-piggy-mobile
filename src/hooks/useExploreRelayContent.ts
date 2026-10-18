import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { useTrustGraph } from '../contexts/TrustGraphContext';
import { joinExploreByAuthorFetch } from '../utils/exploreFetchGuard';
import {
  type NearbyCachesCompletion,
  fetchCachesByAuthor,
  subscribeNearbyCaches,
  subscribeNearbyEvents,
} from '../services/nostrPlacesPublisher';
import {
  loadCachedCaches,
  loadCachedEvents,
  peekCachedCachesSync,
  peekCachedEventsSync,
} from '../services/nostrPlacesStorage';
import { type ParsedCache, type ParsedEvent } from '../services/nostrPlacesService';
import { decodeGeohash, encodeGeohash, geohashNeighbours, haversineMetres } from '../utils/geohash';
import { deriveGeocacheRailState } from '../utils/geocacheRailState';
import { isFutureEvent } from '../utils/futureEvent';
import { isHiddenInProd, visibleCaches, visibleEvents } from '../utils/exploreContentFilter';
import { usePersistCaches, usePersistEvents } from './useExplorePlacesPersist';
import { useCoalescedMap } from '../utils/useCoalescedMap';
import { useFocusEffect } from '@react-navigation/native';
import type { LiveUserLocation } from './useLiveUserLocation';

export const CACHE_BACKFILL_TARGET = 10;

/** Owns Explore's coalesced relay data and disk hydration. */
export function useExploreRelayContent(
  pos: LiveUserLocation | null,
  refreshKey: number,
  maxDistanceMetres: number | null = null,
) {
  // ----- NIP-GC caches + NIP-52 events (live subs) ------------------------

  // Web-of-trust filter — kept in a ref so the subscription callbacks
  // always see the current `isTrusted` predicate without resubscribing
  // every time the trust set churns (L2 backfill, contact-list updates).
  // Post-#535: `isTrusted` is tier-aware; consumers no longer branch on a
  // separate `filterEnabled` flag (returns true unconditionally for 'all').
  const { isTrusted } = useTrustGraph();
  const isTrustedRef = useRef(isTrusted);
  useEffect(() => {
    isTrustedRef.current = isTrusted;
  }, [isTrusted]);

  const {
    map: caches,
    setMap: setCaches,
    enqueue: enqueueCache,
    flush: flushPendingCaches,
  } = useCoalescedMap<ParsedCache>({
    initial: () => new Map(peekCachedCachesSync().map((c) => [c.coord, c])),
    shouldReplace: (old, next) => old.createdAt < next.createdAt,
  });
  const {
    map: events,
    setMap: setEvents,
    enqueue: enqueueEvent,
    flush: flushPendingEvents,
  } = useCoalescedMap<ParsedEvent>({
    initial: () => new Map(peekCachedEventsSync().map((e) => [e.coord, e])),
    shouldReplace: (old, next) => old.startsAt !== next.startsAt,
  });

  // Stable array projections of the caches/events Maps so React.memo on the
  // consuming LibreMiniMap can short-circuit re-renders (a fresh
  // `[...caches.values()]` literal each render would defeat the memo). These
  // feed the Explore hub mini-map, so they apply the SAME prod test-account
  // hide (+ future-only for events) as the rails — cold-start items hydrated
  // from AsyncStorage bypass the ingestion callback, so a hidden Piggy cache
  // or past event would otherwise paint as a map marker (#917).
  const cachesArr = useMemo(
    () => visibleCaches([...caches.values()], (c) => c.hiderPubkey),
    [caches],
  );
  const eventsArr = useMemo(
    () =>
      visibleEvents([...events.values()], (e) => e.organiserPubkey, Math.floor(Date.now() / 1000)),
    [events],
  );

  // Hydrate last-known caches + events from AsyncStorage so the rails
  // render instantly on cold start while the live relay subs backfill.
  useEffect(() => {
    let cancelled = false;
    const __t0 = performance.now();
    Promise.all([loadCachedCaches(), loadCachedEvents()]).then(([cs, es]) => {
      if (cancelled) return;
      const __ms = Math.round(performance.now() - __t0);
      if (__ms > 200) {
        console.log(
          `[PerfBlock] ExploreHome loadCachedCaches+Events: ${__ms}ms caches=${cs.length} events=${es.length}`,
        );
      }
      if (cs.length > 0) {
        setCaches((prev) => {
          if (prev.size > 0) return prev; // live sub already filled in
          const m = new Map<string, ParsedCache>();
          for (const c of cs) m.set(c.coord, c);
          return m;
        });
      }
      if (es.length > 0) {
        setEvents((prev) => {
          if (prev.size > 0) return prev;
          const m = new Map<string, ParsedEvent>();
          for (const e of es) m.set(e.coord, e);
          return m;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setCaches, setEvents]);

  // Surface the signed-in user's own published Piggies in the rail
  // even when no nearby `#g` subscription has echoed them back. The
  // nearby sub filters by geohash prefix, which excludes the user's
  // own listing if they hid it outside their current viewport OR if
  // the sub was paused (#557) at the moment the relay echoed back.
  // One-shot per (pubkey, refreshKey) via the module-scoped
  // `claimExploreByAuthorFetch` guard — re-runs on pull-to-refresh and
  // pubkey change but never on unrelated re-renders, and is immune to the
  // concurrent parallel-fire a component useRef suffered (#751 audit #4).
  const { pubkey: signedInPubkey, relays: userRelays } = useNostr();
  // The user's read-relay URLs, plus a content key that only changes when the
  // URL *set* changes (sorted so a mere reorder doesn't) — not when useNostr()
  // hands back a new array with the same URLs (cold-start cache→network churn),
  // which used to double-fire the by-author fetch below (#798).
  const readRelays = userRelays.filter((r) => r.read).map((r) => r.url);
  const readRelayKey = [...readRelays].sort().join(',');
  useEffect(() => {
    if (!signedInPubkey) return;
    const fetchKey = `${signedInPubkey}:${refreshKey}`;
    let cancelled = false;
    // Join an in-flight fetch so concurrent effect re-runs don't fire parallel
    // requests, and the current run still merges on cancel (#752 Copilot).
    joinExploreByAuthorFetch(fetchKey, () =>
      fetchCachesByAuthor(signedInPubkey, readRelays.length > 0 ? readRelays : undefined),
    )
      .then((mine) => {
        if (cancelled) return;
        console.log(
          `[PerfBlock] ExploreHome by-author merge: fetched=${mine.length} ` +
            mine.map((c) => `${c.name ?? c.d}@${c.geohash?.slice(0, 5) ?? '??'}`).join(', '),
        );
        if (mine.length === 0) return;
        setCaches((prev) => {
          const next = new Map<string, ParsedCache>(prev);
          let added = 0;
          for (const c of mine) {
            const existing = next.get(c.coord);
            if (!existing || c.createdAt > existing.createdAt) {
              next.set(c.coord, c);
              added++;
            }
          }
          console.log(
            `[PerfBlock] ExploreHome by-author merge: ${added} new/updated in caches Map`,
          );
          return next;
        });
      })
      .catch((e) => {
        console.warn(`[PerfBlock] ExploreHome by-author fetch threw: ${(e as Error).message}`);
      });
    return () => {
      cancelled = true;
    };
    // Depend on readRelayKey (the relay-URL *content*), not the userRelays array
    // identity: a genuine relay-set change still re-fires the fetch (parity with
    // MapScreen's by-author fetch), but the cold-start new-array-same-URLs churn
    // no longer does — that double-fired a redundant ~20s query (#798).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInPubkey, refreshKey, readRelayKey]);

  // Write-through to AsyncStorage (debounced) so the next cold start hydrates
  // fresh content; both hooks self-heal prod caches (drop stale test items).
  usePersistCaches(caches);
  usePersistEvents(events);
  // Counts of events arriving from pubkeys outside the trust set.
  // Surfaced as "N hidden — from outside your trust graph" so users
  // know the filter is doing something.
  const [untrustedCacheCount, setUntrustedCacheCount] = useState(0);
  const [untrustedEventCount, setUntrustedEventCount] = useState(0);
  const pendingCounts = useRef({ caches: 0, events: 0 });
  const countTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushCounts = useCallback(() => {
    if (countTimer.current) clearTimeout(countTimer.current);
    countTimer.current = null;
    const batch = pendingCounts.current;
    pendingCounts.current = { caches: 0, events: 0 };
    if (batch.caches) setUntrustedCacheCount((n) => n + batch.caches);
    if (batch.events) setUntrustedEventCount((n) => n + batch.events);
  }, []);
  const countUntrusted = useCallback(
    (kind: 'caches' | 'events') => {
      pendingCounts.current[kind]++;
      if (!countTimer.current) countTimer.current = setTimeout(flushCounts, 100);
    },
    [flushCounts],
  );
  useEffect(
    () => () => {
      if (countTimer.current) clearTimeout(countTimer.current);
    },
    [],
  );
  const cachesRef = useRef(caches);
  useLayoutEffect(() => {
    cachesRef.current = caches;
  }, [caches]);
  const [cacheCompletion, setCacheCompletion] = useState<NearbyCachesCompletion | null>(null);
  const subsCloserRef = useRef<(() => void)[]>([]);
  // Gate re-subscription on coarse movement (~500 m via 0.005° quantisation)
  // via the posBucketKey in the effect's deps below — NOT a body-level skip:
  // React runs cleanup BEFORE the new body, so a body-level skip closes the
  // existing subs first then bails, leaving zero subs across cold-start GPS
  // jitter (peekCachedAnchor → getLastKnown → getCurrent settle within a few
  // hundred metres). #741 Copilot review on #739 Fix 3.
  // Relay work pauses on blur; native map and cached data remain mounted.
  const posLat = pos?.lat;
  const posLon = pos?.lon;
  const POS_BUCKET_DEG = 0.005;
  const posBucketKey =
    typeof posLat !== 'number' || typeof posLon !== 'number'
      ? null
      : `${Math.round(posLat / POS_BUCKET_DEG)}:${Math.round(posLon / POS_BUCKET_DEG)}`;
  useFocusEffect(
    useCallback(() => {
      // refreshKey in deps: pull-to-refresh bumps it → tear down + re-run.
      // posLat / posLon are used here for the geohash filters but deliberately
      // NOT in deps (they'd thrash the gate on every GPS tick) — see the
      // bucket-key comment above the declaration. eslint suppression below.
      if (posBucketKey === null || typeof posLat !== 'number' || typeof posLon !== 'number') return;
      // `cancelled` covers the window between effect cleanup firing
      // (subsCloserRef.current.forEach(c => c())) and the underlying
      // relay socket actually closing — a stray event in that gap
      // would otherwise enqueue more items and arm a fresh flush
      // timer that fires after the cleanup. Mirrors NostrContext.tsx's
      // DM inbox precedent.
      let cancelled = false;
      setCacheCompletion(null);
      // Caches start at precision 5 and widen to 3 when sparse.
      // Events use precision 3 (~150 km) so a rural
      // user catches the nearest city's Bitcoin meetup; most NIP-52
      // publishers emit g tags at every precision 3..9.
      //
      // `geohashNeighbours` returns the user's own cell plus the 8
      // surrounding tiles at that precision (9 prefixes for caches,
      // 9 for events). Pre-#631 we used `geohashPrefixes(myGh, 5)`
      // which returned only the user's own truncation chain — caches
      // hidden in an adjacent precision-5 tile (e.g. 500 m across a
      // tile boundary) never matched the `#g` filter.
      const eventPrefixes = geohashNeighbours(encodeGeohash(posLat, posLon, 3));

      // Each query completes within eight seconds. Allow all three stages
      // to run even when the initial query completes at its deadline.
      const received = new Map<string, ParsedCache>();
      let searchDone = false;
      let allFailed = true;
      let closeWidening: (() => void) | undefined;
      const finish = () => {
        if (cancelled || searchDone) return;
        searchDone = true;
        clearTimeout(deadline);
        closeWidening?.();
        flushPendingCaches();
        flushCounts();
        setCacheCompletion({ allRelaysFailed: allFailed });
      };
      const deadline = setTimeout(() => {
        // A deadline alone is inconclusive, just like the nearby query.
        allFailed = false;
        finish();
      }, 3 * 8000);
      subsCloserRef.current.push(() => clearTimeout(deadline));
      const query = (precision: number) => {
        if (cancelled || searchDone) return;
        const startedAt = performance.now();
        let completed = false;
        let close: (() => void) | undefined;
        const prefixes = geohashNeighbours(encodeGeohash(posLat, posLon, precision));
        close = subscribeNearbyCaches(
          prefixes,
          (c) => {
            if (cancelled || (precision < 5 && (completed || searchDone))) return;
            if (isHiddenInProd(c.hiderPubkey)) return;
            if (!isTrustedRef.current(c.hiderPubkey)) {
              countUntrusted('caches');
              return;
            }
            const previous = received.get(c.coord);
            if (!previous || previous.createdAt < c.createdAt) received.set(c.coord, c);
            enqueueCache(c.coord, c);
          },
          undefined,
          { limit: precision === 5 ? 200 : 100 },
          (result) => {
            if (cancelled || searchDone || completed) return;
            completed = true;
            allFailed = allFailed && result.allRelaysFailed;
            if (precision < 5) {
              closeWidening = undefined;
              close?.();
            }
            flushPendingCaches();
            flushCounts();
            // Include pending relay items before React commits the coalesced
            // flush, retaining the same newest-wins rule as the caches Map.
            const known = new Map(cachesRef.current);
            for (const [coord, cache] of received) {
              const previous = known.get(coord);
              if (!previous || previous.createdAt < cache.createdAt) known.set(coord, cache);
            }
            // Only candidates in the searched cells stop widening: cached or
            // by-author listings on another continent must not hide closer ones.
            const candidateCount = [...known.values()].filter(
              (cache) =>
                !isHiddenInProd(cache.hiderPubkey) &&
                cache.geohash &&
                prefixes.some((prefix) => cache.geohash!.startsWith(prefix)),
            ).length;
            console.log(
              `[PerfBlock] Explore cache search: precision=${precision} candidates=${candidateCount} elapsed=${Math.round(performance.now() - startedAt)}ms`,
            );
            if (candidateCount < CACHE_BACKFILL_TARGET && precision > 3) query(precision - 1);
            else finish();
          },
        );
        // Also handles a synchronous completion from a relay adapter.
        if (precision < 5) {
          if (completed || searchDone) close();
          else closeWidening = close;
        }
        subsCloserRef.current.push(close);
      };
      query(5);
      subsCloserRef.current.push(
        subscribeNearbyEvents(eventPrefixes, (e) => {
          if (cancelled) return;
          // Hide test-account ("Piggy") events in prod; skip finished events.
          if (isHiddenInProd(e.organiserPubkey)) return;
          if (!isFutureEvent(e, Math.floor(Date.now() / 1000))) return;
          if (!isTrustedRef.current(e.organiserPubkey)) {
            countUntrusted('events');
            return;
          }
          enqueueEvent(e.coord, e);
        }),
      );
      return () => {
        cancelled = true;
        subsCloserRef.current.forEach((c) => c());
        subsCloserRef.current = [];
        // Drain whatever's queued so the last few events from a
        // refresh-triggered tear-down (or full unmount) aren't lost.
        // Both flushers are null-safe + no-op when the buffer is
        // already empty.
        flushPendingCaches();
        flushPendingEvents();
        flushCounts();
      };
      // posLat / posLon are intentionally NOT in this deps array — see the
      // comment at the top of the effect. The bucket key gates re-runs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      posBucketKey,
      refreshKey,
      signedInPubkey,
      flushPendingCaches,
      flushPendingEvents,
      enqueueCache,
      enqueueEvent,
      countUntrusted,
      flushCounts,
    ]),
  );

  const sortedCaches = useMemo(() => {
    const lowerPubkey = signedInPubkey?.toLowerCase() ?? null;
    const haveFix = typeof posLat === 'number' && typeof posLon === 'number';
    // With a fix, every known cache competes on distance, including own caches.
    // Keep the existing radius/own-first behaviour only when location is absent.
    const items = [...caches.values()]
      .filter((cache) => !isHiddenInProd(cache.hiderPubkey))
      .map((cache) => {
        const center = cache.geohash ? decodeGeohash(cache.geohash) : null;
        const distance =
          haveFix && center
            ? haversineMetres({ lat: posLat, lon: posLon }, { lat: center.lat, lon: center.lng })
            : Number.POSITIVE_INFINITY;
        const isOwn = lowerPubkey !== null && cache.hiderPubkey.toLowerCase() === lowerPubkey;
        return { cache, distance, isOwn };
      })
      .filter(
        (item) => haveFix || maxDistanceMetres === null || item.distance <= maxDistanceMetres,
      );
    items.sort((a, b) => {
      if (!haveFix && a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
      return a.distance - b.distance;
    });
    // The horizontal teaser retains its existing cap; See all opens the full list.
    return items.slice(0, 50);
  }, [caches, posLat, posLon, maxDistanceMetres, signedInPubkey]);

  return {
    caches,
    sortedCaches,
    events,
    cachesArr,
    cacheRailState: deriveGeocacheRailState(sortedCaches.length, pos !== null, cacheCompletion),
    eventsArr,
    signedInPubkey,
    untrustedCacheCount,
    untrustedEventCount,
    setUntrustedCacheCount,
    setUntrustedEventCount,
  };
}
