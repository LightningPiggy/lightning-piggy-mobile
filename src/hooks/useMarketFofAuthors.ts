import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { computeFofSet, loadFofCache, FOF_CACHE_TTL_MS } from '../services/friendsOfFriendsService';
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

/** Test hook: forget the in-memory set. */
export const __resetMarketFofMemo = () => {
  memo = null;
};

/**
 * Seller set for the Market's friends-of-friends scope: the viewer's follows
 * plus the follows-of-follows from the shared `friendsOfFriendsService`
 * (high-fanout / bot exclusion, per-friend caps, ranked cap, 24 h cache) —
 * the same computation the Web of Trust tiers are built on.
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
          const cached = await loadFofCache(pubkey, friends, MARKET_FOF_MAX);
          if (signal.aborted) return;
          // Cache miss: say so at once, before the first batch lands.
          if (!cached) setState((prev) => ({ ...prev, key, progress: { done: 0, total: 0 } }));
          const result =
            cached ??
            (await computeFofSet(pubkey, friends, {
              maxSize: MARKET_FOF_MAX,
              signal,
              fetchKind3: (batch) => fetchFollowLists(batch, relaysKey.split(','), signal),
              onProgress: (done, total) => {
                if (!signal.aborted)
                  setState((prev) => ({ ...prev, key, progress: { done, total } }));
              },
            }));
          if (signal.aborted) return;
          const fof = [...result.set];
          memo = { key, fof, computedAt: result.computedAt };
          setState({ key, fof, failed: false, progress: null });
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
