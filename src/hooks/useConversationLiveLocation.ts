import { useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';
import { useLiveLocation } from '../contexts/LiveLocationContext';
import type { LiveLocationMarker } from '../services/liveLocationService';
import type { SharedLocation } from '../services/locationService';
import type { Item } from '../utils/conversationItems';
import type { RelayConfig } from '../types/nostr';
import { liveKey } from '../services/liveLocationUpdateStore';
import { nextLiveShareExpiry } from '../utils/liveShareExpiry';
import {
  useLiveUpdateRelaySubscriptions,
  useLiveUpdates,
  type WatchedShare,
} from './useLiveUpdates';

type LiveStatus = 'active' | 'paused' | 'ended' | 'expired' | undefined;

// Stabilise an object's identity across renders (#778). The status / remaining
// read-models below are rebuilt every 1 Hz `secondTick`, handing back a NEW
// Record each second even when nothing changed. That new reference flows into
// ConversationScreen's `renderItem` deps → a new `renderItem` → FlatList
// re-evaluates every visible row → every `ConversationMessageRow` (React.memo,
// shallow compare) re-renders once a second during a live share. Returning the
// PREVIOUS object when its content is unchanged (cheap JSON compare — these
// maps hold at most a handful of small entries) keeps `renderItem` stable, so
// only the countdown bubble's own row re-renders when its value actually moves.
export function useStableRecord<T extends object>(next: T): T {
  const prevRef = useRef<T>(next);
  if (JSON.stringify(next) === JSON.stringify(prevRef.current)) return prevRef.current;
  prevRef.current = next;
  return next;
}

/** One live-location marker in a thread, from whichever transport. */
export interface ThreadLiveMarker {
  fromMe: boolean;
  /** Hex pubkey of whoever sent the marker. */
  sender: string;
  marker: LiveLocationMarker;
  /** Message timestamp (unix seconds). */
  createdAt: number;
}

/**
 * Receive-side live-location plumbing for one thread — a 1:1 chat or a group
 * (#206, #1300). Transport-agnostic: coordinate updates come out of the
 * coalesced update store, fed by the Marmot listener (Marmot threads) or by
 * the relay subscriptions opened here (NIP-17 threads). Owns the per-session
 * status / remaining-ms read models the bubble renders, and a 1 Hz tick so
 * "Updated 30 s ago" labels animate without re-rendering on every update.
 */
export function useLiveLocationThread(params: {
  markers: ThreadLiveMarker[];
  /** Peer pubkey (1:1) or group id — where my own sessions are filed. */
  threadKey: string;
  marmot: boolean;
  isLoggedIn: boolean;
  myPubkey: string | null;
  signerType: string | null;
  relays: RelayConfig[];
}) {
  const { markers, threadKey, marmot, isLoggedIn, myPubkey, signerType, relays } = params;
  const { sessionsByRecipient, remainingMsForSession } = useLiveLocation();

  // Subscriptions + the 1 Hz tick only run while this thread is on screen.
  const focused = useIsFocused();

  // 1 Hz tick — re-reads `now` below so countdown / "x ago" labels stay live and expired sessions actually drop between updates.
  const [secondTick, setSecondTick] = useState(0);
  // ONE clock read per tick / marker change / focus change, shared by every
  // wall-clock decision below (watched, status, remaining, the tick gate) so
  // they can never disagree about whether a share has expired (#1792). Focus
  // is a dep so a share that expired while blurred shows ended on refocus.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the deps are the moments the clock must be re-read
  const now = useMemo(() => Date.now(), [secondTick, markers, focused]);

  // A session is (sender, sessionId): another group member re-using a session
  // id can't move or end someone else's share. Records are keyed `sender:id`;
  // the plain `id` key aliases the session's owner (for the 1:1 bubble, which
  // has no sender to hand) — my own start if I minted it, else the earliest.
  const { endedKeys, ownerOf } = useMemo(() => {
    const ended = new Set<string>();
    const owner = new Map<string, { sender: string; createdAt: number; mine: boolean }>();
    for (const m of markers) {
      const id = m.marker.sessionId;
      if (m.marker.phase === 'end') {
        ended.add(liveKey(m.sender, id));
        continue;
      }
      const cur = owner.get(id);
      if (!cur || (!cur.mine && (m.fromMe || m.createdAt < cur.createdAt))) {
        owner.set(id, { sender: m.sender, createdAt: m.createdAt, mine: m.fromMe });
      }
    }
    return { endedKeys: ended, ownerOf: owner };
  }, [markers]);

  // Inbound shares still running: a start from someone else, no end from its
  // sender yet, and inside its wall-clock window.
  const watched = useMemo<WatchedShare[]>(() => {
    const out: WatchedShare[] = [];
    for (const m of markers) {
      if (m.fromMe || m.marker.phase !== 'start') continue;
      if (endedKeys.has(liveKey(m.sender, m.marker.sessionId))) continue;
      if (now >= m.marker.startedAt + m.marker.durationMs) continue;
      out.push({
        sender: m.sender,
        sessionId: m.marker.sessionId,
        startedAt: m.marker.startedAt,
        ...(m.marker.updateKey ? { updateKey: m.marker.updateKey } : {}),
        // A v2 marker in a Marmot thread streams over MLS; a legacy one (an
        // older build) still sends NIP-04 pings, so keep the relay REQ for it.
        ...(marmot && m.marker.v2 ? { marmot: true } : {}),
      });
    }
    return out;
  }, [markers, endedKeys, marmot, now]);

  useLiveUpdateRelaySubscriptions({
    shares: watched,
    enabled: isLoggedIn && focused,
    myPubkey,
    signerType,
    relays,
  });
  // Read retained fixes for EVERY inbound start shown — not just running ones —
  // so a share that expires (or ends with a coordless end marker) keeps its
  // last position instead of snapping back to the start. Only the relay
  // subscriptions above are limited to active shares.
  const displayed = useMemo<WatchedShare[]>(
    () =>
      markers
        .filter((m) => !m.fromMe && m.marker.phase === 'start')
        .map((m) => ({
          sender: m.sender,
          sessionId: m.marker.sessionId,
          startedAt: m.marker.startedAt,
        })),
    [markers],
  );
  const updates = useLiveUpdates(displayed);

  /** Copy each owner's `sender:id` value onto the plain `id` key. */
  const aliasOwners = <T>(out: Record<string, T>) => {
    for (const [id, o] of ownerOf) {
      const v = out[liveKey(o.sender, id)];
      if (v !== undefined) out[id] = v;
    }
    return out;
  };

  // Per-session status the bubble renders: `ended` once its sender's end
  // marker arrives, otherwise the context's authoritative status for our own
  // shares, otherwise active/ended by wall-clock for inbound shares.
  const liveLocationBubbleStatusRaw = useMemo<Record<string, LiveStatus>>(() => {
    const out: Record<string, LiveStatus> = {};
    const mine = sessionsByRecipient.get(threadKey);
    for (const m of markers) {
      if (m.marker.phase !== 'start') continue;
      const key = liveKey(m.sender, m.marker.sessionId);
      if (endedKeys.has(key)) {
        out[key] = 'ended';
        continue;
      }
      const own = m.fromMe ? mine?.find((s) => s.sessionId === m.marker.sessionId) : undefined;
      if (own) {
        out[key] = own.status;
        continue;
      }
      const expiresAt = m.marker.startedAt + m.marker.durationMs;
      out[key] = now >= expiresAt ? 'ended' : 'active';
    }
    return aliasOwners(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aliasOwners only reads ownerOf
  }, [markers, endedKeys, ownerOf, sessionsByRecipient, threadKey, now]);
  const liveLocationBubbleStatus = useStableRecord(liveLocationBubbleStatusRaw);

  const liveLocationBubbleRemainingRaw = useMemo<Record<string, number | undefined>>(() => {
    const out: Record<string, number | undefined> = {};
    for (const m of markers) {
      if (m.marker.phase !== 'start') continue;
      // Sender path: the context's remaining-ms matches the tracker's clock.
      const fromCtx = m.fromMe ? remainingMsForSession(m.marker.sessionId) : null;
      out[liveKey(m.sender, m.marker.sessionId)] =
        fromCtx !== null ? fromCtx : Math.max(0, m.marker.startedAt + m.marker.durationMs - now);
    }
    return aliasOwners(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aliasOwners only reads ownerOf
  }, [markers, ownerOf, remainingMsForSession, now]);
  // NOTE: remaining-ms DOES change each second for an active share, so the
  // countdown bubble's own row still re-renders every tick (#778).
  const liveLocationBubbleRemaining = useStableRecord(liveLocationBubbleRemainingRaw);

  // Drive the 1 Hz tick only while focused AND some share is still running
  // (#1792) — ended / expired bubbles alone never tick. Re-evaluated on every
  // tick, so the tick that crosses the last expiry also stops it; a new start
  // marker changes `markers` and restarts it.
  const anyRunning = useMemo(() => nextLiveShareExpiry(markers, now) !== null, [markers, now]);
  const tick = anyRunning && focused;
  useEffect(() => {
    if (!tick) return;
    const id = setInterval(() => setSecondTick((n) => (n + 1) % 1000), 1000);
    return () => clearInterval(id);
  }, [tick]);

  // What the bubble plots: live updates while a share streams; once it ends,
  // its sender's end-marker coords (the final spot) win.
  const liveLocationLatest = useMemo(() => {
    const merged: Record<string, { location: SharedLocation; ts: number } | undefined> = {
      ...updates,
    };
    for (const m of markers) {
      if (m.marker.phase !== 'end' || !m.marker.location) continue;
      merged[liveKey(m.sender, m.marker.sessionId)] = {
        location: m.marker.location,
        ts: m.createdAt * 1000,
      };
    }
    return aliasOwners(merged);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- aliasOwners only reads ownerOf
  }, [markers, ownerOf, updates]);

  return { liveLocationLatest, liveLocationBubbleStatus, liveLocationBubbleRemaining };
}

// 1:1 ConversationScreen adapter (#206): pulls the classified live-location
// markers out of the thread's items. Extracted from the screen (#703 size cap).
export function useConversationLiveLocation(params: {
  items: Item[];
  isLoggedIn: boolean;
  myPubkey: string | null;
  pubkey: string;
  signerType: string | null;
  relays: RelayConfig[];
  marmot?: boolean;
}) {
  const { items, pubkey, myPubkey } = params;
  const markers = useMemo<ThreadLiveMarker[]>(() => {
    const out: ThreadLiveMarker[] = [];
    for (const it of items) {
      if (it.kind !== 'liveLocationMarker') continue;
      out.push({
        fromMe: it.fromMe,
        sender: it.fromMe ? (myPubkey ?? '') : pubkey,
        marker: it.marker,
        createdAt: it.createdAt,
      });
    }
    return out;
  }, [items, myPubkey, pubkey]);
  // Same items array → same markers; keep the reference stable across renders
  // that rebuild `items` without touching a live marker.
  const stableMarkers = useStableRecord(markers);
  return useLiveLocationThread({
    ...params,
    markers: stableMarkers,
    threadKey: pubkey,
    marmot: params.marmot ?? false,
  });
}
