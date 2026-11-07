// L2 (friends-of-friends) half of the Web of Trust (#565).
//
// The first FoF implementation fetched an UNCAPPED L2 set (~32k pubkeys, a
// ~2 MB AsyncStorage blob) on every cold start, for every user — a 20-30 s
// JS-thread freeze once the blob hit Android's SQLite CursorWindow ceiling.
// This hook replaces it with the same safe pipeline the Market uses
// (`friendsOfFriendsService`):
//
//   - On demand only. Nothing is read or fetched unless the tier is 'fof'.
//     Choosing 'fof' (`enableFof`) builds the set in the foreground — the
//     Web of Trust sheet shows "X of Y" progress with Cancel — and the tier
//     only switches once the set is complete. Cancel or failure leaves the
//     tier where it was and persists nothing.
//   - Capped + ranked: the WOT_FOF_MAX pubkeys followed by the most friends,
//     ~135 KB stored, one key per (account, cap).
//   - A persisted 'fof' tier loads its cached set (one bounded read) and, if
//     it has expired or the follow list changed, rebuilds it in the
//     background after a cancellable delay, so startup work settles first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { computeFofSet, FOF_CACHE_TTL_MS, loadFofCache } from '../services/friendsOfFriendsService';
import { fetchFollowLists } from '../services/followListsFetcher';
import { useAccountState } from './useAccountState';
import { PERF_LOGS_ENABLED } from '../utils/perfLog';
import { startJsStallProbe, type JsStallProbe } from '../utils/jsStallProbe';
import type { WotTier } from '../services/wotSettingsService';

/**
 * Ranked cap for the Web of Trust friends-of-friends set. The trust filter is
 * a local `Set.has` check, not a relay query by author, so it can afford more
 * than the Market's 1024. 2000 is still:
 *   - ~135 KB of JSON (2000 × 64-hex + quotes/commas) — ~7 % of the 2 MB
 *     CursorWindow that the uncapped ~32k-entry blob overflowed;
 *   - far more than the number of second-degree accounts followed by 2+ of a
 *     typical user's friends, i.e. it keeps every strong FoF signal and drops
 *     only the long tail followed by a single friend (bots, curators' lists);
 *   - small enough that `computeTrustSet` over friends ∪ L2 stays O(ms).
 */
export const WOT_FOF_MAX = 2000;
/** Startup work settles before a stale persisted set is rebuilt in the background. */
export const L2_BACKGROUND_REFRESH_DELAY_MS = 8_000;
/** Resume work staggers (CLAUDE.md → AppState handlers); only DM re-arm is immediate. */
export const L2_RESUME_CHECK_DELAY_MS = 3_000;

export interface FofBuildProgress {
  /** Follow-list batches (50 friends each) fetched so far. */
  done: number;
  total: number;
}

export interface TrustGraphL2Status {
  /** True while a build is running (foreground or background). */
  building: boolean;
  /** Per-batch progress of the running build; `total` is 0 until the first batch. */
  progress: FofBuildProgress | null;
  /** The last build failed (relays unreachable, …). Cleared by the next build. */
  failed: boolean;
}

interface L2Snapshot {
  set: ReadonlySet<string>;
  computedAt: number;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const IDLE: TrustGraphL2Status = { building: false, progress: null, failed: false };

type BuildMode = 'enable' | 'refresh' | 'background';

interface Params {
  pubkey: string | null;
  friends: ReadonlySet<string>;
  /** The user's read relays (follow-list indexers are added by the fetcher). */
  readRelays: readonly string[];
  wotTier: WotTier;
  wotTierReady: boolean;
  /** Persist a tier without side effects (the build's own success path). */
  persistTier: (tier: WotTier) => void;
}

export function useTrustGraphL2({
  pubkey,
  friends,
  readRelays,
  wotTier,
  wotTierReady,
  persistTier,
}: Params) {
  const [l2, setL2] = useAccountState<L2Snapshot | null>(pubkey, null);
  const [status, setStatus] = useAccountState<TrustGraphL2Status>(pubkey, IDLE);
  const controllerRef = useRef<AbortController | null>(null);
  const l2ComputedAtRef = useRef<number | null>(null);
  l2ComputedAtRef.current = l2?.computedAt ?? null;
  // One unattended rebuild per (account, follow list, cached build), so a
  // relay outage can't turn into a retry loop — yet a set rebuilt
  // successfully gets its own attempt once it, too, expires.
  const autoAttemptRef = useRef<string | null>(null);
  // Bumped when a resumed app finds the in-memory set past its TTL.
  const [expiryTick, setExpiryTick] = useState(0);

  // Keyed on CONTENT: NostrContext replaces `contacts` (so a new `friends`
  // Set) on every kind-0 batch during profile hydration. Deriving the list
  // from the string key keeps `runBuild` and the load effect stable across
  // those equal-content updates (no cache re-read, no reset 8 s timer).
  const friendsKey = useMemo(() => [...friends].sort().join(','), [friends]);
  const friendsList = useMemo(() => (friendsKey ? friendsKey.split(',') : []), [friendsKey]);
  const relaysKey = useMemo(() => [...readRelays].sort().join(','), [readRelays]);

  const applySnapshot = useCallback(
    (snapshot: L2Snapshot) => {
      // Re-reading the same build must not mint a new Set identity: every
      // trust-filter memo downstream (MessagesScreen's inbox) keys on it.
      if (l2ComputedAtRef.current === snapshot.computedAt) return;
      l2ComputedAtRef.current = snapshot.computedAt;
      setL2(snapshot);
    },
    [setL2],
  );

  const cancelL2 = useCallback(() => {
    if (!controllerRef.current) return;
    controllerRef.current.abort();
    controllerRef.current = null;
    setStatus(IDLE);
  }, [setStatus]);

  const runBuild = useCallback(
    async (mode: BuildMode): Promise<void> => {
      if (!pubkey) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const { signal } = controller;
      setStatus({ building: true, progress: { done: 0, total: 0 }, failed: false });
      let probe: JsStallProbe | null = null;
      try {
        if (mode === 'enable') {
          // A fresh cached set (built within 24 h for this follow list)
          // switches instantly — no relay round trip.
          const cached = await loadFofCache(pubkey, friendsList, WOT_FOF_MAX);
          if (signal.aborted) return;
          if (cached) {
            applySnapshot(cached);
            persistTier('fof');
            setStatus(IDLE);
            return;
          }
        }
        const relays = relaysKey ? relaysKey.split(',') : [];
        // Dev / preview builds only: how long the build took and the worst
        // JS-thread stall while it ran (#565 perf proof).
        const startedAt = Date.now();
        probe = PERF_LOGS_ENABLED ? startJsStallProbe() : null;
        const result = await computeFofSet(pubkey, friendsList, {
          maxSize: WOT_FOF_MAX,
          signal,
          fetchKind3: (batch) => fetchFollowLists(batch, relays, signal),
          // Once per 50-friend batch, never per relay event.
          onProgress: (done, total) => {
            if (!signal.aborted) setStatus((prev) => ({ ...prev, progress: { done, total } }));
          },
        });
        if (probe) {
          const stall = probe.stop();
          console.log(
            `[PerfBlock] wot fof build (${mode}): ${Date.now() - startedAt}ms, ` +
              `${friendsList.length} friends → ${result.set.size} pubkeys, ` +
              `js max stall ${stall.maxMs}ms, blocked ${stall.blockedMs}ms`,
          );
        }
        if (signal.aborted) return;
        applySnapshot(result);
        if (mode === 'enable') persistTier('fof');
        setStatus(IDLE);
      } catch {
        // Cancel already reset the status; a failure keeps the tier as it was.
        if (!signal.aborted) setStatus({ building: false, progress: null, failed: true });
      } finally {
        probe?.stop(); // no-op after a successful build already reported
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [pubkey, friendsList, relaysKey, applySnapshot, persistTier, setStatus],
  );

  const enableFof = useCallback(() => {
    void runBuild('enable');
  }, [runBuild]);

  const refreshL2 = useCallback(() => runBuild('refresh'), [runBuild]);

  // Persisted 'fof': load the cached set (one bounded read), and rebuild a
  // stale one after startup settles. Any other tier: nothing at all (#565).
  // With no direct friends there are no friends of friends: nothing is read,
  // and a set cached before the last unfollow is never restored.
  useEffect(() => {
    if (!pubkey || !wotTierReady || wotTier !== 'fof' || !friendsKey) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void loadFofCache(pubkey, friendsKey.split(','), WOT_FOF_MAX, {
      allowStale: true,
    }).then((cached) => {
      if (cancelled) return;
      if (cached) applySnapshot(cached);
      if (cached && !cached.stale) return;
      const attemptKey = `${pubkey}|${friendsKey}|${cached?.computedAt ?? 'none'}`;
      if (autoAttemptRef.current === attemptKey) return;
      timer = setTimeout(() => {
        if (controllerRef.current) return; // a foreground build is already running
        autoAttemptRef.current = attemptKey;
        void runBuild('background');
      }, L2_BACKGROUND_REFRESH_DELAY_MS);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [pubkey, wotTier, wotTierReady, friendsKey, expiryTick, applySnapshot, runBuild]);

  // An app left open (backgrounded) past the 24 h TTL re-checks on resume,
  // staggered so it never competes with latency-sensitive resume work.
  useEffect(() => {
    if (!pubkey || wotTier !== 'fof') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const at = l2ComputedAtRef.current;
        if (at !== null && Date.now() - at > FOF_CACHE_TTL_MS) setExpiryTick((n) => n + 1);
      }, L2_RESUME_CHECK_DELAY_MS);
    });
    return () => {
      sub.remove();
      if (timer) clearTimeout(timer);
    };
  }, [pubkey, wotTier]);

  // An account switch (or unmount) abandons the previous account's build.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [pubkey],
  );

  return {
    l2Follows: friendsKey ? (l2?.set ?? EMPTY_SET) : EMPTY_SET,
    status,
    enableFof,
    cancelL2,
    refreshL2,
  };
}
