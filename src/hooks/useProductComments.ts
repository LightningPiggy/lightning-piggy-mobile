import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { Event as NostrEvent } from 'nostr-tools';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { queryCommentDeletions, queryCommentEvents } from '../services/productFeedbackQueries';
import {
  commentRootRef,
  directReplies,
  threadedComments,
  type CommentRoot,
} from '../utils/productComments';
import { reconcileComments } from '../utils/commentEdits';
import { mergeFeedback, refreshSince } from '../utils/feedbackRefresh';

export interface UseProductComments {
  /** Every visible comment in the thread (all depths) — deleted and
   * superseded (edited) versions already removed. */
  allComments: NostrEvent[];
  thread: ReturnType<typeof threadedComments>;
  /** Thread roots, including replies whose parent is gone, newest-first. */
  topLevel: NostrEvent[];
  /** Direct replies to a given comment id, oldest-first. */
  getDirectReplies: (parentId: string) => NostrEvent[];
  loading: boolean;
  /**
   * True when the relay query failed. The user-facing copy is localized at the
   * render layer (`market.comments.loadError`) rather than baked in here, so
   * the message follows the app's selected locale.
   */
  error: boolean;
  refetch: () => void;
  /**
   * Pull-to-refresh (#1301): fetch only comments newer than the newest loaded
   * (minus slack) plus fresh author deletions, and merge them in with one
   * batched update. Rejects when every relay failed.
   */
  refresh: (signal: AbortSignal) => Promise<void>;
  /** Show a comment we just published at once (before the refetch sees it). */
  addLocally: (comment: NostrEvent) => void;
  /** Hide a comment at once (deleted / replaced); returns the undo. */
  hideLocally: (id: string) => () => void;
}

/**
 * Live product comments (NIP-22 kind 1111) rooted on the kind-30402 product.
 * `root` should be memoised by the caller so its identity is stable across
 * renders; a null root (seller without a Nostr identity) yields an empty set.
 */
export function useProductComments(root: CommentRoot | null): UseProductComments {
  const { relays } = useNostr();
  const [events, setEvents] = useState<NostrEvent[]>([]);
  // Author kind-5 deletions of the fetched comments (#1272).
  const [deletions, setDeletions] = useState<NostrEvent[]>([]);
  // Optimistic state from this device's own edits/deletes. Survives refetches:
  // a relay that ignores NIP-09 must not bring a deleted comment back here.
  const [localAdded, setLocalAdded] = useState<NostrEvent[]>([]);
  const [localHidden, setLocalHidden] = useState<ReadonlySet<string>>(() => new Set());
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

  const readRelays = useMemo(() => {
    const r = relays.filter((x) => x.read).map((x) => x.url);
    return r.length > 0 ? r : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [relays]);

  // Stable string identity for the root, so the effect re-runs only when the
  // product actually changes (not on every parent re-render).
  const rootRef = root ? commentRootRef(root) : null;

  // Focus-armed (repo rule: relay work is armed with useFocusEffect, never a
  // bare useEffect): the Explore stack uses freezeOnBlur, so a blurred product
  // page must abort its in-flight query rather than run it to maxWait.
  useFocusEffect(
    useCallback(() => {
      if (!root) {
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
      setLoading(true);
      setError(false);
      queryCommentEvents(readRelays, root, { signal })
        .then((comments) => {
          if (superseded()) return;
          setEvents(comments);
          setLoading(false);
          // Then the kind-5s naming them (most relays already dropped what was
          // deleted; this covers the ones that kept it). Best-effort: a failed
          // lookup just keeps the previous deletions.
          return queryCommentDeletions(readRelays, [...comments, ...localAddedRef.current], {
            signal,
          }).then(
            (dels) => {
              if (!superseded()) setDeletions(dels);
            },
            () => undefined,
          );
        })
        .catch(() => {
          if (!superseded()) setError(true);
        })
        .finally(() => {
          if (!signal.aborted) setLoading(false);
        });
      return () => controller.abort();
      // `root` is memoised upstream; `rootRef` is the stable re-run trigger.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rootRef, readRelays, tick]),
  );

  const ancestry = useMemo(() => [...events, ...localAdded], [events, localAdded]);
  const visible = useMemo(
    () => reconcileComments(ancestry, deletions, localHidden),
    [ancestry, deletions, localHidden],
  );
  const thread = useMemo(
    () => (root ? threadedComments(visible, root, ancestry) : []),
    [visible, root, ancestry],
  );
  const topLevel = useMemo(
    () => thread.filter(({ depth }) => depth === 0).map(({ comment }) => comment),
    [thread],
  );
  const getDirectReplies = useCallback(
    (parentId: string) => directReplies(visible, parentId),
    [visible],
  );

  // `signal` is owned by the page's pull-to-refresh (aborted on its timeout
  // and on unmount).
  const refresh = useCallback(
    async (signal: AbortSignal) => {
      if (!root) return;
      const generation = ++generationRef.current;
      const loaded = loadedRef.current;
      // Same budget, signature and deletion reasoning as
      // useProductReviews.refresh.
      const opts = { signal, maxWait: 3000, verify: true };
      const comments = await queryCommentEvents(readRelays, root, {
        ...opts,
        since: refreshSince(loaded.events),
      });
      const dels = await queryCommentDeletions(
        readRelays,
        [...loaded.events, ...comments, ...localAddedRef.current],
        opts,
      ).catch(() => [] as NostrEvent[]);
      // A newer load or refresh started meanwhile — it owns the state.
      if (signal.aborted || generation !== generationRef.current) return;
      const merged = mergeFeedback(loadedRef.current, { events: comments, deletions: dels });
      // One batched update for the whole refresh (React batches these).
      setEvents(merged.events);
      setDeletions(merged.deletions);
      setError(false);
    },
    [root, readRelays],
  );

  // One setState per user action (never per relay event).
  const addLocally = useCallback((comment: NostrEvent) => {
    setLocalAdded((prev) => (prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]));
  }, []);
  const hideLocally = useCallback((id: string) => {
    setLocalHidden((prev) => new Set(prev).add(id));
    return () =>
      setLocalHidden((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
  }, []);

  return {
    allComments: visible,
    thread,
    topLevel,
    getDirectReplies,
    loading,
    error,
    refetch,
    refresh,
    addLocally,
    hideLocally,
  };
}
