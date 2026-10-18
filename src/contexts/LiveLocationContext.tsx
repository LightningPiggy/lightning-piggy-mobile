import { enabledAppRelays } from '../services/appRelayPrefs';
/**
 * Sender-side live-location share orchestrator (#206, #1300). Owns:
 *
 *   - the state machine (active / paused / expired / ended) + persistence
 *   - the start / end markers — tagged chat messages every client renders
 *     (see liveLocationWire.ts), sent over the chat's own transport: NIP-17,
 *     a Marmot 1:1, or a Marmot group
 *   - wiring the GPS tracker (background updates, foreground fallback) to the
 *     per-session update dispatcher
 *   - the Android "Stop sharing" notification, and stop on expiry / account
 *     switch / sign-out
 *
 * Coordinate updates never touch the user's signer: Marmot updates are MLS
 * application messages, NIP-17 updates are signed by a per-session key
 * (liveLocationSender.ts) — so shares keep running in the background for
 * nsec, Amber and NIP-46 users alike.
 *
 * The receiver side lives in the thread hooks (useLiveLocationThread) and
 * the coalesced update store; the Marmot update listener is armed here, once
 * per signed-in account.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as nostrService from '../services/nostrService';
import { useNostr } from './NostrContext';
import type { DmProtocol } from '../utils/dmProtocol';
import { formatTime } from '../utils/messageContent';
import { MAX_DURATION_MS, expiryFor, newSessionId } from '../services/liveLocationService';
import {
  liveMarkerDraft,
  liveMarkerTags,
  liveMarkerTextForRumor,
  type LiveMarkerWire,
} from '../services/liveLocationWire';
import { getCurrentLocation, type SharedLocation } from '../services/locationService';
import { loadPersistedSessions, savePersistedSessions } from '../services/liveLocationStorage';
import { reduce, remainingMs, type OutgoingSession } from '../services/liveLocationStateMachine';
import { transportFor } from '../services/liveLocationPolicy';
import { newLiveUpdateChannel } from '../services/nostrLiveLocation';
import {
  deleteUpdateChannel,
  saveUpdateChannel,
  sendLiveUpdate,
  sendMarmotGroupMarker,
} from '../services/liveLocationSender';
import {
  getTrackingMode,
  liveUpdateDispatcher,
  reapOrphanedService,
  setLiveLocationFixHandler,
  startTracking,
  stopTracking,
} from '../services/liveLocationTracker';
import {
  dismissLiveShareNotification,
  isLiveShareStopResponse,
  liveShareNotificationText,
  showLiveShareNotification,
} from '../services/liveLocationNotification';
import { clearLiveUpdates } from '../services/liveLocationUpdateStore';
import { startMarmotLiveLocationReceiver } from '../services/marmotLiveLocationReceiver';

/** Where a share goes: a 1:1 chat (NIP-17 or Marmot) or a Marmot group. */
export type LiveShareTarget =
  | { kind: 'dm'; recipientPubkey: string; protocol?: DmProtocol; label?: string }
  | { kind: 'group'; groupId: string; label?: string };

export type LiveShareStartResult =
  // `markerText` is the stored form of the published marker, so the screen's optimistic bubble dedupes byte-for-byte against the echo.
  | { ok: true; sessionId: string; location: SharedLocation; markerText: string }
  | { ok: false; error: string };

export type LiveShareStopResult = { ok: true } | { ok: false; error: string };

export interface LiveLocationContextValue {
  /** Thread key (peer pubkey, or group id) → sessions (typically 0 or 1). */
  sessionsByRecipient: Map<string, OutgoingSession[]>;
  /** Start a new live share: one GPS fix, the start marker, then tracking. */
  startShare: (target: LiveShareTarget, durationMs: number) => Promise<LiveShareStartResult>;
  /** Stop an in-progress share: publishes the end marker, ends the session. */
  stopShare: (sessionId: string) => Promise<LiveShareStopResult>;
  /** Cheap convenience for the conversation header / bubble. */
  hasActiveShareWith: (threadKey: string) => boolean;
  /** Best-effort remaining lifetime — `null` when no session matches. */
  remainingMsForSession: (sessionId: string) => number | null;
}

const LiveLocationContext = createContext<LiveLocationContextValue | undefined>(undefined);

export function useLiveLocation(): LiveLocationContextValue {
  const ctx = useContext(LiveLocationContext);
  if (!ctx) {
    throw new Error('useLiveLocation must be used within a LiveLocationProvider');
  }
  return ctx;
}

/** A fix younger than this stands in for a fresh one on stop (no GPS request). */
const FRESH_FIX_MS = 60_000;

export const LiveLocationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { pubkey, isLoggedIn, signerType, relays, sendDirectRumor } = useNostr();
  const [sessions, setSessions] = useState<Map<string, OutgoingSession>>(() => new Map());

  // Mirror state into a ref so the fix handler / ticks read the current map
  // without re-binding every render.
  const sessionsRef = useRef(sessions);
  // The account whose stored shares have been read into `sessions`. Persisting
  // before that would overwrite them — on an account switch the first render
  // still holds the previous account's map.
  const hydratedForRef = useRef<string | null>(null);
  useEffect(() => {
    sessionsRef.current = sessions;
    // Best-effort persist on every transition, scoped to the active identity
    // so an account switch can't resume these under another key.
    if (pubkey && hydratedForRef.current === pubkey) {
      void savePersistedSessions(
        pubkey,
        [...sessions.values()].filter((s) => s.senderPubkey === pubkey),
      );
    }
  }, [sessions, pubkey]);

  const dispatch = useCallback((action: Parameters<typeof reduce>[1]) => {
    setSessions((prev) => reduce(prev, action));
  }, []);

  // Freshest fix the tracker delivered (end-marker fallback) + start fixes.
  const lastFixRef = useRef<{ location: SharedLocation; at: number } | null>(null);
  // Shares being stopped: excluded from updates before their state commits.
  const stoppingRef = useRef<Set<string>>(new Set());
  const stopInFlightRef = useRef<Set<string>>(new Set());
  const startLocationRef = useRef<Map<string, SharedLocation>>(new Map());

  // Account switch / sign-out: stop sharing now. The departing account's
  // unfinished shares are persisted with `stopRequested`, so its next hydrate
  // sends their end markers instead of resuming them.
  const lastIdentityRef = useRef<string | null>(pubkey ?? null);
  useEffect(() => {
    const current = isLoggedIn ? (pubkey ?? null) : null;
    const previous = lastIdentityRef.current;
    if (previous === current) return;
    lastIdentityRef.current = current;
    hydratedForRef.current = null;
    // First identity on a cold start: nothing to stop (a background share may
    // be running and is picked up by the hydrate below).
    if (!previous) return;
    const leftover = [...sessionsRef.current.values()].filter((s) => s.status !== 'ended');
    if (leftover.length > 0) {
      void savePersistedSessions(
        previous,
        leftover.map((s) => ({ ...s, stopRequested: true })),
      );
      for (const s of leftover) void deleteUpdateChannel(s.sessionId);
    }
    liveUpdateDispatcher.reset();
    clearLiveUpdates();
    void stopTracking();
    void dismissLiveShareNotification();
    setSessions(new Map());
  }, [pubkey, isLoggedIn]);

  // Marmot coordinate updates from peers → the coalesced update store.
  useEffect(() => {
    if (!pubkey || !isLoggedIn) return;
    return startMarmotLiveLocationReceiver(pubkey);
  }, [pubkey, isLoggedIn]);

  const writeRelays = useMemo(
    () =>
      Array.from(
        new Set([
          ...relays.filter((r) => r.write).map((r) => r.url),
          ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS),
        ]),
      ),
    [relays],
  );
  const writeRelaysRef = useRef(writeRelays);
  useEffect(() => {
    writeRelaysRef.current = writeRelays;
  }, [writeRelays]);

  // ---- Markers -------------------------------------------------------------

  // Start / end markers: a tagged chat message on the chat's own transport.
  // 1:1 (NIP-17 or Marmot) goes through the signer-aware DM seam; a Marmot
  // group through the group's MLS session.
  const sendMarker = useCallback(
    async (session: OutgoingSession, wire: LiveMarkerWire): Promise<boolean> => {
      if (!pubkey) return false;
      const draft = liveMarkerDraft(wire);
      if (session.groupId) return sendMarmotGroupMarker(pubkey, session.groupId, draft);
      const result = await sendDirectRumor(
        [session.recipientPubkey],
        {
          kind: draft.kind,
          created_at: Math.floor(Date.now() / 1000),
          // The p tag also makes the rumor id recipient-specific.
          tags: [...draft.tags, ['p', session.recipientPubkey]],
          content: draft.content,
          pubkey,
        },
        { protocol: transportFor(session) },
      );
      return result.success;
    },
    [pubkey, sendDirectRumor],
  );

  // ---- Lifecycle: start / stop ------------------------------------------

  const startShare = useCallback(
    async (target: LiveShareTarget, durationMs: number): Promise<LiveShareStartResult> => {
      if (!pubkey || !isLoggedIn) return { ok: false, error: 'Not logged in' };
      const fix = await getCurrentLocation();
      if (!fix.ok) return { ok: false, error: fix.message };
      const sessionId = newSessionId();
      const now = Date.now();
      const cappedDurationMs = Math.max(0, Math.min(MAX_DURATION_MS, durationMs));
      const groupId = target.kind === 'group' ? target.groupId : undefined;
      const protocol =
        groupId || (target.kind === 'dm' && target.protocol === 'marmot')
          ? ('marmot' as const)
          : undefined;
      const installed: OutgoingSession = {
        sessionId,
        senderPubkey: pubkey,
        recipientPubkey: target.kind === 'group' ? target.groupId : target.recipientPubkey,
        startedAt: now,
        durationMs: cappedDurationMs,
        lastPingAt: null,
        status: 'active',
        startMarkerSent: false,
        endMarkerSent: false,
        ...(protocol ? { protocol } : {}),
        ...(groupId ? { groupId } : {}),
        ...(target.label ? { label: target.label } : {}),
        wire: 2,
      };
      // NIP-17 only: a per-session update channel, announced in the marker.
      const channel = protocol ? null : newLiveUpdateChannel();
      if (channel) await saveUpdateChannel(sessionId, channel);
      // Install optimistically so the bubble renders while the marker publishes.
      dispatch({ type: 'start', ...installed, now });
      // Start tracking NOW, while the app is certainly in front: Android won't
      // start the location service from the background, and the user may leave
      // the app before the marker has published (the effect below adopts it).
      void startTracking({ owner: pubkey, relays: writeRelaysRef.current }).catch(() => undefined);
      startLocationRef.current.set(sessionId, fix.location);
      const wire: LiveMarkerWire = {
        phase: 'start',
        sessionId,
        startedAt: now,
        durationMs: cappedDurationMs,
        location: fix.location,
        ...(channel ? { updateKey: { pubkey: channel.pubkey, secret: channel.secret } } : {}),
      };
      if (!(await sendMarker(installed, wire))) {
        // Roll back — nobody was told, so nothing to stream to.
        dispatch({ type: 'stop', sessionId });
        startLocationRef.current.delete(sessionId);
        if (channel) void deleteUpdateChannel(sessionId);
        return { ok: false, error: 'Failed to send live-location start marker.' };
      }
      dispatch({ type: 'startMarkerSent', sessionId });
      // The start marker carried this fix: measure the cadence from it.
      liveUpdateDispatcher.seed(sessionId, fix.location, now);
      return {
        ok: true,
        sessionId,
        location: fix.location,
        // Stored text exactly as the echo will produce it (via the wire tags).
        markerText: liveMarkerTextForRumor({ kind: 14, tags: liveMarkerTags(wire) }) ?? '',
      };
    },
    [pubkey, isLoggedIn, dispatch, sendMarker],
  );

  const stopShare = useCallback(
    async (sessionId: string): Promise<LiveShareStopResult> => {
      const session = sessionsRef.current.get(sessionId);
      if (!session) return { ok: false, error: 'Session not found' };
      if (session.status === 'ended') return { ok: true };
      // One end marker at a time per share (the drain loop retries too).
      if (stopInFlightRef.current.has(sessionId)) return { ok: true };
      stopInFlightRef.current.add(sessionId);
      // Stop streaming NOW, and persist that (stopRequested) before the slow
      // part — the final fix and the end marker — so neither a fix arriving
      // meanwhile nor a restart / the headless tracker resumes it. A failed
      // end marker stays retryable: the drain loop below re-sends it.
      stoppingRef.current.add(sessionId);
      dispatch({ type: 'stopPending', sessionId });
      try {
        // Final position for the end marker: a fresh tracker fix if we have
        // one (no extra GPS request — this may run in the background), else a
        // new fix, else the start location; never a fabricated 0,0 pin.
        const recent = lastFixRef.current;
        let finalLocation: SharedLocation | null =
          recent && Date.now() - recent.at < FRESH_FIX_MS ? recent.location : null;
        if (!finalLocation) {
          const fix = await getCurrentLocation();
          finalLocation = fix.ok
            ? fix.location
            : (recent?.location ?? startLocationRef.current.get(sessionId) ?? null);
        }
        const sent = await sendMarker(session, {
          phase: 'end',
          sessionId,
          startedAt: session.startedAt,
          durationMs: session.durationMs,
          location: finalLocation,
        });
        if (!sent) return { ok: false, error: 'Failed to send live-location end marker.' };
        dispatch({ type: 'endMarkerSent', sessionId });
        dispatch({ type: 'stop', sessionId });
        startLocationRef.current.delete(sessionId);
        stoppingRef.current.delete(sessionId);
        liveUpdateDispatcher.forget(sessionId);
        void deleteUpdateChannel(sessionId);
        return { ok: true };
      } finally {
        stopInFlightRef.current.delete(sessionId);
      }
    },
    [dispatch, sendMarker],
  );
  const stopShareRef = useRef(stopShare);
  useEffect(() => {
    stopShareRef.current = stopShare;
  }, [stopShare]);

  // ---- Fixes → updates -------------------------------------------------

  // The tracker hands every fix here while mounted; the shared dispatcher
  // applies the cadence + in-flight rules and sends per transport. No React
  // state changes per fix.
  useEffect(() => {
    if (!pubkey) return;
    const owner = pubkey;
    setLiveLocationFixHandler((fix) => {
      lastFixRef.current = { location: fix.location, at: Date.now() };
      const live = [...sessionsRef.current.values()].filter(
        (s) => !stoppingRef.current.has(s.sessionId),
      );
      // Returned so the background task waits for the sends to finish.
      return liveUpdateDispatcher.handleFix(fix, live, (s, p) =>
        sendLiveUpdate(owner, s, p, writeRelaysRef.current),
      );
    });
    // Unmounting (e.g. the UI was destroyed) leaves tracking running: the
    // tracker's headless path takes over until the share ends.
    return () => setLiveLocationFixHandler(null);
  }, [pubkey]);

  // Derived: does ANY session still stream? The tracking effect keys off this
  // (and the notification text), not the whole Map, so state churn can't race
  // a second tracker start (#759).
  const activeSessions = useMemo(
    () => [...sessions.values()].filter((s) => s.status === 'active'),
    [sessions],
  );
  const activeKey = activeSessions.map((s) => `${s.sessionId}:${s.label ?? ''}`).join('|');

  useEffect(() => {
    if (!pubkey) return;
    const active = [...sessionsRef.current.values()].filter((s) => s.status === 'active');
    if (active.length === 0) {
      void stopTracking().then(() =>
        AppState.currentState === 'active' ? reapOrphanedService() : undefined,
      );
      void dismissLiveShareNotification();
      return;
    }
    let cancelled = false;
    void (async () => {
      const mode = await startTracking({ owner: pubkey, relays: writeRelaysRef.current });
      // The Stop notification only makes sense while sharing survives the
      // background (a foreground-only share pauses there).
      if (cancelled || mode !== 'background') return;
      const { title, body } = liveShareNotificationText(
        active.map((s) => ({
          label: s.label,
          groupId: s.groupId,
          expiresAt: expiryFor(s.startedAt, s.durationMs),
        })),
        (ms) => formatTime(Math.floor(ms / 1000)),
      );
      const [only] = active;
      await showLiveShareNotification({
        title,
        body,
        ...(active.length === 1
          ? {
              route: only.groupId
                ? { kind: 'group' as const, groupId: only.groupId }
                : { kind: 'dm' as const, conversationPubkey: only.recipientPubkey },
            }
          : {}),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [activeKey, pubkey]);

  // "Stop sharing" pressed on the notification (the app stays in the background).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      if (!isLiveShareStopResponse(response)) return;
      for (const s of sessionsRef.current.values()) {
        if (s.status === 'active' || s.status === 'paused') void stopShareRef.current(s.sessionId);
      }
      void dismissLiveShareNotification();
    });
    return () => sub.remove();
  }, []);

  // ---- Expiry tick + end-marker drain ----------------------------------

  useEffect(() => {
    const id = setInterval(() => {
      dispatch({ type: 'tickExpiryCheck', now: Date.now() });
      const foreground = AppState.currentState === 'active';
      for (const session of sessionsRef.current.values()) {
        if (session.status !== 'expired' || session.endMarkerSent) continue;
        // A NIP-17 end marker is a real DM: with a remote signer it needs the
        // app in front (Amber / a bunker can't prompt from the background), so
        // it waits; Marmot and nsec markers go now.
        if (!foreground && transportFor(session) === 'nip17' && signerType !== 'nsec') continue;
        void stopShareRef.current(session.sessionId);
      }
    }, 5000);
    return () => clearInterval(id);
  }, [dispatch, signerType]);

  // ---- Background ------------------------------------------------------

  // With background updates a share keeps streaming when the app leaves the
  // foreground. Only the foreground-only fallback pauses (and resumes).
  useEffect(() => {
    const onChange = (next: AppStateStatus) => {
      const now = Date.now();
      if (next === 'active') {
        for (const session of sessionsRef.current.values()) {
          if (session.status === 'paused') {
            dispatch({ type: 'resume', sessionId: session.sessionId, now });
          }
        }
        // A share stuck on the foreground-only watcher (the service couldn't
        // start — e.g. the app was left mid-start): retry now we're in front.
        const owner = lastIdentityRef.current;
        const live = [...sessionsRef.current.values()].some((s) => s.status === 'active');
        if (owner && live && getTrackingMode() === 'foreground') {
          void startTracking({ owner, relays: writeRelaysRef.current }).catch(() => undefined);
        }
      } else if (getTrackingMode() !== 'background') {
        for (const session of sessionsRef.current.values()) {
          if (session.status === 'active') {
            dispatch({ type: 'pause', sessionId: session.sessionId });
          }
        }
      }
    };
    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [dispatch]);

  // ---- Hydrate persisted sessions on first mount -----------------------

  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    void (async () => {
      const persisted = await loadPersistedSessions(pubkey);
      if (cancelled) return;
      hydratedForRef.current = pubkey;
      if (persisted.length === 0) return;
      setSessions((prev) => {
        const next = new Map(prev);
        const now = Date.now();
        for (const session of persisted) {
          if (next.has(session.sessionId)) continue;
          // Past expiry, or the account was switched away mid-share → `expired`
          // (the drain sends the end marker). Else resume if foregrounded — a
          // cold start fires no AppState transition — or `paused` in background.
          const expired =
            session.stopRequested || now >= expiryFor(session.startedAt, session.durationMs);
          const resumeNow = AppState.currentState === 'active';
          next.set(session.sessionId, {
            ...session,
            status: expired ? 'expired' : resumeNow ? 'active' : 'paused',
          });
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  // ---- Read models -------------------------------------------------------

  const sessionsByRecipient = useMemo(() => {
    const out = new Map<string, OutgoingSession[]>();
    for (const session of sessions.values()) {
      const arr = out.get(session.recipientPubkey) ?? [];
      arr.push(session);
      out.set(session.recipientPubkey, arr);
    }
    return out;
  }, [sessions]);

  const hasActiveShareWith = useCallback(
    (threadKey: string): boolean => {
      const arr = sessionsByRecipient.get(threadKey) ?? [];
      return arr.some((s) => s.status === 'active' || s.status === 'paused');
    },
    [sessionsByRecipient],
  );

  const remainingMsForSession = useCallback(
    (sessionId: string): number | null => {
      const session = sessions.get(sessionId);
      if (!session) return null;
      return remainingMs(session, Date.now());
    },
    [sessions],
  );

  const value = useMemo<LiveLocationContextValue>(
    () => ({
      sessionsByRecipient,
      startShare,
      stopShare,
      hasActiveShareWith,
      remainingMsForSession,
    }),
    [sessionsByRecipient, startShare, stopShare, hasActiveShareWith, remainingMsForSession],
  );

  return <LiveLocationContext.Provider value={value}>{children}</LiveLocationContext.Provider>;
};
