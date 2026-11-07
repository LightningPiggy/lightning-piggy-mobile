import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import {
  computeFofSet,
  dropFofCache,
  loadFofCache,
  FOF_CACHE_TTL_MS,
  FOF_SHARED_MAX,
} from '../services/friendsOfFriendsService';
import { fetchFollowLists } from '../services/followListsFetcher';
import { marketFofAuthors, MARKET_FOF_MAX } from '../utils/marketFofScope';

/** Progress of a friends-of-friends build: follow-list batches done / total. */
export interface FofProgress {
  done: number;
  total: number;
}

// The last built set, per account + follow list, so flipping scopes or
// refocusing the Market reuses it without even an AsyncStorage read. (The
// service's own 24 h AsyncStorage cache covers app restarts.)
const FAILURE_COOLDOWN_MS = 30_000;
let memo: {
  key: string;
  fof: readonly string[];
  failedUntil?: number;
  computedAt?: number;
} | null = null;

function cachedMemo(key: string) {
  if (memo?.key !== key) return null;
  if (memo.failedUntil !== undefined) {
    if (Date.now() >= memo.failedUntil) return null;
  } else if (memo.computedAt === undefined || Date.now() - memo.computedAt > FOF_CACHE_TTL_MS) {
    return null;
  }
  return memo;
}

// Accounts whose pre-sharing cap-1024 blob has been dropped this session.
const droppedLegacy = new Set<string>();

/** Test hook: forget the in-memory set. */
export const __resetMarketFofMemo = () => {
  memo = null;
  droppedLegacy.clear();
};

/** The Market's slice of the shared ranked set: its first MARKET_FOF_MAX (most-shared first). */
export function marketFofSlice(set: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const pk of set) {
    if (out.length >= MARKET_FOF_MAX) break;
    out.push(pk);
  }
  return out;
}

/**
 * Seller set for the Market's friends-of-friends scope: the viewer's follows
 * plus the follows-of-follows from the shared `friendsOfFriendsService`
 * (high-fanout / bot exclusion, per-friend caps, ranked cap, 24 h cache).
 * It is the SAME set the Messages Web of Trust tier uses (FOF_SHARED_MAX),
 * sliced to the Market's MARKET_FOF_MAX: a set either one built or read is
 * reused from the service's memory or cache, and a build already running for
 * Messages is joined rather than repeated.
 *
 * Built only while `enabled` and the screen is focused; blurring aborts it.
 * Pull-to-refresh reloads listings, not the graph — the service's 24 h TTL
 * (and any follow / unfollow, via its friend-set hash) decides when to rebuild.
 * Progress updates once per follow-list batch, never per relay event.
 * `authors` stays undefined until the set is known; on failure it falls back
 * to the follows alone and `failed` is set.
 */
export function useMarketFofAuthors(enabled: boolean) {
  const { pubkey, relays } = useNostr();
  const { contacts } = useNostrContacts();
  const friendsKey = useMemo(
    () => [...new Set(contacts.map((c) => c.pubkey.toLowerCase()))].sort().join(','),
    [contacts],
  );
  const relaysKey = useMemo(
    () =>
      relays
        .filter((r) => r.read)
        .map((r) => r.url)
        .sort()
        .join(','),
    [relays],
  );
  const key = `${pubkey ?? ''}|${friendsKey}`;
  const [state, setState] = useState<{
    key: string;
    fof: readonly string[] | undefined;
    failed: boolean;
    progress: FofProgress | null;
  }>(() => {
    const cached = cachedMemo(key);
    return {
      key,
      fof: cached?.fof,
      failed: cached?.failedUntil !== undefined,
      progress: null,
    };
  });
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !pubkey) return;
      const cached = cachedMemo(key);
      if (cached) {
        const fof = cached.fof;
        const failed = cached.failedUntil !== undefined;
        setState((prev) =>
          prev.key === key && prev.fof === fof && prev.failed === failed
            ? prev
            : { key, fof, failed, progress: null },
        );
        return;
      }
      const friends = friendsKey ? friendsKey.split(',') : [];
      const controller = new AbortController();
      const { signal } = controller;
      setState((prev) =>
        prev.key === key ? prev : { key, fof: undefined, failed: false, progress: null },
      );
      void (async () => {
        try {
          const cached = await loadFofCache(pubkey, friends, FOF_SHARED_MAX);
          if (signal.aborted) return;
          // Cache miss: say so at once, before the first batch lands.
          if (!cached) setState((prev) => ({ ...prev, key, progress: { done: 0, total: 0 } }));
          const result =
            cached ??
            (await computeFofSet(pubkey, friends, {
              maxSize: FOF_SHARED_MAX,
              signal,
              // The service's signal: a shared build outlives our cancel.
              fetchKind3: (batch, buildSignal) =>
                fetchFollowLists(batch, relaysKey.split(','), buildSignal),
              onProgress: (done, total) => {
                if (!signal.aborted)
                  setState((prev) => ({ ...prev, key, progress: { done, total } }));
              },
            }));
          if (signal.aborted) return;
          const fof = marketFofSlice(result.set);
          memo = { key, fof, computedAt: result.computedAt };
          setState({ key, fof, failed: false, progress: null });
          // The Market's own cap-1024 set (before it shared Messages') is
          // never read again: free its storage once per account.
          if (!droppedLegacy.has(pubkey)) {
            droppedLegacy.add(pubkey);
            void dropFofCache(pubkey, MARKET_FOF_MAX);
          }
        } catch {
          if (signal.aborted) return;
          const fof: readonly string[] = [];
          memo = { key, fof, failedUntil: Date.now() + FAILURE_COOLDOWN_MS };
          setState({ key, fof, failed: true, progress: null });
        }
      })();
      return () => controller.abort();
    }, [enabled, pubkey, key, friendsKey, relaysKey]),
  );

  const current = state.key === key ? state : null;
  const authors = useMemo(
    () =>
      current?.fof === undefined
        ? undefined
        : marketFofAuthors(friendsKey ? friendsKey.split(',') : [], current.fof),
    [current?.fof, friendsKey],
  );
  return {
    authors,
    progress: current?.progress ?? null,
    failed: current?.failed ?? false,
  };
}
