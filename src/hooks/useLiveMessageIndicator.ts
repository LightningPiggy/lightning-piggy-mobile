import { useCallback, useEffect, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

/** Within this many px of the live edge counts as "at the edge". */
const EDGE_DISTANCE = 200;
/** Within this many px of the live edge, a jump to the newest has landed. */
const LANDED_DISTANCE = 4;
/** A jump to the newest re-aims every this-many ms until it lands… */
const SEEK_RETRY_MS = 400;
/** …for at most this long. */
const SEEK_MAX_MS = 2000;

export interface LiveMessageEntry {
  id: string;
  createdAt: number;
}

/** Follow the live edge, but let readers decide when to leave message history. */
export function useLiveMessageIndicator({
  scope,
  entries,
  loading = false,
  edge = 'start',
  scrollToLatest,
}: {
  scope: string;
  entries: readonly LiveMessageEntry[];
  loading?: boolean;
  edge?: 'start' | 'end';
  scrollToLatest: (animated: boolean) => void;
}) {
  const previous = useRef<{ scope: string; ids: Set<string>; newest: number } | null>(null);
  const activeScope = useRef(scope);
  const pendingScroll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nearEdge = useRef(true);
  // Until this time (ms) the list doesn't snap back to the live edge — set
  // while a jump into history is landing (see leaveEdge).
  const heldUntil = useRef(0);
  // Distance from the live edge at the last scroll event, and the timer that
  // re-checks it when a hold ends: a jump that lands at the edge sends no more
  // scroll events, so without a re-check the list would stay "away from the
  // edge" (arrow shown, new messages pill instead of following).
  const lastDistance = useRef<number | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A tap on jump-to-latest is still on its way down until this time (ms).
  // Rows mount (and get measured) as the list scrolls, so the end it aimed at
  // moves (a normal list's estimated content height; an inverted list's
  // anchored-content correction can cut the animation short). Until it lands,
  // scroll events on the way don't count as "left the edge", and the scroll
  // is re-aimed at the real edge — on content changes and on a retry timer.
  const seekUntil = useRef(0);
  const seekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A message arrived while away from the edge (the pill is showing).
  const arrivedAway = useRef(false);
  const clearHoldTimer = () => {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const stopSeeking = () => {
    seekUntil.current = 0;
    if (seekTimer.current !== null) clearTimeout(seekTimer.current);
    seekTimer.current = null;
  };
  const edgeRef = useRef(edge);
  edgeRef.current = edge;
  const scrollRef = useRef(scrollToLatest);
  scrollRef.current = scrollToLatest;
  const [atEdge, setAtEdge] = useState(true);
  const [hasNewMessages, setHasNewMessages] = useState(false);

  useEffect(() => {
    if (activeScope.current !== scope) {
      if (pendingScroll.current !== null) {
        clearTimeout(pendingScroll.current);
        pendingScroll.current = null;
      }
      activeScope.current = scope;
      previous.current = null;
      lastDistance.current = null;
      heldUntil.current = 0;
      clearHoldTimer();
      stopSeeking();
      nearEdge.current = true;
      setAtEdge(true);
      arrivedAway.current = false;
      setHasNewMessages(false);
    }
    if (loading) return;
    const old = previous.current;
    const newest = entries.reduce((max, entry) => Math.max(max, entry.createdAt), -Infinity);
    const changedScope = old?.scope !== scope;
    const arrived =
      !changedScope &&
      entries.some((entry) => !old.ids.has(entry.id) && entry.createdAt >= old.newest);
    previous.current = {
      scope,
      ids: new Set(entries.map((entry) => entry.id)),
      newest: changedScope ? newest : Math.max(newest, old!.newest),
    };
    if (changedScope) {
      nearEdge.current = true;
      setAtEdge(true);
      arrivedAway.current = false;
      setHasNewMessages(false);
      return;
    }
    if (!arrived) return;
    if (!nearEdge.current) {
      arrivedAway.current = true;
      setHasNewMessages(true);
      return;
    }
    if (pendingScroll.current !== null) clearTimeout(pendingScroll.current);
    pendingScroll.current = setTimeout(() => {
      pendingScroll.current = null;
      if (nearEdge.current) scrollRef.current(true);
    }, 50);
  }, [scope, entries, loading]);

  useEffect(
    () => () => {
      if (pendingScroll.current !== null) clearTimeout(pendingScroll.current);
      clearHoldTimer();
      stopSeeking();
    },
    [],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      const distance =
        edge === 'start'
          ? contentOffset.y
          : contentSize.height - layoutMeasurement.height - contentOffset.y;
      lastDistance.current = distance;
      if (distance <= LANDED_DISTANCE) stopSeeking();
      // A jump into history may pass near the edge on its way (an estimated
      // offset for a row not rendered yet): don't let that re-arm following.
      // A jump to the newest is still "at the edge" while on its way there.
      const near =
        Date.now() < seekUntil.current ||
        (distance < EDGE_DISTANCE && Date.now() >= heldUntil.current);
      nearEdge.current = near;
      setAtEdge((old) => (old === near ? old : near));
      if (near) {
        arrivedAway.current = false;
        setHasNewMessages(false);
      }
    },
    [edge],
  );

  const jumpToLatest = useCallback(() => {
    heldUntil.current = 0;
    clearHoldTimer();
    stopSeeking();
    nearEdge.current = true;
    setAtEdge(true);
    arrivedAway.current = false;
    setHasNewMessages(false);
    seekUntil.current = Date.now() + SEEK_MAX_MS;
    const retry = () => {
      seekTimer.current = null;
      const distance = lastDistance.current;
      if (distance === null || distance <= LANDED_DISTANCE) return stopSeeking();
      if (Date.now() >= seekUntil.current) {
        // Gave up (e.g. a scroll that can't reach the edge): report honestly.
        stopSeeking();
        const near = distance < EDGE_DISTANCE;
        nearEdge.current = near;
        setAtEdge(near);
        return;
      }
      scrollRef.current(false);
      seekTimer.current = setTimeout(retry, SEEK_RETRY_MS);
    };
    seekTimer.current = setTimeout(retry, SEEK_RETRY_MS);
    scrollRef.current(true);
  }, []);
  // The reader grabbed the list: a jump to the newest still on its way stops
  // there instead of fighting them for the scroll.
  const onScrollBeginDrag = useCallback(() => {
    if (Date.now() >= seekUntil.current) return;
    stopSeeking();
    const near = (lastDistance.current ?? 0) < EDGE_DISTANCE;
    nearEdge.current = near;
    setAtEdge(near);
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (nearEdge.current && Date.now() >= heldUntil.current) scrollRef.current(false);
  }, []);
  // The reader is being taken into history (the first unread, a mention):
  // stop following the live edge until they scroll back to it (#1295). For
  // `holdMs`, scrolling near the edge doesn't count — the jump is landing.
  const leaveEdge = useCallback((holdMs = 0) => {
    stopSeeking();
    heldUntil.current = holdMs > 0 ? Date.now() + holdMs : 0;
    if (pendingScroll.current !== null) {
      clearTimeout(pendingScroll.current);
      pendingScroll.current = null;
    }
    nearEdge.current = false;
    setAtEdge(false);
    clearHoldTimer();
    if (holdMs > 0) {
      // Where did the jump land? If at the edge (the first unread was close
      // to the bottom), the reader is following the live edge after all.
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        heldUntil.current = 0;
        // No scroll event since opening: an inverted list (edge 'start')
        // opens at the edge, and a jump to a row already on screen doesn't
        // move it, so it's still there.
        const distance = lastDistance.current ?? (edgeRef.current === 'start' ? 0 : null);
        if (distance === null || distance >= EDGE_DISTANCE) return;
        nearEdge.current = true;
        setAtEdge(true);
        setHasNewMessages(false);
        // Something arrived during the hold: bring it into view, since the
        // list kept the old rows anchored rather than following.
        if (arrivedAway.current) {
          arrivedAway.current = false;
          scrollRef.current(true);
        }
      }, holdMs);
    }
  }, []);
  return {
    atEdge,
    hasNewMessages,
    onScroll,
    onScrollBeginDrag,
    jumpToLatest,
    onContentSizeChange,
    leaveEdge,
  };
}
