/**
 * backgroundSyncService — the context-free worker the native background
 * host (Android WorkManager / iOS BGTaskScheduler, via expo-background-task)
 * runs to surface OS notifications while the app's UI isn't mounted (#279).
 *
 * DETECT-AND-PING design: this NEVER decrypts. It only detects that new
 * encrypted traffic arrived and fires a GENERIC "you have new messages"
 * notification; the app decrypts and shows the real content when the user
 * opens it. That choice is deliberate:
 *   - It works for BOTH nsec and Amber users — Amber can't decrypt in the
 *     background (it needs its foreground app to approve), so a
 *     decrypt-in-background design would silently exclude Amber users.
 *   - No plaintext is ever produced off-screen — matches the privacy-first
 *     lock-screen default.
 *   - Far less code runs headless (no signer, no gift-wrap unwrap).
 *
 * Freshness is tracked by EVENT ID, not by a `created_at` cursor. NIP-59
 * randomises a gift wrap's `created_at` up to two days into the PAST to
 * thwart timing analysis, so a genuinely-new kind-1059 wrap can arrive
 * carrying an already-old timestamp. A `since`/`created_at` gate would let
 * the relay filter such a wrap out and silently miss real NIP-17 traffic
 * (Copilot review #282). So we query a window wide enough to span the
 * maximum backdate and dedupe against a persisted set of seen ids.
 *
 * Runs in a SEPARATE JS context from the React tree, so it reads everything
 * it needs from storage and talks to relays directly via the shared
 * nostr-tools pool. It must be cheap and self-terminating: open a query,
 * decide whether to ping, persist the seen-set, return.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { pool } from './nostrService';
import { loadIdentities } from './identitiesStore';
import { initialiseBackgroundRelayAccount } from './backgroundRelayAccount';
import { lockRelays } from '../config/testRelayLockdown';
import { getUserRelays } from './nostrRelayStorage';
import { fireMessageNotification, fireCacheNotification } from './notificationService';
import { loadMutedSenders } from './mutedSenders';
import { messageNotificationTarget } from '../utils/messageNotificationTarget';
import { fetchCachesByAuthor } from './nostrPlacesPublisher';
import { GC_COMMENT_KIND } from './nostrPlacesService';
import { isLiveDmSubArmed, wasWrapHandled } from './dmWrapNotificationDedupe';

// Persisted ids we've already accounted for, so repeated wakes never
// re-ping the same arrival. Bounded (insertion-ordered; oldest dropped
// past the cap). Its PRESENCE also marks that the baseline has been
// primed — see the first-run handling in runBackgroundSync.
const BG_SEEN_IDS_KEY = 'bg_sync_seen_ids_v1';
// Independent seen-set for kind-1111 find-logs (#740). Kept separate from the
// DM/wrap seen-set so the two streams can't collide on event ids and so a
// future cap change to one doesn't silently re-flood the other on next wake.
const BG_SEEN_CACHE_COMMENT_IDS_KEY = 'bg_sync_seen_cache_comment_ids_v1';
const SEEN_CAP = 1000;

// NIP-59 tweaks a wrap's `created_at` up to 2 days into the past. Query a
// window that spans that, plus a little overlap for relay clock skew, so no
// genuinely-new wrap is filtered out by the relay before we can see its id.
const NIP59_MAX_BACKDATE_SEC = 2 * 24 * 60 * 60;
const OVERLAP_SEC = 120;
const LOOKBACK_SEC = NIP59_MAX_BACKDATE_SEC + OVERLAP_SEC;

// Find-logs (kind-1111) are public, never gift-wrapped — their `created_at`
// is the genuine publish time. We don't need the NIP-59 backdate cushion,
// but background wakes are best-effort and infrequent (~15 min floor on
// Android), so a relay that dropped one earlier still wants picking up on
// the next pass. A 1-day window dedupes by id against the seen-set and
// keeps the round-trip cheap.
const CACHE_COMMENT_LOOKBACK_SEC = 24 * 60 * 60;

// Cap the relay round-trip so a slow/unresponsive relay cannot keep this
// headless task alive (battery drain + risk of the OS killing/penalising
// it). nostr-tools closes the sub after maxWait and returns whatever
// arrived — partial results are fine for detect-and-ping. Matches the 5 s
// cap nostrPlacesPublisher uses for the same Hermes timer-starvation reason.
const QUERY_MAXWAIT_MS = 5000;

export interface BackgroundSyncResult {
  /** Whether a notification was fired this run (any kind). */
  pinged: boolean;
  /** Count of fresh inbound DM events detected (0 when nothing new). */
  freshCount: number;
  /** Count of fresh kind-1111 find-logs against my caches (#740). */
  freshCacheCommentCount: number;
}

/**
 * Load the persisted seen-set. `primed` is false only on the very first run
 * (key absent) so the caller can establish a silent baseline rather than
 * pinging for pre-existing history. A present-but-corrupt value is treated
 * as primed (empty set) so a bad write can't trigger a cold-start flood.
 */
async function loadSeenIds(
  key: string = BG_SEEN_IDS_KEY,
): Promise<{ seen: Set<string>; primed: boolean }> {
  const raw = await AsyncStorage.getItem(key).catch(() => null);
  if (raw == null) return { seen: new Set(), primed: false };
  try {
    const arr: unknown = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return { seen: new Set(arr.filter((x): x is string => typeof x === 'string')), primed: true };
    }
  } catch {
    // fall through to the primed-but-empty fallback
  }
  return { seen: new Set(), primed: true };
}

/** Persist the seen-set, keeping only the most-recent SEEN_CAP ids. */
async function persistSeenIds(seen: Set<string>, key: string = BG_SEEN_IDS_KEY): Promise<void> {
  const arr = Array.from(seen); // insertion order → tail is newest
  const bounded = arr.length > SEEN_CAP ? arr.slice(arr.length - SEEN_CAP) : arr;
  await AsyncStorage.setItem(key, JSON.stringify(bounded)).catch(() => {});
}

/**
 * One background sync pass. Safe to call repeatedly; swallows its own
 * errors so a flaky relay never crashes the native host.
 */
export async function runBackgroundSync(): Promise<BackgroundSyncResult> {
  const activePubkey = __DEV__
    ? await initialiseBackgroundRelayAccount()
    : (await loadIdentities()).activePubkey;
  if (!activePubkey) return { pinged: false, freshCount: 0, freshCacheCommentCount: 0 };

  const readRelays = lockRelays(
    (await getUserRelays()).filter((r) => r.read).map((r) => r.url),
    activePubkey,
  );
  if (readRelays.length === 0) return { pinged: false, freshCount: 0, freshCacheCommentCount: 0 };

  // Run the two detect-and-ping passes sequentially — they touch
  // disjoint persisted seen-sets and disjoint kinds on the relay, so a
  // failure in one must not poison the other (the catch on each pass is
  // independent and falls through with a 0 count).
  const dmResult = await runDmDetectAndPing(activePubkey, readRelays);
  const cacheResult = await runCacheCommentDetectAndPing(activePubkey, readRelays);

  return {
    pinged: dmResult.pinged || cacheResult.pinged,
    freshCount: dmResult.freshCount,
    freshCacheCommentCount: cacheResult.freshCount,
  };
}

/**
 * DM detect-and-ping pass — kind-1059 + kind-4 addressed to the viewer.
 */
async function runDmDetectAndPing(
  activePubkey: string,
  readRelays: string[],
): Promise<{ pinged: boolean; freshCount: number }> {
  const { seen, primed } = await loadSeenIds();
  const since = Math.floor(Date.now() / 1000) - LOOKBACK_SEC;

  try {
    // NIP-17 gift wraps and legacy NIP-04 DMs, addressed via a `#p` tag.
    // Gamma orders exist only inside gift wraps, never as public events.
    const events = await pool.querySync(
      readRelays,
      {
        kinds: [1059, 4],
        '#p': [activePubkey],
        since,
        limit: SEEN_CAP,
      },
      { maxWait: QUERY_MAXWAIT_MS },
    );

    // Genuinely-new = an id we haven't accounted for, excluding our own
    // kind-4 echoes (real author === us). kind-1059 wrap authors are
    // ephemeral throwaway keys, so we can't distinguish a received wrap from
    // our own sent-copy without decrypting — we accept the rare false ping
    // (the app reconciles exactly on open).
    const muted = await loadMutedSenders(activePubkey);
    const fresh = events.filter((e) => {
      // A gift-wrap author is ephemeral; its sender cannot be learned here.
      if (e.kind !== 1059 && muted.has(e.pubkey.toLowerCase())) return false;
      if (seen.has(e.id)) return false;
      if (e.kind === 4 && e.pubkey === activePubkey) return false;
      if (e.kind === 16 || e.kind === 17) return false;
      return true;
    });

    // Record everything we saw so the next wake won't reconsider it.
    for (const e of events) seen.add(e.id);
    await persistSeenIds(seen);

    // First-ever run: we've just established the baseline above. Everything
    // currently on the relays is history the user may already have read
    // in-app, so pinging for it would be a cold-start flood. Stay silent;
    // only arrivals AFTER this baseline ping on later wakes.
    if (!primed) return { pinged: false, freshCount: 0 };
    // The app is alive with its live DM sub in this JS context (WorkManager
    // runs the task in the existing React instance): what that sub decrypted
    // it has already alerted for — by name — or rightly skipped (our own sent
    // copy, a stranger, a reaction). Pinging for those would repeat the alert
    // up to 15 min later, or announce nothing new. Only what it never got to
    // (socket down, remote signer unavailable) still pings.
    const unhandled = isLiveDmSubArmed() ? fresh.filter((e) => !wasWrapHandled(e.id)) : fresh;

    const freshCount = unhandled.length;
    if (freshCount > 0) {
      await fireMessageNotification({
        kind: 'dm',
        // Headless run: name the owner explicitly for the history (#1143).
        owner: activePubkey,
        // Sentinel thread id — never matches an actively-viewed thread, so
        // the suppression gate always lets a background ping through.
        threadId: '__background__',
        title: freshCount > 1 ? 'New messages' : 'New message',
        body: 'Open Lightning Piggy to read',
        // Where a tap should go, without decrypting (#1154): a NIP-04 sender
        // is public, and a lone NIP-17 wrap can be resolved after the app
        // decrypts it. Anything else (mixed senders) opens the Messages list.
        data: messageNotificationTarget(unhandled),
      });
    }
    return { pinged: freshCount > 0, freshCount };
  } catch {
    // Best-effort: a failed relay round-trip just means we retry next wake.
    return { pinged: false, freshCount: 0 };
  }
}

/**
 * Find-log detect-and-ping pass (#740) — kind-1111 NIP-22 comments whose
 * `#A` root pointer matches one of the active user's published caches.
 * Pattern mirrors the DM pass: query a window, dedupe against a persisted
 * seen-set, fire a single generic notification on fresh arrivals.
 *
 * "My caches" comes from a one-shot author-listing query rather than a
 * persisted snapshot, for two reasons: (a) the background JS context is
 * disjoint from the foreground React tree, so we can't read NostrContext's
 * in-memory cache list; (b) author-listings are tiny (kind-37516 by one
 * pubkey is replaceable and bounded) so the extra round-trip is cheap.
 * No caches → no filter armed → silent return.
 */
async function runCacheCommentDetectAndPing(
  activePubkey: string,
  readRelays: string[],
): Promise<{ pinged: boolean; freshCount: number }> {
  let myCoords: string[] = [];
  try {
    const mine = await fetchCachesByAuthor(activePubkey, readRelays);
    myCoords = mine.map((c) => c.coord);
  } catch {
    // Author-listing failed — skip this pass without poisoning the next.
    return { pinged: false, freshCount: 0 };
  }
  if (myCoords.length === 0) {
    // Persist an empty seen-set on the no-cache path so the baseline is
    // marked as primed — otherwise the very first background pass after
    // the user publishes their first cache would treat pre-existing
    // find-logs (within the 1-day window) as baseline (!primed) and
    // silently swallow them. Idempotent: skip the write if already primed
    // (a previous run with caches that since vanished). Copilot review #742.
    const { primed: alreadyPrimed } = await loadSeenIds(BG_SEEN_CACHE_COMMENT_IDS_KEY);
    if (!alreadyPrimed) await persistSeenIds(new Set(), BG_SEEN_CACHE_COMMENT_IDS_KEY);
    return { pinged: false, freshCount: 0 };
  }

  const { seen, primed } = await loadSeenIds(BG_SEEN_CACHE_COMMENT_IDS_KEY);
  const since = Math.floor(Date.now() / 1000) - CACHE_COMMENT_LOOKBACK_SEC;

  try {
    const events = await pool.querySync(
      readRelays,
      {
        kinds: [GC_COMMENT_KIND],
        '#A': myCoords,
        since,
      },
      { maxWait: QUERY_MAXWAIT_MS },
    );

    // Genuinely-new = not in the seen-set AND not our own echo (a hider
    // commenting on their own cache is a maintenance note, not a find we
    // want to self-ping for).
    const fresh = events.filter((e) => !seen.has(e.id) && e.pubkey !== activePubkey);

    for (const e of events) seen.add(e.id);
    await persistSeenIds(seen, BG_SEEN_CACHE_COMMENT_IDS_KEY);

    // First-ever run primes a silent baseline so any historical find-logs
    // already on the relays don't fire a cold-start flood. Same shape as
    // the DM pass.
    if (!primed) return { pinged: false, freshCount: 0 };

    const freshCount = fresh.length;
    if (freshCount > 0) {
      await fireCacheNotification({
        owner: activePubkey,
        // Sentinel coord — never matches an actively-viewed cache, so the
        // suppression gate always lets a background ping through. The tap
        // router falls back to the Geo-caches list when the coord can't
        // be resolved to a specific detail screen.
        cacheCoord: '__background__',
        title: freshCount > 1 ? 'New finds on your caches' : 'New find on your cache',
        body: 'Open Lightning Piggy to view',
      });
    }
    return { pinged: freshCount > 0, freshCount };
  } catch {
    return { pinged: false, freshCount: 0 };
  }
}
