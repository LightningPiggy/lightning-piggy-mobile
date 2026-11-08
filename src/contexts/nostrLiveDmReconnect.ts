import { AppState } from 'react-native';
import type { RawInboxDmEvent } from '../services/nostrService';
import { subscribeInboxDmsForViewer } from '../services/dmLiveSubscription';
import { COLD_INITIAL_WRAP_LIMIT } from './nostrDmCache';
import type { RefreshDmInboxOptions } from './nostrContextTypes';

// --- Live-sub self-re-arm on relay drop / app resume (#934) ---
// The app-wide SimplePool deliberately does NOT auto-reconnect
// (enableReconnect stays default-false app-wide), so when the wrap
// subscription's WebSocket silently drops — relay idle timeout, network
// change, Android Doze suspending the socket on background — the foreground
// live sub goes deaf and nothing re-opens it. The user then has to
// pull-to-refresh to see missed DMs (the #934 symptom). We mirror the
// background DM watch's self-re-arm (#958): the sub's `onWrapsClose` schedules
// a backoff-scheduled re-open, and an AppState 'active' listener re-arms on
// resume (Doze can freeze the JS engine before onWrapsClose ever fires). A
// generation counter guards against re-arming after an intentional teardown
// (logout / account switch / relay-list change), and re-arms are silent by
// construction — re-subscribing over healthy sockets reuses the pool's open
// connections, the `isFreshArrival` gate mutes the backlog replay, and
// `knownWrapIds` + `claimWrapNotification` prevent duplicate work / alerts.
//
// Extracted from `nostrLiveDmSub.ts` (#1039 review) — this module owns ONLY
// the connection lifecycle (open / backoff-reconnect / resume-rearm / the
// post-reconnect settle timer that flushes the blind window). Event decoding,
// decrypt, persistence, and inbox surfacing stay in `nostrLiveDmSub.ts`,
// which supplies this controller a plain `onEvent` callback.
const LIVE_SUB_RECONNECT_BASE_DELAY_MS = 5_000;
const LIVE_SUB_RECONNECT_MAX_DELAY_MS = 5 * 60_000;
// A subscription that survived at least this long before closing counts as
// having been healthy — its next drop retries from the base delay; a
// rapid-fail (offline) keeps climbing the exponential backoff ladder.
const LIVE_SUB_HEALTHY_MIN_LIFETIME_MS = 60_000;
// Leading-edge debounce for the AppState `active` re-arm: the first resume
// re-arms immediately, but rapid foreground/background churn within this window
// is coalesced (the socket a moment-ago resume opened is still healthy, so
// re-subscribing again is wasted churn). A real Doze resume is far apart from
// the prior one, so it always clears this window and re-arms.
const LIVE_SUB_RESUME_DEBOUNCE_MS = 2_000;
// How long after a RECONNECT re-arm we wait before firing onReconnect to
// flush the blind window. Gives the relay time to deliver the first batch of
// backlogged wraps over the newly-opened WebSocket before the refresh runs;
// stagger non-latency-sensitive reconciliation after immediate DM re-arm
// so resume doesn't pile cache/crypto work onto the same JS-thread turn.
const RECONNECT_REFRESH_SETTLE_MS = 3_000;

export interface LiveDmReconnectDeps {
  viewerPubkey: string;
  readRelays: string[];
  /** Per-event handler; already wrapped by the caller with its own
   * try/catch-and-log — this controller treats it as fire-and-forget. */
  onEvent: (ev: RawInboxDmEvent) => void;
  /** Optional: called once after a RECONNECT re-arm settles, to flush any
   * wraps missed while the socket was down. Not fired on the initial cold arm
   * (the normal cold-start + deferred-backfill path covers that). See #1035. */
  onReconnect?: (opts?: RefreshDmInboxOptions) => Promise<void>;
  /** Read the caller's cancellation flag (set by teardown). Checked instead of
   * owning the flag itself so it stays in lock-step with the single `cancelled`
   * boolean `nostrLiveDmSub.ts`'s `handleInboxEvent` also guards on. */
  isCancelled: () => boolean;
  /** Optional: skip the kind-1059 wrap filter on the JS sub (the native
   * relay engine owns it — Stage 2 M2, #1036). Read at every (re)arm so a
   * `rearm()` after a native-engine start failure restores the wrap filter. */
  skipWraps?: () => boolean;
  /** Optional: ids already stored / in flight, skipped before parse and
   * verify (see `subscribeInboxDmsForViewer`'s `isKnownEvent`, #1759). */
  isKnownEvent?: (id: string) => boolean;
}

export interface LiveDmReconnectController {
  /** Arm the first (cold) subscription. Call once, after the caller has
   * resolved the kind-4 `since` cursor (loadLastSeen) — re-arms reuse the
   * same cursor for the controller's lifetime, same as before extraction. */
  start(sinceK4Cursor: number | undefined): void;
  /** Re-open the subscription immediately (fresh generation, `skipWraps`
   * re-read). Used by the native-engine fallback (#1036 Stage 2 M2) to
   * restore the JS wrap filter when the engine fails to start. No-ops
   * before `start()` has armed the first sub. */
  rearm(): void;
  /** Invalidate any in-flight close signal + pending reconnect/settle timers
   * and stop the AppState-resume re-arm. Call BEFORE `closeSubscription()` so
   * the close it triggers synchronously is stale-generation and no-ops. */
  stopReconnecting(): void;
  /** Close the currently-open underlying subscription, if any. */
  closeSubscription(): void;
}

/**
 * Own the live-DM subscription's connection lifecycle: open it, re-open with
 * backoff on relay drop, re-arm proactively on app resume, and fire
 * `onReconnect` once a reconnect re-arm has had a moment to settle. Extracted
 * verbatim from `startLiveDmSubscription`'s re-arm state machine (#1039
 * review) — no logic / ordering / guard changed.
 */
export function createLiveDmReconnectController(
  deps: LiveDmReconnectDeps,
): LiveDmReconnectController {
  const { viewerPubkey, readRelays, onEvent, onReconnect, isCancelled, skipWraps, isKnownEvent } =
    deps;

  let unsubscribe: (() => void) | null = null;
  // The kind-4 `since` cursor loaded once by the caller before the first
  // `start()`; re-arms (#934) reuse it. Re-streaming kind-4 from the same
  // cursor on a re-arm is safe: the closure-scoped `seen` Set, the RAM
  // plaintext cache, and the idempotent encrypted-store upsert (all in
  // `nostrLiveDmSub.ts`) dedupe the re-fetched bytes.
  let sinceK4Cursor: number | undefined;
  // `armGeneration` is bumped on every (re)arm and on teardown; each
  // underlying sub's `onWrapsClose` captures the generation live at arm
  // time, so a close belonging to a sub we already superseded (or a
  // torn-down sub) is stale and must not schedule a reconnect.
  let armGeneration = 0;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Reconnect-refresh settle timer (#1039 review): armSub schedules this after
  // a reconnect re-arm to fire onReconnect once the socket has had a moment to
  // deliver its first backlog burst. `onWrapsClose` bumps neither `armGeneration`
  // nor cancels this timer on its own, so if the sub drops again before the
  // settle window elapses, the stale timer would otherwise still fire (same
  // generation) and call onReconnect while the socket is down / mid-backoff.
  // Tracked so it can be cleared on the next drop and on teardown.
  let reconnectSettleTimer: ReturnType<typeof setTimeout> | null = null;
  // Wall-clock ms of the last AppState-resume-triggered re-arm, for the
  // leading-edge debounce below (rapid foreground/background churn coalesces).
  let lastResumeArmMs = 0;
  // True once the initial async arm (which seeds knownWrapIds + loads the
  // kind-4 `since` cursor) has opened the first sub. The AppState-resume
  // re-arm no-ops before this so it can't race ahead of the seed.
  let initialArmed = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  // Clears the pending reconnect-refresh settle timer, if any (#1039 review).
  // Called on the next drop/close and on teardown so a torn-down or
  // re-armed sub can never leave a stale settle timer stacked behind it.
  const clearReconnectSettleTimer = (): void => {
    if (reconnectSettleTimer) {
      clearTimeout(reconnectSettleTimer);
      reconnectSettleTimer = null;
    }
  };

  // Open (or re-open) the underlying relay subscription. Bumps the generation
  // FIRST, then tears down any prior sub — so the prior sub's `onWrapsClose`,
  // which fires synchronously on close, sees a stale generation and no-ops
  // (never schedules a reconnect for a sub we intentionally superseded). Idempotent.
  const armSub = (): void => {
    if (isCancelled()) return;
    clearReconnectTimer();
    // A prior arm's reconnect-refresh settle timer (if still pending) belongs
    // to a generation we're about to supersede — drop it so re-arm cycles
    // never stack settle timers (#1039 review).
    clearReconnectSettleTimer();
    const generation = ++armGeneration;
    // isReconnect distinguishes a reconnect re-arm (after a socket drop or
    // Doze resume — #1035) from the initial cold arm. On reconnect, wraps
    // sent while the socket was down can rank below COLD_INITIAL_WRAP_LIMIT
    // (200) in the relay's newest-first ordering because NIP-17 randomises
    // the gift-wrap's `created_at` up to 48 h back (#469). Raising the limit
    // or querying with a `since` cursor would fight the deliberate no-since
    // design (which exists precisely to avoid #469 ranking gaps); instead we
    // fire a single `onReconnect` after the re-arm settles — the caller wires
    // this to refreshDmInbox, which queries with limit 1000 and the full
    // ingest engine, so it catches everything the live sub's reconnect-window
    // limit misses. The initial cold arm is already covered by the caller's
    // deferred backfill, so we only fire here on reconnect (initialArmed is
    // set true after `start()`'s first armSub call, so scheduleReconnect /
    // the AppState handler — the only other callers of armSub — always see it
    // true).
    const isReconnect = initialArmed;
    if (unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // best-effort
      }
      unsubscribe = null;
    }
    const armedAtMs = Date.now();
    // Engine mode (#1036 Stage 2 M2): the native pool owns the kind-1059
    // filter; the JS sub keeps kind-4/16/17 (the close-driven re-arm signal
    // moves to the kind-4 sub — see subscribeInboxDmsForViewer). Read per-arm
    // so a rearm() after a native-engine start failure restores the filter.
    const skipWrapsNow = skipWraps?.() ?? false;
    unsubscribe = subscribeInboxDmsForViewer({
      viewerPubkey,
      relays: readRelays,
      sinceK4: sinceK4Cursor,
      skipWraps: skipWrapsNow,
      // Bound the kind-1059 backlog re-stream so arming the live sub doesn't
      // re-ingest the full wrap history on the JS thread (#751). Deeper backlog
      // is covered by refreshDmInbox's deferred backfill; new wraps stream live.
      wrapsLimit: COLD_INITIAL_WRAP_LIMIT,
      onEvent,
      isKnownEvent,
      // The wrap sub closed on every relay — the socket dropped and we've gone
      // deaf to new DMs (#934). Re-arm with backoff, unless this close belongs
      // to a superseded / torn-down sub (stale generation) or we were cancelled.
      onWrapsClose: () => {
        if (isCancelled() || generation !== armGeneration) return;
        // The sub dropped again before its reconnect-refresh settle window
        // elapsed — cancel the pending settle timer so it can't fire
        // onReconnect while the socket is down / during backoff (#1039
        // review). `armGeneration` isn't bumped until the next `armSub`, so
        // without this the stale timer's generation check alone wouldn't
        // catch it.
        clearReconnectSettleTimer();
        // Lifetime-based health: a sub that survived a while was genuinely
        // connected, so its drop retries from the base delay; a rapid-fail
        // (offline) keeps climbing the exponential ladder.
        if (Date.now() - armedAtMs >= LIVE_SUB_HEALTHY_MIN_LIFETIME_MS) reconnectAttempt = 0;
        scheduleReconnect(generation);
      },
    });
    if (__DEV__) {
      console.log(
        `[Nostr] live DM sub (${skipWrapsNow ? 'kind 4 — wraps on native engine' : 'kinds 4 + 1059'}) opened for ${viewerPubkey.slice(0, 8)} on ${readRelays.length} relays, sinceK4=${sinceK4Cursor ?? 'default-7d'}`,
      );
    }
    // Reconnect blind-window flush (#1035): after a socket drop or Doze resume
    // re-arm, fire onReconnect once the relay has had a moment to deliver
    // the newly-subscribed backlog. This catches wraps sent while the sub was
    // deaf that landed below COLD_INITIAL_WRAP_LIMIT in the relay's ordering
    // because NIP-17 randomises gift-wrap `created_at` up to 48 h back (#469).
    // Rationale for onReconnect (wired to refreshDmInbox) over a higher
    // wrapsLimit: raising the live-sub limit would replay the full backlog on
    // the JS thread every reconnect, whereas refreshDmInbox uses the
    // decrypt-once gate (DB known-ids) so only genuinely new wraps pay decrypt
    // cost. The settle delay gives the relay time to push the first burst
    // before the refresh REQ lands — without it the refresh and the live-sub
    // REQ race and the refresh wins, leaving the live-sub backlog duplicating
    // the refresh's work.
    if (isReconnect && onReconnect) {
      reconnectSettleTimer = setTimeout(() => {
        reconnectSettleTimer = null;
        // Still armed on the same generation this timer was scheduled for?
        // A drop/close in the interim clears this timer (see onWrapsClose),
        // and teardown clears it too, but the generation check is kept as a
        // defense-in-depth guard against firing after the sub was superseded
        // or torn down (#1039 review).
        if (isCancelled() || generation !== armGeneration) return;
        if (__DEV__)
          console.log(
            '[Nostr] live DM reconnect — triggering refreshDmInbox to close blind window (#1035)',
          );
        onReconnect({}).catch((e) => {
          if (__DEV__) console.warn('[Nostr] live DM reconnect refresh failed:', e);
        });
      }, RECONNECT_REFRESH_SETTLE_MS);
    }
  };

  // Schedule a backoff-delayed re-arm after a socket drop (#934). Guards
  // against a stale generation, an intentional teardown, and a reconnect
  // already pending.
  const scheduleReconnect = (generation: number): void => {
    if (isCancelled() || generation !== armGeneration || reconnectTimer) return;
    const delay = Math.min(
      LIVE_SUB_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(reconnectAttempt, 10),
      LIVE_SUB_RECONNECT_MAX_DELAY_MS,
    );
    reconnectAttempt += 1;
    if (__DEV__)
      console.warn(`[Nostr] live DM sub closed — re-arming in ${Math.round(delay / 1000)}s`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (isCancelled()) return;
      armSub();
    }, delay);
  };

  // Re-arm on app resume (#934). Android Doze can suspend the relay WebSocket
  // (and freeze the JS engine) while backgrounded, so on return to `active`
  // the socket is often dead WITHOUT `onWrapsClose` ever having fired. Re-arm
  // proactively from the shortest backoff. No-ops until the initial seed has
  // armed the first sub, so a resume can't race ahead of the knownWrapIds seed.
  const appStateSub = AppState.addEventListener('change', (next) => {
    if (isCancelled() || !initialArmed) return;
    if (next === 'active') {
      // Debounce rapid foreground/background churn (#986 review): re-arming on
      // every resume re-subscribes repeatedly when the user flicks between
      // apps, even though a socket opened a second ago is still healthy. A
      // genuine Doze resume is always far past this window, so it still re-arms.
      const now = Date.now();
      if (now - lastResumeArmMs < LIVE_SUB_RESUME_DEBOUNCE_MS) return;
      lastResumeArmMs = now;
      reconnectAttempt = 0;
      armSub();
    }
  });

  return {
    start(cursor) {
      sinceK4Cursor = cursor;
      if (isCancelled()) return;
      armSub();
      initialArmed = true;
    },
    rearm() {
      if (!initialArmed) return;
      armSub();
    },
    stopReconnecting() {
      armGeneration += 1;
      clearReconnectTimer();
      clearReconnectSettleTimer();
      appStateSub.remove();
    },
    closeSubscription() {
      if (unsubscribe) unsubscribe();
    },
  };
}
