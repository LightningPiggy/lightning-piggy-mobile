import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { useCoalescedMap } from '../utils/useCoalescedMap';
import { sortFeed } from '../utils/profileFeedRows';
import {
  applyFeedPage,
  cursorOf,
  hasAnyCursor,
  isStuckPage,
  newFeedCursors,
  noteFeedEvent,
  outboxSource,
  pageableSources,
  reopenFeedCursors,
  VIEWER_SOURCE,
  type FeedSource,
} from '../utils/feedCursors';
import { COMMENT_KIND, isNoteComment } from '../utils/nip22';
import {
  AUTHOR_FEED_PAGE_SIZE,
  fetchAuthorFeedPage,
  subscribeAuthorFeed,
  subscribeAuthorOutboxFeed,
  type AuthorFeedEvent,
} from '../services/authorFeedService';
import { AUTHOR_FEED_MAX_PAGES as MAX_PAGES } from '../services/authorFeedLimits';
import { isOutboxRelayQuarantined } from '../services/authorOutboxRelays';

/** Grace before an author with no events shows the empty state. */
const FIRST_EVENT_GRACE_MS = 6000;

/**
 * One author's profile feed (notes, note comments, picture / video events)
 * for the profile page's Posts and Media tabs. One subscription serves both
 * tabs, armed only
 * while the screen is focused. Events land through `useCoalescedMap`, so a
 * relay backfill commits a few batched updates instead of a setState per
 * event. `loadMore` pages backwards with a bounded `until` query.
 *
 * The feed is the union of the viewer's read relays and the author's own
 * NIP-65 write relays (#1390). The viewer's relays are subscribed at once;
 * the author's relays join in the background once known (capped, see
 * services/authorOutboxRelays), so they never hold up the first posts. Each
 * relay set pages from its own cursor and ends on its own (utils/feedCursors).
 */
export function useProfileFeed(authorPubkey: string | null, reloadNonce: number) {
  const { relays, dmInboxRelays } = useNostr();
  // The viewer's own DM inbox relays are never leased as author relays (their
  // live DM sub must never share a budgeted outbox socket). Read when armed.
  const dmInboxRef = useRef<readonly string[]>(dmInboxRelays ?? []);
  useEffect(() => {
    dmInboxRef.current = dmInboxRelays ?? [];
  }, [dmInboxRelays]);
  // Stable on the read-relay URL set, so a fresh `relays` array with the same
  // URLs doesn't tear the subscription down.
  const readRelaysKey = useMemo(
    () =>
      relays
        .filter((r) => r.read)
        .map((r) => r.url)
        .sort()
        .join('|'),
    [relays],
  );
  const readRelays = useMemo(
    () => (readRelaysKey ? readRelaysKey.split('|') : []),
    [readRelaysKey],
  );

  const feed = useCoalescedMap<AuthorFeedEvent>({ flushMs: 150 });
  const { reset, enqueue, flush } = feed;
  const [loading, setLoading] = useState(true);
  // No relay has answered yet (all failed, or none replied within the grace
  // period): the profile says it couldn't load posts rather than "no posts".
  const [unavailable, setUnavailable] = useState(false);
  // The author whose feed last got a real relay answer (see the focus effect).
  const answeredAuthorRef = useRef<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reachedEnd, setReachedEndState] = useState(false);
  const reachedEndRef = useRef(false);
  const setReachedEnd = useCallback((value: boolean) => {
    reachedEndRef.current = value;
    setReachedEndState(value);
  }, []);
  // Per relay set: its oldest event and whether it's at its end (#1390).
  const cursorsRef = useRef(newFeedCursors());
  const pagesRef = useRef(0);
  const loadingMoreRef = useRef(false);
  const moreAbortRef = useRef<AbortController | null>(null);
  // True only while the screen is focused. A blur aborts any page request
  // and keeps `loadMore` a no-op until the next focus, so nothing (e.g. the
  // screen's auto-paging re-arming after the aborted request settles) can
  // query relays behind another screen.
  const focusedRef = useRef(false);
  // The author's own relays the live feed added (#1390), so older pages ask them too.
  const outboxRelaysRef = useRef<string[]>([]);

  // A different person starts from scratch. Refocusing, or a pull-to-refresh,
  // keeps what's loaded (and the scroll position) and merges new events in.
  useEffect(() => {
    reset();
    pagesRef.current = 0;
    cursorsRef.current = newFeedCursors();
    setReachedEnd(false);
    setLoading(true);
    setUnavailable(false);
  }, [authorPubkey, reset, setReachedEnd]);

  // Pull-to-refresh re-opens paging, so an end reached during a relay outage
  // can be retried once the relay is back.
  useEffect(() => {
    pagesRef.current = 0;
    reopenFeedCursors(cursorsRef.current);
    setReachedEnd(false);
  }, [reloadNonce, setReachedEnd]);

  // A different set of read relays is a new viewer source: its cursor starts
  // again from the new subscription's events (declared before the focus
  // effect, so it runs first), and paging re-opens.
  useEffect(() => {
    cursorsRef.current.delete(VIEWER_SOURCE);
    // A fresh per-visit page budget too, or a new source after 10 pages is never asked.
    pagesRef.current = 0;
    if (reachedEndRef.current) setReachedEnd(false);
  }, [readRelays, setReachedEnd]);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      outboxRelaysRef.current = [];
      if (!authorPubkey || readRelays.length === 0) {
        setLoading(false);
        return;
      }
      // A closed subscription can still deliver a few in-flight events. Drop
      // them, so one person's posts never land on the next profile shown in
      // this (reused) screen.
      let live = true;
      let answered = false;
      // The author's own relays answered: the viewer's relays all failing then
      // doesn't make the feed "couldn't load".
      let outboxAnswered = false;
      // After a failure, a new attempt (refocus, pull-to-refresh) shows the
      // spinner, never "No posts yet" while it's still unanswered. After a
      // real answer for this author, keep showing it while re-subscribing:
      // no spinner flash on every refocus of a profile with no posts.
      if (answeredAuthorRef.current !== authorPubkey) {
        setUnavailable(false);
        setLoading(true);
      }
      // Sources: the viewer's relays together; each author relay on its own.
      const onEvent = (source: FeedSource, event: AuthorFeedEvent) => {
        if (!live) return;
        // A source's first event opens its paging, even after the others ended.
        if (noteFeedEvent(cursorsRef.current, source, event.created_at) && reachedEndRef.current)
          setReachedEnd(false);
        // Once per attempt, not per event (CLAUDE.md: no setState per relay event).
        if (!answered) {
          answered = true;
          answeredAuthorRef.current = authorPubkey;
          setUnavailable(false);
        }
        enqueue(event.id, event);
      };
      // One relay really answered: when the grace period ends with no
      // posts, that's "No posts yet", even if another relay is still silent.
      const onAnswered = () => {
        if (!live) return;
        answered = true;
        answeredAuthorRef.current = authorPubkey;
        setUnavailable(false);
      };
      const unsubscribe = subscribeAuthorFeed({
        authorPubkey,
        relays: readRelays,
        limit: AUTHOR_FEED_PAGE_SIZE,
        onEvent: (event) => onEvent(VIEWER_SOURCE, event),
        // Every relay is done, but that includes relays that failed or timed
        // out: only onEvent / onAnswered count as an answer.
        onEose: () => {
          if (!live) return;
          flush();
          setLoading(false);
        },
        onAnswered,
        onUnavailable: () => {
          if (!live) return;
          if (outboxAnswered) {
            setLoading(false);
            return;
          }
          // A late event or answer after this must clear the error again.
          answered = false;
          answeredAuthorRef.current = null;
          setUnavailable(true);
          setLoading(false);
        },
      });
      // Armed after the viewer's relays, and resolved in the background: the
      // author's own relays merge into the same coalesced map when they land.
      const unsubscribeOutbox = subscribeAuthorOutboxFeed({
        authorPubkey,
        currentRelays: readRelays,
        excludeRelays: [...dmInboxRef.current],
        limit: AUTHOR_FEED_PAGE_SIZE,
        onEvent: (event, relay) => {
          if (live) outboxAnswered = true;
          onEvent(outboxSource(relay), event);
        },
        onAnswered: () => {
          if (live) outboxAnswered = true;
          onAnswered();
        },
        onRelays: (urls) => {
          if (!live) return;
          const before = new Set(outboxRelaysRef.current);
          outboxRelaysRef.current = urls;
          // Only NEWLY found author relays re-open paging: a shrink (a relay
          // dropped) must not re-open relays that legitimately ended.
          const added = urls.filter((url) => !before.has(url)).map(outboxSource);
          const reopened = added.length > 0 && reopenFeedCursors(cursorsRef.current, added);
          if (reopened && reachedEndRef.current) setReachedEnd(false);
        },
      });
      const grace = setTimeout(() => {
        if (!answered) {
          answeredAuthorRef.current = null;
          setUnavailable(true);
        }
        setLoading(false);
      }, FIRST_EVENT_GRACE_MS);
      return () => {
        live = false;
        focusedRef.current = false;
        clearTimeout(grace);
        unsubscribe();
        unsubscribeOutbox();
        outboxRelaysRef.current = [];
        flush();
        moreAbortRef.current?.abort();
      };
      // `reloadNonce` is deliberately a dependency: pull-to-refresh bumps it
      // to re-open the subscription and re-query relays for new posts.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authorPubkey, readRelays, reloadNonce, enqueue, flush, setReachedEnd]),
  );

  // Belt and braces for the same guarantee: only this author's events.
  const fetched = useMemo(
    () => sortFeed([...feed.map.values()].filter((e) => e.pubkey === authorPubkey)),
    [feed.map, authorPubkey],
  );
  // Kind-1111 comments only show when they reply inside a kind-1 note's
  // thread (#1337); product / Piglet comments stay hidden. They still count
  // for the paging cursors, so a page of them can't stall `loadMore`.
  const events = useMemo(
    () => fetched.filter((e) => e.kind !== COMMENT_KIND || isNoteComment(e)),
    [fetched],
  );
  const loadMore = useCallback(async () => {
    if (!focusedRef.current) return;
    if (!authorPubkey || loadingMoreRef.current || reachedEndRef.current) return;
    if (pagesRef.current >= MAX_PAGES) {
      setReachedEnd(true);
      return;
    }
    const cursors = cursorsRef.current;
    // The viewer's relays page together; each author relay pages on its own.
    // Sources with relays NOW (author relays can be dropped mid-load).
    const currentCandidates = () => [
      ...(readRelays.length > 0 ? [VIEWER_SOURCE] : []),
      ...outboxRelaysRef.current.map(outboxSource),
    ];
    const relaysBySource = new Map<FeedSource, string[]>();
    if (readRelays.length > 0) relaysBySource.set(VIEWER_SOURCE, readRelays);
    for (const url of outboxRelaysRef.current) relaysBySource.set(outboxSource(url), [url]);
    const sources = pageableSources(cursors, currentCandidates());
    if (sources.length === 0) {
      if (hasAnyCursor(cursors)) setReachedEnd(true);
      return;
    }
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const controller = new AbortController();
    moreAbortRef.current = controller;
    const { signal } = controller;
    const known = (e: AuthorFeedEvent) => feed.map.has(e.id);
    const merge = (events: readonly AuthorFeedEvent[]) => {
      for (const e of events) if (!known(e)) enqueue(e.id, e);
    };
    // Each source from its own cursor. `until` is inclusive: events sharing
    // the oldest second come back too and the id-keyed map drops the repeats.
    // If a whole page is stuck on that one second, step past it rather than
    // stall — merging that first page AS SOON AS it arrives, since it can hold
    // unseen posts whatever happens to the step request.
    // An author relay dropped (revoked, flooded) or quarantined meanwhile is
    // never asked again: a request would open a fresh, unleased socket to it.
    const usable = (source: FeedSource, relays: readonly string[]) =>
      source === VIEWER_SOURCE ||
      (outboxRelaysRef.current.includes(relays[0]) && !isOutboxRelayQuarantined(relays[0]));
    const pageSource = async (source: FeedSource) => {
      const from = cursorOf(cursors, source).oldest!;
      const relays = relaysBySource.get(source)!;
      const nothing = { source, from, page: { events: [] as AuthorFeedEvent[], complete: false } };
      if (!usable(source, relays)) return nothing;
      const first = await fetchAuthorFeedPage({ authorPubkey, relays, until: from, signal });
      if (signal.aborted || !isStuckPage(first.events, from, AUTHOR_FEED_PAGE_SIZE)) {
        return { source, from, page: first };
      }
      merge(first.events);
      if (!usable(source, relays)) return { ...nothing, page: { ...first, complete: false } };
      try {
        const next = await fetchAuthorFeedPage({ authorPubkey, relays, until: from - 1, signal });
        const page = { events: [...first.events, ...next.events], complete: next.complete };
        return { source, from, page };
      } catch {
        // Keep the boundary page; the step is retried on the next load.
        return { source, from, page: { events: first.events, complete: false } };
      }
    };
    try {
      const results = await Promise.allSettled(sources.map(pageSource));
      if (signal.aborted || !focusedRef.current) return;
      // Every source's relays failed — leave "Load more" available to retry.
      if (results.every((r) => r.status === 'rejected')) return;
      pagesRef.current += 1;
      for (const result of results) {
        if (result.status !== 'fulfilled') continue;
        const { source, from, page } = result.value;
        // Only a complete answer with nothing older ends a source; a timeout
        // leaves it available to retry.
        applyFeedPage(cursorOf(cursors, source), from, page);
        merge(page.events);
      }
      flush();
      if (pageableSources(cursors, currentCandidates()).length === 0) setReachedEnd(true);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [authorPubkey, readRelays, feed.map, enqueue, flush, setReachedEnd]);

  return {
    events,
    /** Every fetched event, hidden ones included — what paging depends on. */
    fetchedCount: fetched.length,
    loading,
    unavailable,
    loadingMore,
    reachedEnd,
    loadMore,
    hasRelays: readRelays.length > 0,
  };
}
