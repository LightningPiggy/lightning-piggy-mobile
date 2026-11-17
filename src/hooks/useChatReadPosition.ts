import type { ListViewToken as ViewToken } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { useReadPositions } from './useReadPositions';
import { flushReadPositions, markConversationRead } from '../services/chatReadPositions';
import {
  advanceReadMarker,
  newestEntryMarker,
  unreadCount,
  unreadMentionIds,
  type ReadMarker,
  type UnreadEntry,
} from '../utils/chatUnread';
import { unreadDividerId } from '../utils/unreadDivider';

/** If the jump target never reports visible, start counting rows after this. */
const SETTLE_MAX_MS = 2500;
/** How long a jump into history keeps the list from snapping to the live edge. */
const JUMP_HOLD_MS = 1500;
/** After opening, messages that arrive this soon still count as unread-at-open. */
const LATE_ARRIVAL_MS = 4000;
// A row counts as seen when most of it is on screen — or, for a bubble taller
// than the screen, when it fills most of the screen.
const VIEWABILITY_CONFIGS = [
  { itemVisiblePercentThreshold: 60, minimumViewTime: 250 },
  { viewAreaCoveragePercentThreshold: 60, minimumViewTime: 250 },
];

/**
 * Where the viewer left off in an open chat (#1295), shared by the 1:1 and
 * group screens.
 *
 * - On open (once history and the stored position are both in), it snapshots
 *   the oldest unread message: the screen draws the "Unread messages" divider
 *   above it and the list jumps there instead of to the bottom.
 * - Rows the reader actually sees (FlatList viewability, while the screen is
 *   focused and the app active) move the position forward. The store
 *   coalesces the writes; the hook only re-renders when the position moves.
 * - It derives the unread count (the jump-to-latest badge) and the unread
 *   mentions, oldest first (the `@` button: each tap jumps to the next).
 *
 * `entries` are oldest-first and keyed like the FlatList rows.
 */
export function useChatReadPosition({
  owner,
  conversationKey,
  entries,
  loading,
  scrollToId,
  leaveEdge,
  initialTarget,
}: {
  owner: string | null;
  conversationKey: string | null;
  entries: readonly UnreadEntry[];
  loading: boolean;
  /** An explicit message tap takes priority over the unread-position jump. */
  initialTarget?: string;
  scrollToId: (id: string, animated?: boolean) => boolean;
  /** Stop the list following the live edge (so the jump isn't undone), and
   * ignore the edge for `holdMs` while the jump lands. */
  leaveEdge: (holdMs?: number) => void;
}) {
  const isFocused = useIsFocused();
  const getMarker = useReadPositions(owner);
  const scope = owner && conversationKey ? `${owner}:${conversationKey}` : null;

  const explicitScope = useRef<string | null>(null);
  if (initialTarget && scope) explicitScope.current = scope;
  // Keep the priority after the screen consumes its jump param, including late history.
  const explicitJump = explicitScope.current === scope && scope !== null;

  const [snapshot, setSnapshot] = useState<{ scope: string; dividerId: string | null } | null>(
    null,
  );
  const [marker, setMarker] = useState<ReadMarker | null>(null);
  const markerRef = useRef<ReadMarker | null>(null);
  const snapshotScope = useRef<string | null>(null);
  const snapshotMarker = useRef<ReadMarker | null>(null);
  const divider = useRef<string | null>(null);
  const openedAt = useRef(0);
  const settling = useRef(false);
  const jumpTarget = useRef<string | null>(null);
  // Latest on-screen ids per viewability config (see VIEWABILITY_CONFIGS).
  const lastViewable = useRef<string[][]>(VIEWABILITY_CONFIGS.map(() => []));
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const lateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // id → entry and id → oldest-first position (same-second ordering).
  const byId = useMemo(() => {
    const map = new Map<string, { entry: UnreadEntry; pos: number }>();
    entries.forEach((entry, pos) => map.set(entry.id, { entry, pos }));
    return map;
  }, [entries]);
  const latest = useRef({ byId, owner, conversationKey, isFocused, scrollToId, leaveEdge });
  latest.current = { byId, owner, conversationKey, isFocused, scrollToId, leaveEdge };

  const clearTimers = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  useEffect(() => {
    if (!initialTarget) return;
    clearTimers();
    settling.current = false;
    jumpTarget.current = null;
  }, [initialTarget, clearTimers]);

  // Advance the position to the newest row currently on screen.
  const applyViewable = useCallback((ids: readonly string[]) => {
    const { byId: index, owner: who, conversationKey: key, isFocused: focused } = latest.current;
    if (!who || !key || snapshotScope.current === null || settling.current || !focused) return;
    if (AppState.currentState !== 'active') return;
    const seen: UnreadEntry[] = [];
    for (const id of ids) {
      const hit = index.get(id);
      if (hit) seen.push(hit.entry);
    }
    const order = (id: string) => index.get(id)?.pos;
    const newest = newestEntryMarker(seen, order);
    if (!newest) return;
    const next = advanceReadMarker(markerRef.current, newest, order);
    if (next === markerRef.current) return;
    markerRef.current = next;
    setMarker(next);
    // Inside the late-arrival window the position is kept in memory only: an
    // older message may still land and move it back (see the snapshot effect).
    if (Date.now() - openedAt.current >= LATE_ARRIVAL_MS) markConversationRead(who, key, next);
  }, []);

  // Write the in-memory position to the store (end of the late window, leaving).
  const persistPosition = useCallback(() => {
    const { owner: who, conversationKey: key } = latest.current;
    if (who && key && markerRef.current && markerRef.current !== snapshotMarker.current) {
      markConversationRead(who, key, markerRef.current);
    }
  }, []);

  // `ids`: what the report that saw the target shows (other reports may be stale).
  const endSettling = useCallback(
    (ids?: readonly string[]) => {
      clearTimers();
      settling.current = false;
      jumpTarget.current = null;
      applyViewable(ids ?? [...new Set(lastViewable.current.flat())]);
    },
    [clearTimers, applyViewable],
  );

  // Jump to the first unread. Rows start counting as seen once the target
  // itself is on screen (rows passed on the way don't), or after SETTLE_MAX_MS.
  const jumpTo = useCallback(
    (dividerId: string) => {
      clearTimers();
      settling.current = true;
      jumpTarget.current = dividerId;
      latest.current.leaveEdge(JUMP_HOLD_MS);
      timers.current.push(
        setTimeout(() => latest.current.scrollToId(dividerId, false), 60),
        setTimeout(() => endSettling(), SETTLE_MAX_MS),
      );
    },
    [clearTimers, endSettling],
  );

  // Snapshot the stored position once per conversation, when both are ready.
  // Messages can still land just after opening (a relay top-up of what the
  // local store didn't have yet): for LATE_ARRIVAL_MS they're measured against
  // the snapshot too — an older unread one moves the divider (and the jump)
  // back to it — and the position is only written once the window closes.
  useEffect(() => {
    if (!scope || !conversationKey || loading) return;
    if (snapshotScope.current !== scope) {
      const stored = getMarker(conversationKey);
      if (!stored) return; // store still hydrating — `getMarker` changes when it lands
      clearTimers();
      snapshotScope.current = scope;
      snapshotMarker.current = stored;
      openedAt.current = Date.now();
      markerRef.current = stored;
      setMarker(stored);
      const dividerId = unreadDividerId(entries, stored, false);
      divider.current = dividerId;
      setSnapshot({ scope, dividerId });
      if (lateTimer.current) clearTimeout(lateTimer.current);
      lateTimer.current = setTimeout(persistPosition, LATE_ARRIVAL_MS);
      if (dividerId && !explicitJump) jumpTo(dividerId);
      return;
    }
    if (Date.now() - openedAt.current >= LATE_ARRIVAL_MS) return;
    const late = unreadDividerId(entries, snapshotMarker.current, false);
    if (!late || late === divider.current) return;
    const current = divider.current;
    const pos = (id: string) => entries.findIndex((entry) => entry.id === id);
    if (current !== null && pos(late) > pos(current)) return; // not older
    divider.current = late;
    setSnapshot({ scope, dividerId: late });
    markerRef.current = snapshotMarker.current;
    setMarker(snapshotMarker.current);
    if (!explicitJump) jumpTo(late);
  }, [
    scope,
    conversationKey,
    loading,
    getMarker,
    entries,
    clearTimers,
    jumpTo,
    persistPosition,
    explicitJump,
  ]);

  // Back on this screen: count what's on screen now; leaving it writes the
  // position straight away rather than waiting for the coalescing window.
  useEffect(() => {
    if (isFocused) applyViewable([...new Set(lastViewable.current.flat())]);
    else void flushReadPositions(owner);
  }, [isFocused, owner, applyViewable]);
  useEffect(
    () => () => {
      if (lateTimer.current) clearTimeout(lateTimer.current);
      persistPosition();
      void flushReadPositions(owner);
    },
    [owner, persistPosition],
  );

  // FlatList requires stable config/callback pairs; the handlers read refs.
  const handlersRef = useRef({ applyViewable, endSettling });
  handlersRef.current = { applyViewable, endSettling };
  const viewabilityConfigCallbackPairs = useRef(
    VIEWABILITY_CONFIGS.map((viewabilityConfig, slot) => ({
      viewabilityConfig,
      onViewableItemsChanged: ({ viewableItems }: { viewableItems: ViewToken[] }) => {
        const ids: string[] = [];
        for (const token of viewableItems) if (token.isViewable && token.key) ids.push(token.key);
        lastViewable.current[slot] = ids;
        if (settling.current && jumpTarget.current && ids.includes(jumpTarget.current)) {
          handlersRef.current.endSettling(ids);
        } else {
          handlersRef.current.applyViewable(ids);
        }
      },
    })),
  ).current;

  const live = snapshot?.scope === scope ? marker : null;
  const unread = useMemo(() => unreadCount(entries, live), [entries, live]);
  const pendingMentions = useMemo(() => unreadMentionIds(entries, live), [entries, live]);

  // Hide the opening boundary once read, retaining its ref so older backfill
  // can still reconcile during the late-arrival window. Newer messages alone
  // must not resurrect an already completed unread section.
  const visibleDividerId = unreadDividerId(
    entries,
    live,
    false,
    snapshot?.scope === scope ? snapshot.dividerId : null,
  );
  useEffect(() => {
    if (snapshot?.scope !== scope || !snapshot?.dividerId || unread > 0) return;
    setSnapshot({ scope: snapshot.scope, dividerId: null });
  }, [scope, snapshot, unread]);

  const jumpToNextMention = useCallback(() => {
    const id = pendingMentions[0];
    if (!id) return;
    latest.current.leaveEdge(JUMP_HOLD_MS);
    latest.current.scrollToId(id, true);
  }, [pendingMentions]);

  return {
    /** Opening boundary, stable while unread messages remain. */
    dividerId: visibleDividerId,
    unread,
    pendingMentions,
    jumpToNextMention,
    viewabilityConfigCallbackPairs,
  };
}
