import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Coalesce a burst of per-item updates into one batched `setState` per flush
 * window, keyed by a string id.
 *
 * Why: a Nostr relay subscription's `onevent` callback can fire 50+ times in
 * <200 ms on a cold-start backfill. The naive `setState(prev => new Map(prev))`
 * per event is O(N) per event → O(N²) over the burst, and re-renders the
 * consuming screen on every event, blocking the JS thread for the whole
 * backfill. This hook accumulates events in a ref-held Map and flushes them to
 * one React state commit on a short debounce (or early when the buffer is
 * large), so the list still updates incrementally — just every ~`flushMs`
 * instead of every event.
 *
 * Mirrors the inline pattern `ExploreHomeScreen` already uses (#605 audit P1);
 * extracted here so `HuntScreen` and `EventsScreen` can share it without each
 * re-implementing (and re-bugging) the unmount-guard + drain-on-cleanup logic.
 *
 * `shouldReplace(existing, incoming)` decides whether an incoming item
 * supersedes one already staged OR already committed (e.g. a newer
 * `created_at`). It runs both at `enqueue` time (against the staged buffer) and
 * again in the flush merge (against committed state), so a stale event that
 * lands after a newer one was already committed can't clobber it. Returning
 * false drops the incoming item. `flush()` drains the buffer synchronously —
 * call it on subscription tear-down so the tail of a burst isn't lost.
 */
export interface CoalescedMap<V> {
  /** The committed Map — safe to read in render / memos. */
  map: Map<string, V>;
  /** Replace the committed Map outright (e.g. seed from cache, or clear). */
  setMap: React.Dispatch<React.SetStateAction<Map<string, V>>>;
  /** Stage an item; flushes are debounced. */
  enqueue: (key: string, value: V) => void;
  /** Drain the staged buffer into one commit now. No-op when empty/unmounted. */
  flush: () => void;
  /**
   * Clear the committed Map AND DISCARD the staged buffer + pending timer.
   * Unlike {@link flush}, staged items are dropped, not committed — use this on
   * a reload/refetch-from-scratch so a previous subscription's buffered tail
   * can't repopulate the just-cleared list.
   */
  reset: () => void;
}

/**
 * Evict down to `max`: the lowest-`rank` entries when a rank is given,
 * otherwise the oldest-inserted (Map preserves insertion order).
 */
function capOldest<V>(
  map: Map<string, V>,
  max: number | undefined,
  rank?: (value: V) => number,
): void {
  if (max === undefined || map.size <= max) return;
  let toDelete = map.size - max;
  if (rank) {
    const lowest = [...map].sort((a, b) => rank(a[1]) - rank(b[1])).slice(0, toDelete);
    for (const [key] of lowest) map.delete(key);
    return;
  }
  for (const key of map.keys()) {
    if (toDelete-- <= 0) break;
    map.delete(key);
  }
}

export function useCoalescedMap<V>(options?: {
  /** Seed the committed Map on first render (e.g. from a sync cache peek). */
  initial?: () => Map<string, V>;
  /** True when `incoming` should supersede `existing`. Default: always. */
  shouldReplace?: (existing: V, incoming: V) => boolean;
  flushMs?: number;
  flushThreshold?: number;
  /**
   * Cap the committed Map. On each flush, once the Map exceeds this size the
   * oldest-inserted entries are evicted (Map preserves insertion order) down to
   * the cap. Use for a long-lived subscription whose key space grows unbounded
   * (e.g. per-event-id feeds) so the Map can't balloon over a long session.
   * Omit for naturally-bounded key spaces (e.g. keyed per-cache).
   */
  maxSize?: number;
  /**
   * Opt-in: when trimming to `maxSize`, keep the highest-ranked entries (e.g.
   * `(v) => v.createdAt` keeps the newest by date) instead of evicting by
   * arrival order — for feeds fed by several relays or REQs at once, where a
   * late-arriving old event must not push out a newer one.
   */
  evictBy?: (value: V) => number;
}): CoalescedMap<V> {
  // 100 ms feels instant (≤120 ms reads as same-frame) yet coalesces a typical
  // relay event burst into 2–3 commits. 25-item threshold flushes early when a
  // fast relay dumps a big backlog so it doesn't sit buffered for the full
  // window.
  const flushMs = options?.flushMs ?? 100;
  const flushThreshold = options?.flushThreshold ?? 25;
  // Keep the predicate in a ref so `enqueue` / `flush` stay referentially
  // stable (callers pass an inline arrow each render).
  const shouldReplaceRef = useRef(options?.shouldReplace);
  shouldReplaceRef.current = options?.shouldReplace;
  // Held in a ref so `flush` (deps: []) stays referentially stable.
  const maxSizeRef = useRef(options?.maxSize);
  maxSizeRef.current = options?.maxSize;
  const evictByRef = useRef(options?.evictBy);
  evictByRef.current = options?.evictBy;

  const [map, setMap] = useState<Map<string, V>>(() => {
    // Cap the seed too, so a caller seeding via `initial` over the cap isn't
    // left oversized until the first flush (Copilot review).
    const seed = options?.initial?.() ?? new Map();
    capOldest(seed, options?.maxSize, options?.evictBy);
    return seed;
  });
  const pendingRef = useRef<Map<string, V>>(new Map());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Distinguish full unmount (React throws on setState) from a focus blur — the
  // flusher early-returns on unmount but still drains on blur so the next focus
  // shows the tail of the queue.
  const isUnmountedRef = useRef(false);
  useEffect(
    () => () => {
      isUnmountedRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (isUnmountedRef.current) {
      pendingRef.current = new Map();
      return;
    }
    const batch = pendingRef.current;
    if (batch.size === 0) return;
    pendingRef.current = new Map();
    setMap((prev) => {
      // Clone lazily: when `shouldReplace` rejects the whole batch (e.g. a
      // relay replaying events already committed, as on MapScreen's
      // refocus resubscribe) return `prev` so React bails out of the
      // re-render instead of committing an identical copy (#1068 review).
      let next: Map<string, V> | null = null;
      const replace = shouldReplaceRef.current;
      for (const [key, value] of batch) {
        const existing = (next ?? prev).get(key);
        if (existing !== undefined && replace && !replace(existing, value)) continue;
        if (next === null) next = new Map(prev);
        next.set(key, value);
      }
      if (next === null) return prev;
      // Evict once over the cap so a long-lived subscription can't grow the
      // committed Map unbounded.
      capOldest(next, maxSizeRef.current, evictByRef.current);
      return next;
    });
  }, []);

  const enqueue = useCallback(
    (key: string, value: V) => {
      if (isUnmountedRef.current) return;
      const replace = shouldReplaceRef.current;
      const staged = pendingRef.current.get(key);
      if (staged !== undefined && replace && !replace(staged, value)) return;
      pendingRef.current.set(key, value);
      if (pendingRef.current.size >= flushThreshold) {
        flush();
        return;
      }
      if (timerRef.current === null) {
        timerRef.current = setTimeout(flush, flushMs);
      }
    },
    [flush, flushMs, flushThreshold],
  );

  const reset = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // Drop staged items (do NOT commit them) so a reload starts truly empty.
    pendingRef.current = new Map();
    if (!isUnmountedRef.current) setMap(new Map());
  }, []);

  return { map, setMap, enqueue, flush, reset };
}
