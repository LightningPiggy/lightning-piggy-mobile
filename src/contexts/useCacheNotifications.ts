/**
 * useCacheNotifications — foreground live subscription that fires an OS
 * notification when fresh activity lands on one of the viewer's published
 * geo-caches (#740, #945).
 *
 * Two event surfaces are watched against the viewer's own cache coords:
 *   - kind-1111 NIP-22 comments (`#A` root pointer) — #740
 *   - kind-7516 NIP-GC found-logs (`#a` cache pointer) — #945
 * A found-log additionally fans out on the in-app event bus
 * (`notifyFoundLog`) so an open HuntPiggyDetail can refresh in-place;
 * comments stay notification-only (no in-app live surface yet).
 *
 * Mirrors the shape of `useDmInbox`'s live sub (the one that opens the
 * kind-4 + kind-1059 stream and fires `fireMessageNotification` per
 * fresh event), but for the public cache-activity surface. There is no
 * decryption, no follow gate, and no inbox state to mutate — the hook
 * exists purely to listen, ping, and broadcast.
 *
 * "My cache coordinates" is sourced from `fetchCachesByAuthor` and
 * re-fetched on a session timer (every minute) and on every AppState →
 * active transition, so a cache the user publishes mid-session (which a
 * one-shot snapshot would miss until full remount, Copilot review #742)
 * is picked up by the live sub within a minute — and immediately on a
 * background→foreground hop. We deliberately do NOT thread this list
 * through NostrContext state — the screens that already display the
 * user's caches each have their own hydration paths, and bolting another
 * reactive source onto the context would grow that over-cap file without
 * a clear win. The cost is one `fetchCachesByAuthor` per minute; cheap
 * (kind-37516 by one pubkey is replaceable and bounded, capped at 5 s).
 *
 * Freshness gate matches the DM live sub: only events whose own
 * `created_at` ≥ `subOpenedAtSec − NOTIFY_SKEW_SEC` fire a notification,
 * so the relay's historical replay on cold start stays silent. Per-event
 * dedup via a session Set so the same find-log delivered by multiple
 * relays only fires once.
 */
import { useEffect, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import type { VerifiedEvent } from 'nostr-tools';
import {
  subscribeCacheCommentsForCoords,
  subscribeCacheFoundLogsForCoords,
} from '../services/cacheNotifySubscription';
import { fireCacheNotification } from '../services/notificationService';
import { fetchCachesByAuthor } from '../services/nostrPlacesPublisher';
import { subscribeOwnCachesChanged } from '../services/ownCachesBus';
import { parseCacheCoord } from '../services/nostrPlacesService';
import { notifyFoundLog } from './nostrEventBus';
import { useStableRelayList } from '../hooks/useStableRelayList';

// Tolerate sender/receiver clock drift — matches the DM live sub.
const NOTIFY_SKEW_SEC = 120;

// Bounded session dedup. Find-logs against a popular cache could stream
// in heavy bursts (e.g. a treasure hunt going viral) and we don't want
// the Set to grow unboundedly across the life of the sub.
const SEEN_CAP = 1000;

// Safety-net re-poll of the viewer's cache coords. Same-device publishes
// re-arm EVENT-DRIVEN via ownCachesBus (#1016), so this interval only
// covers the rare cross-device case (a cache published/edited from another
// device mid-session). It was 60 s — ~1,440 seven-relay REQ sweeps a day,
// measured at 3–5 s of relay wait each and returning nothing for most
// users; 15 min keeps the cross-device catch-up without the churn.
const REFETCH_COORDS_INTERVAL_MS = 15 * 60_000;
// Minimum gap between actual refetch passes. The 15-min safety-net interval
// and one-time mount call sit well above it; its job is to coalesce AppState
// 'active' bursts — the OS can deliver several 'active' events back-to-back on
// resume, each otherwise firing an overlapping fetchCachesByAuthor that piles
// onto the JS thread during warm re-foreground (#751 warm-path audit #5).
const REFETCH_MIN_GAP_MS = 10_000;
// Resume-burst stagger (#554). On AppState → active, five concurrent handlers
// fire (DM re-arm, wallet refresh, relay reconnect, …). fetchCachesByAuthor
// against 7 relays costs 3–5 s of JS-thread time and starves tap-dispatch
// queued during the background pause — users tap UI that feels dead.
// Cache-coord refetch is latency-insensitive (the live sub stays armed with
// the previous coord set; the refetch only matters if a NEW cache was
// published while backgrounded, which is rare). A 3 s stagger yields to the
// latency-sensitive work (DM re-arm, wallet refresh) and keeps the bridge
// responsive on resume.
const RESUME_REFETCH_DELAY_MS = 3_000;

// Per-surface notification copy. Comments and found-logs are separate
// event kinds now, so the OS notification title should match what actually
// happened rather than always claiming a "find" (Copilot #946).
interface NotifyCopy {
  title: string;
  body: string;
}
const FOUND_LOG_COPY: NotifyCopy = {
  title: 'New find on your cache',
  body: 'Open Lightning Piggy to view',
};
const COMMENT_COPY: NotifyCopy = {
  title: 'New comment on your cache',
  body: 'Open Lightning Piggy to view',
};

/** The viewer's last coord fetch, shared by every run of the hook's effect. */
interface CoordFetchState {
  pubkey: string | null;
  /** Wall-clock of the last fetch actually started — see REFETCH_MIN_GAP_MS. */
  startedAt: number;
  /** Coords the last successful fetch returned; null before the first. */
  coords: string[] | null;
  /** The fetch in flight, if any. */
  pending: Promise<string[]> | null;
}
const newCoordFetchState = (pubkey: string | null): CoordFetchState => ({
  pubkey,
  startedAt: 0,
  coords: null,
  pending: null,
});

export interface UseCacheNotificationsParams {
  /** Active viewer's hex pubkey. Null when logged out — sub stays closed. */
  pubkey: string | null;
  /** Stable getter returning the current read relays. Same shape as the
   * one `useDmInbox` consumes, so callers can pass the same value. */
  getReadRelays: () => string[];
}

/**
 * Open the live find-log subscription for the viewer's caches. Returns
 * nothing — the hook fires notifications as a side-effect and tears
 * down the sub on unmount / pubkey change / relay change.
 *
 * Idempotent: rendering the hook with the same params is a no-op
 * between effect runs.
 */
export function useCacheNotifications(params: UseCacheNotificationsParams): void {
  const { pubkey } = params;
  // Keyed on the relay set: a new getter with the same relays is a no-op.
  const readRelays = useStableRelayList(params.getReadRelays);

  // Coord-fetch state outlives effect re-runs (a relay-set change re-runs the
  // effect), so a re-run can't bypass REFETCH_MIN_GAP_MS or overlap a fetch
  // still in flight. Per viewer: an account switch starts afresh.
  const fetchStateRef = useRef<CoordFetchState>(newCoordFetchState(null));

  useEffect(() => {
    if (!pubkey) return;
    if (readRelays.length === 0) return;
    if (fetchStateRef.current.pubkey !== pubkey) {
      fetchStateRef.current = newCoordFetchState(pubkey);
    }
    const fetchState = fetchStateRef.current;

    let cancelled = false;
    let unsubscribeComments: (() => void) | null = null;
    let unsubscribeFoundLogs: (() => void) | null = null;
    // Coord set the sub is currently armed with. Compared against each
    // refetch to skip tear-down + re-arm when nothing changed.
    let currentCoords: string[] = [];
    const seen = new Set<string>();
    // Freshness baseline. Reset to "now" every time we (re)arm the relay
    // subscriptions in refetchAndRearm — NOT just once on mount — so the
    // relay's historical replay that predates a *later* (re)subscribe (e.g.
    // a cache published mid-session that changes the coord set minutes in)
    // can't slip past the gate and fire stale notifications (Copilot #946).
    let subOpenedAtSec = Math.floor(Date.now() / 1000);

    // Shared per-event handler. `coordTagKey` is `A` (uppercase NIP-22 root
    // pointer, for kind-1111 comments) or `a` (lowercase NIP-GC cache
    // pointer, for kind-7516 found-logs) — read whichever tag the matching
    // filter armed. `broadcast` fans a fresh found-log out on the in-app
    // event bus so an open HuntPiggyDetail refreshes without polling;
    // comments pass `false` (no in-app live surface yet).
    const handle = (
      ev: VerifiedEvent,
      coordTagKey: 'A' | 'a',
      broadcast: boolean,
      copy: NotifyCopy,
    ): void => {
      if (cancelled) return;
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      // Bounded dedup — drop oldest ~25% under sustained pressure (same
      // pattern as the DM live sub's `seen` Set). Shared across both kinds;
      // event ids are globally unique so a comment and a found-log never
      // collide.
      if (seen.size > SEEN_CAP) {
        const drop = Math.floor(SEEN_CAP / 4);
        const it = seen.values();
        for (let i = 0; i < drop; i++) seen.delete(it.next().value!);
      }
      // Never self-ping — the owner logging a find / maintenance note on
      // their own cache is not activity we want to surface as a notification.
      if (ev.pubkey === pubkey) return;
      // Freshness gate — silent on backlog the relay replays on sub open.
      if (ev.created_at < subOpenedAtSec - NOTIFY_SKEW_SEC) return;

      const coordTag = ev.tags.find((t) => t[0] === coordTagKey)?.[1];
      if (!coordTag) return;
      const parsed = parseCacheCoord(coordTag);
      if (!parsed) return;

      // Generic copy — the lock-screen-content toggle in
      // notificationService substitutes a generic title/body when the
      // user opts out of content on the lock screen. The richer
      // "Find on <cache name> by <finder>" body could be resolved here
      // by reading the cached ParsedCache + a profile lookup, but
      // doing so blocks on cache-store + relay round-trips inside an
      // event handler running on a hot stream. The follow-up is to
      // resolve those off the hot path and pass them in.
      void fireCacheNotification({
        cacheCoord: coordTag,
        title: copy.title,
        body: copy.body,
      });

      if (broadcast) notifyFoundLog(coordTag, ev.id);
    };

    /**
     * Re-fetch "my cache coords" and (re-)arm the live sub if the coord
     * set changed. Called on mount, event-driven via ownCachesBus when THIS
     * device publishes/edits/deletes a cache, on a 15-minute safety-net
     * interval (cross-device changes), and on every AppState → active
     * transition. `fetchCachesByAuthor` caps itself at 5 s so this can't
     * pin the hook against a slow relay.
     */
    /** (Re-)arm the live subs for `coords` on this effect's relays. A no-op
     * when they're already armed for the same coord set. */
    const armFor = (coords: string[]): void => {
      if (cancelled) return;
      // Set-equality (order-independent — fetchCachesByAuthor ordering is
      // not guaranteed). Skip the tear-down + re-arm when unchanged. O(1)
      // membership via a Set — this runs on every refetch and AppState
      // resume, and a user can own many caches (Copilot #946).
      const currentSet = new Set(currentCoords);
      const sameSet =
        coords.length === currentCoords.length && coords.every((c) => currentSet.has(c));
      if (sameSet) return;
      currentCoords = coords;
      if (unsubscribeComments) {
        unsubscribeComments();
        unsubscribeComments = null;
      }
      if (unsubscribeFoundLogs) {
        unsubscribeFoundLogs();
        unsubscribeFoundLogs = null;
      }
      if (coords.length === 0) return;
      // Re-baseline the freshness gate to the moment we (re)arm, so the
      // replay the relay sends for this fresh subscription (since: now−7d)
      // stays silent — only events created at/after this re-subscribe fire.
      subOpenedAtSec = Math.floor(Date.now() / 1000);
      unsubscribeComments = subscribeCacheCommentsForCoords({
        viewerPubkey: pubkey,
        relays: readRelays,
        cacheCoords: coords,
        onEvent: (ev) => handle(ev, 'A', false, COMMENT_COPY),
      });
      unsubscribeFoundLogs = subscribeCacheFoundLogsForCoords({
        viewerPubkey: pubkey,
        relays: readRelays,
        cacheCoords: coords,
        onEvent: (ev) => handle(ev, 'a', true, FOUND_LOG_COPY),
      });
    };

    // Single-flight: at most one fetch runs at a time (tracked in the hoisted
    // fetchState, so a re-run sees a fetch its predecessor started). A forced
    // pass (own-cache publish, #1016) that lands while a fetch is in flight
    // queues ONE follow-up instead of overlapping it — bypassing the min-gap
    // throttle must not reintroduce the overlapping-fetch problem the
    // throttle exists to prevent (Copilot #1018).
    let queuedForce = false;
    const runQueuedForce = (): void => {
      if (queuedForce && !cancelled) {
        queuedForce = false;
        void refetchAndRearm({ force: true });
      }
    };
    /** Arm with the result of a fetch already in flight (possibly started by
     * the previous effect run) instead of starting another. */
    const joinPending = (pending: Promise<string[]>): void => {
      pending.then(armFor, () => {}).finally(runQueuedForce);
    };
    const refetchAndRearm = async (opts?: { force?: boolean }): Promise<void> => {
      if (cancelled) return;
      if (fetchState.pending) {
        if (opts?.force) queuedForce = true;
        return;
      }
      // Throttle bursts (esp. multiple back-to-back AppState 'active' events on
      // resume) so we don't fire overlapping relay fetches (#751 audit #5).
      // `force` (a just-published own cache, #1016) skips the gap — the whole
      // point of the event-driven re-arm is picking the change up NOW.
      const startNow = Date.now();
      if (!opts?.force && startNow - fetchState.startedAt < REFETCH_MIN_GAP_MS) return;
      fetchState.startedAt = startNow;
      const pending = fetchCachesByAuthor(pubkey, readRelays).then((caches) =>
        caches.map((c) => c.coord),
      );
      fetchState.pending = pending;
      try {
        const coords = await pending;
        fetchState.coords = coords;
        armFor(coords);
      } catch {
        // Non-fatal — leave the previous sub (if any) in place; the next
        // refetch retries. The background detect-and-ping pass also
        // catches anything we miss here.
      } finally {
        if (fetchState.pending === pending) fetchState.pending = null;
        runQueuedForce();
      }
    };

    // Staggered-resume timer. Populated when AppState fires 'active'; cleared
    // on unmount and on the NEXT AppState event (background→active bounce must
    // not stack timers or fire after re-backgrounding — see #554).
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;

    // First arm for this relay set. A re-run (the relay set changed) reuses
    // a fetch in flight or a coord set fetched inside the min gap, and only
    // re-subscribes on the new relays; otherwise it fetches as on mount.
    if (fetchState.pending) joinPending(fetchState.pending);
    else if (fetchState.coords && Date.now() - fetchState.startedAt < REFETCH_MIN_GAP_MS)
      armFor(fetchState.coords);
    else void refetchAndRearm();
    const interval = setInterval(() => {
      void refetchAndRearm();
    }, REFETCH_COORDS_INTERVAL_MS);
    const appStateSub = AppState.addEventListener('change', (s: AppStateStatus) => {
      // Cancel any pending stagger from a prior 'active' event — a quick
      // active→background→active bounce must not stack timers or fire the
      // stale timer after the app re-enters the background (#554).
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      if (s !== 'active') return;
      // Resume-burst stagger (#554): defer the coord refetch so it doesn't
      // compete with latency-sensitive work (DM re-arm, wallet refresh) that
      // fires concurrently on resume. Cache-coord refetch is not
      // latency-sensitive — the live sub stays armed; the refetch matters
      // only if a cache was published while backgrounded (rare).
      resumeTimer = setTimeout(() => {
        resumeTimer = null;
        void refetchAndRearm();
      }, RESUME_REFETCH_DELAY_MS);
    });
    // Event-driven re-arm: this device just published / edited / expired /
    // deleted one of its own caches (#1016) — refresh the coord set now.
    const unsubOwnCaches = subscribeOwnCachesChanged(() => {
      void refetchAndRearm({ force: true });
    });

    return () => {
      cancelled = true;
      if (resumeTimer !== null) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      clearInterval(interval);
      appStateSub.remove();
      unsubOwnCaches();
      if (unsubscribeComments) unsubscribeComments();
      if (unsubscribeFoundLogs) unsubscribeFoundLogs();
    };
  }, [pubkey, readRelays]);
}
