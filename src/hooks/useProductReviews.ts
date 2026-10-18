import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { Event as NostrEvent } from 'nostr-tools';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { queryReviewDeletions, queryReviewEvents } from '../services/productFeedbackQueries';
import {
  aggregateReviews,
  parseReviewEvent,
  reviewAddress,
  visibleReviews,
  type ParsedReview,
  type ReviewAggregate,
} from '../utils/productReviews';
import { DELETION_KIND } from '../utils/nip09';
import { mergeFeedback, refreshSince } from '../utils/feedbackRefresh';

export interface UseProductReviews {
  reviews: ParsedReview[];
  aggregate: ReviewAggregate;
  loading: boolean;
  /**
   * True when the relay query failed. The user-facing copy is localized at the
   * render layer (`market.reviews.loadError`) rather than baked in here, so the
   * message follows the app's selected locale.
   */
  error: boolean;
  refetch: () => void;
  /**
   * Pull-to-refresh (#1301): fetch only reviews newer than the newest loaded
   * (minus slack) plus fresh author deletions, and merge them in with one
   * batched update. Rejects when every relay failed.
   */
  refresh: (signal: AbortSignal) => Promise<void>;
  /** Show a review we just published at once (before the refetch sees it). */
  addLocally: (review: NostrEvent) => void;
  /** Hide your review at once (deleted) — every version up to the one
   * shown, like the `a`-tag kind-5 it mirrors. Returns `settle`: pass the
   * signed kind-5 once a relay took it (it replaces the stand-in), or null
   * to undo. */
  hideLocally: (review: ParsedReview) => (deletion: NostrEvent | null) => void;
}

/**
 * Live product reviews (Nostr kind 31555) for a review coordinate
 * `a:30402:<merchant>:<dTag>`. Queries the user's read relays, then parses +
 * aggregates via the pure {@link parseReviews}/{@link aggregateReviews}
 * helpers. `coord` null (seller has no Nostr identity) yields an empty set.
 */
export function useProductReviews(coord: string | null): UseProductReviews {
  const { relays } = useNostr();
  const [events, setEvents] = useState<NostrEvent[]>([]);
  // Author kind-5 deletions of the fetched reviews (#1272).
  const [deletions, setDeletions] = useState<NostrEvent[]>([]);
  // Optimistic state from this device's own edits/deletes; survives refetches
  // so a relay that ignores NIP-09 can't bring a deleted review back here.
  const [localAdded, setLocalAdded] = useState<NostrEvent[]>([]);
  // Local stand-ins for kind-5s still being published (same shape, so the
  // one `deletedByAuthor` rule applies to both).
  const [localDeletions, setLocalDeletions] = useState<NostrEvent[]>([]);
  // Read by the fetch (not a dep): our own posts are checked for deletions
  // too, in case another device deleted one relays no longer return.
  const localAddedRef = useRef(localAdded);
  useEffect(() => {
    localAddedRef.current = localAdded;
  }, [localAdded]);
  // The loaded set, read by `refresh` (its `since` + merge base).
  const loadedRef = useRef({ events, deletions });
  // Bumped by every load and refresh: only the newest one may commit, so a
  // slow first load can't overwrite (or resurrect over) a newer refresh.
  const generationRef = useRef(0);
  useEffect(() => {
    loadedRef.current = { events, deletions };
  }, [events, deletions]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [tick, setTick] = useState(0);
  const refetch = useCallback(() => setTick((t) => t + 1), []);
  // One quiet retry before showing an error: right after launch (or a
  // network blip) every relay can fail its first connection, and a product
  // with no reviews must read "No reviews yet", not "Failed to load".
  const autoRetried = useRef(false);

  const readRelays = useMemo(() => {
    const r = relays.filter((x) => x.read).map((x) => x.url);
    return r.length > 0 ? r : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [relays]);

  // Focus-armed (repo rule: screens arm relay work with useFocusEffect, never
  // a bare useEffect): the Explore stack uses freezeOnBlur, so a blurred
  // product page must abort its in-flight query rather than let it run to
  // its maxWait; refocus re-runs the (cheap, bounded) query.
  useFocusEffect(
    useCallback(() => {
      if (!coord) {
        setEvents([]);
        setDeletions([]);
        setLoading(false);
        setError(false);
        return;
      }
      const controller = new AbortController();
      const { signal } = controller;
      const generation = ++generationRef.current;
      const superseded = () => signal.aborted || generation !== generationRef.current;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      setLoading(true);
      setError(false);
      queryReviewEvents(readRelays, coord, { signal })
        .then((evs) => {
          if (superseded()) return;
          autoRetried.current = false;
          setEvents(evs);
          setLoading(false);
          // Then the kind-5s naming them — by address (what we and most
          // clients send for a replaceable review) and by id. Best-effort: a
          // failed lookup keeps the previous deletions.
          return queryReviewDeletions(readRelays, [...evs, ...localAddedRef.current], {
            signal,
          }).then(
            (dels) => {
              if (!superseded()) setDeletions(dels);
            },
            () => undefined,
          );
        })
        .catch(() => {
          if (superseded()) return;
          if (!autoRetried.current) {
            autoRetried.current = true;
            retryTimer = setTimeout(() => setTick((t) => t + 1), 1500);
            return;
          }
          setError(true);
        })
        .finally(() => {
          if (!signal.aborted && !retryTimer) setLoading(false);
        });
      return () => {
        if (retryTimer) clearTimeout(retryTimer);
        controller.abort();
      };
      // tick intentionally rearms a failed lookup.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [coord, readRelays, tick]),
  );

  // Exact `d` scoping: the `#d` filter is only a relay-side request, so a
  // review a relay returns for another product must not count here.
  // Newest version per author, minus author deletions (incl. local
  // stand-ins) — see `visibleReviews`.
  const reviews = useMemo(() => {
    const all = localAdded.length > 0 ? [...events, ...localAdded] : events;
    return visibleReviews(
      all,
      localDeletions.length > 0 ? [...deletions, ...localDeletions] : deletions,
      coord ?? undefined,
    );
  }, [events, localAdded, deletions, localDeletions, coord]);
  const aggregate = useMemo(() => aggregateReviews(reviews), [reviews]);

  // `signal` is owned by the page's pull-to-refresh (aborted on its timeout
  // and on unmount).
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (!coord) return;
      const generation = ++generationRef.current;
      const loaded = loadedRef.current;
      // Short per-query deadlines keep events + deletions inside the page's
      // ~8 s refresh budget even with a dead relay. Signatures are checked
      // here (not left to the pool) before anything is merged. Deletions are
      // looked up for everything shown with no `since` — an old review may
      // have been deleted since, or the first lookup may have failed; the
      // lookup is already bounded per id.
      const opts = { signal, maxWait: 3000, verify: true };
      const evs = await queryReviewEvents(readRelays, coord, {
        ...opts,
        since: refreshSince(loaded.events),
      });
      const dels = await queryReviewDeletions(
        readRelays,
        [...loaded.events, ...evs, ...localAddedRef.current],
        opts,
      ).catch(() => [] as NostrEvent[]);
      // A newer load or refresh started meanwhile — it owns the state.
      if (signal.aborted || generation !== generationRef.current) return;
      const merged = mergeFeedback(
        loadedRef.current,
        { events: evs, deletions: dels },
        (e) => parseReviewEvent(e, coord) !== null,
      );
      // One batched update for the whole refresh (React batches these).
      setEvents(merged.events);
      setDeletions(merged.deletions);
      setError(false);
    },
    [coord, readRelays],
  );

  // One setState per user action (never per relay event).
  const addLocally = useCallback((review: NostrEvent) => {
    setLocalAdded((prev) => (prev.some((e) => e.id === review.id) ? prev : [...prev, review]));
  }, []);
  const hideLocally = useCallback(
    (review: ParsedReview) => {
      if (!coord) return () => {};
      const stand: NostrEvent = {
        id: `local-delete:${review.id}`,
        pubkey: review.pubkey,
        kind: DELETION_KIND,
        created_at: review.createdAt,
        tags: [['a', reviewAddress(review.pubkey, coord)]],
        content: '',
        sig: '',
      };
      setLocalDeletions((prev) => [...prev, stand]);
      return (deletion: NostrEvent | null) =>
        setLocalDeletions((prev) => {
          const rest = prev.filter((d) => d !== stand);
          return deletion ? [...rest, deletion] : rest;
        });
    },
    [coord],
  );

  return { reviews, aggregate, loading, error, refetch, refresh, addLocally, hideLocally };
}
