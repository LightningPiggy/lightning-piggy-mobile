// Friends-of-friends (FoF) set computation for the WoT tier picker (#535)
// and the Market's friends-of-friends scope.
//
// Pure logic — relay I/O is injected via `fetchKind3` so jest can mock it
// without spinning up the real pool. Persistence is via AsyncStorage with a
// 24 h TTL, one key per (account, ranked cap) — see `fofCacheKey`.
//
// Anti-pollution heuristics (issue #535):
//   1. Exclude friends with > FANOUT_CAP (500) follows from the FoF union —
//      removes the worst noise (curators, rebroadcaster bots).
//   2. Cap each contributing friend at their first FANOUT_CAP follows
//      (belt-and-braces ceiling; kind-3 events have no per-tag timestamp so
//      we slice in tag order).
//   3. Soft-cap fallback: if heuristic #1 would leave < 50 % of friends
//      contributing, drop the exclusion and let everyone contribute (with
//      heuristic #2 still applied). Users with few friends would otherwise
//      get a FoF dominated by 1-2 outliers.
//   4. Optional ranked cap (`maxSize`): keep only the N pubkeys followed by
//      the most contributing friends. A consumer that queries relays BY
//      author (the Market's friends-of-friends scope) can't ask for tens of
//      thousands of authors, and the most-shared follows are the strongest
//      trust signal. It also keeps the cached blob far below Android's
//      CursorWindow ceiling (#565).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { perAccountKey } from './perAccountStorage';

// 500 follows is the threshold from #535. Anyone above this is treated as
// a high-fanout account (curator / bot) and dropped from the FoF expansion;
// their own posts still pass under the Friends tier.
export const FANOUT_CAP = 500;
// Soft-cap fallback: if heuristic #1 leaves <50% of friends contributing,
// drop the exclusion. Stops a 3-friends-over-cap user from getting an
// FoF dominated by their remaining 2 friends.
export const SOFT_CAP_MIN_RATIO = 0.5;
// One key per (account, cap): `@lp:wot-fof:v3:cap-<N|all>_<pubkey>`. The
// Market (cap 1024) and the Web of Trust tier (cap 2000) each keep their own
// set, and signing out removes only that account's keys (#565).
const FOF_CACHE_KEY_PREFIX = '@lp:wot-fof:v3:';
// Pre-#565 single device-wide key (whichever account / cap wrote last won).
// Not attributable to an account, so it is simply deleted.
export const LEGACY_FOF_CACHE_KEY = '@lp:wot-fof:v2';
export const FOF_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface FofResult {
  set: Set<string>;
  excludedFriends: number;
  computedAt: number;
}

interface CacheEntry {
  userPubkey: string;
  // The ranked cap the set was built with (absent = uncapped). A capped and
  // an uncapped set are different results, so a reader with another cap
  // must not reuse it.
  maxSize?: number;
  // Stable hash of the input friend set; if the user follows/unfollows we
  // want the cache to invalidate even within the TTL window.
  friendsHash: string;
  // Serialized form of the set (most-shared first when capped).
  setArr: string[];
  excludedFriends: number;
  computedAt: number;
}

/** AsyncStorage key for one account's FoF set built with one ranked cap. */
export const fofCacheKey = (userPubkey: string, maxSize?: number): string =>
  perAccountKey(`${FOF_CACHE_KEY_PREFIX}cap-${maxSize ?? 'all'}`, userPubkey.toLowerCase());

/** True for any of `userPubkey`'s FoF cache keys (every cap) — sign-out wipe. */
export const isFofCacheKeyFor = (key: string, userPubkey: string): boolean =>
  key.startsWith(FOF_CACHE_KEY_PREFIX) && key.endsWith(`_${userPubkey.toLowerCase()}`);

const hashFriends = (friends: readonly string[]): string => {
  const sorted = [...friends].map((s) => s.toLowerCase()).sort();
  let h = 0;
  for (const s of sorted) {
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return `${sorted.length}:${h}`;
};

const abortError = () => Object.assign(new Error('FoF compute aborted'), { name: 'AbortError' });

export interface ComputeFofOptions {
  // Inject the relay layer so this module stays pure-logic + unit-testable.
  // Returns a mapping from friend pubkey to that friend's full follow list
  // (kind-3 `p` tags). Missing pubkeys are treated as "kind-3 not yet
  // fetched" — they contribute 0 follows, same as a friend with no
  // contact list published.
  fetchKind3: (pubkeys: string[]) => Promise<Record<string, string[]>>;
  // Optional progress callback so the bottom sheet can render "Fetching N / M".
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
  // Ranked cap (heuristic 4) — keep the `maxSize` most-shared pubkeys.
  maxSize?: number;
}

interface FofPlan {
  friendSet: Set<string>;
  userLower: string | null;
  // Friends whose follows are tallied, in input order.
  contributors: string[];
  excludedFriends: number;
}

// Heuristics 1 + 3: decide which friends contribute.
const planFof = (
  userPubkey: string | null,
  myFollows: readonly string[],
  followListsByFriend: Record<string, readonly string[]>,
): FofPlan => {
  const friendsLower = [...new Set(myFollows.map((p) => p.toLowerCase()))];
  const friendSet = new Set(friendsLower);
  // A friend is "over cap" when their kind-3 lists > FANOUT_CAP follows.
  // Friends with no kind-3 fetched are treated as under-cap (contribute 0).
  const overCap = new Set<string>();
  for (const friend of friendsLower) {
    const list = followListsByFriend[friend];
    if (list && list.length > FANOUT_CAP) overCap.add(friend);
  }
  // Soft-cap fallback (heuristic 3): if applying #1 leaves fewer than
  // SOFT_CAP_MIN_RATIO of friends contributing, drop the exclusion.
  const contributing = friendsLower.length - overCap.size;
  const applyHighFanoutExclusion =
    friendsLower.length === 0 || contributing / friendsLower.length >= SOFT_CAP_MIN_RATIO;
  const contributors: string[] = [];
  let excludedFriends = 0;
  for (const friend of friendsLower) {
    if (applyHighFanoutExclusion && overCap.has(friend)) {
      excludedFriends += 1;
      continue;
    }
    if (followListsByFriend[friend]) contributors.push(friend);
  }
  return {
    friendSet,
    userLower: userPubkey ? userPubkey.toLowerCase() : null,
    contributors,
    excludedFriends,
  };
};

// Heuristic 2 + the tally: one friend's (capped) follows each add 1 to the
// count of every pubkey they follow. Map keeps discovery order, the
// tie-break for the ranked cap.
const tallyFriend = (fof: Map<string, number>, list: readonly string[], plan: FofPlan): void => {
  // Kind-3 `p` tags have no timestamps so "first N" is roughly add-order
  // and client-dependent — acknowledged in #535.
  for (const lower of new Set(list.slice(0, FANOUT_CAP).map((p) => p.toLowerCase()))) {
    // FoF tier explicitly excludes the user + their direct friends — those
    // already pass under the Friends tier, so including them here would
    // muddle the "n of friends excluded" reporting and add dead weight.
    if (lower === plan.userLower || plan.friendSet.has(lower)) continue;
    fof.set(lower, (fof.get(lower) ?? 0) + 1);
  }
};

// Heuristic 4 — counting sort by "friends who follow it" (bounded by the
// friend count), so ranking ~100k candidates is O(n) rather than a
// comparison sort. Equal counts keep discovery order (same result as a
// stable descending sort). `buckets[count]` lists pubkeys in discovery order.
const topOfBuckets = (buckets: string[][], maxSize: number): Set<string> => {
  const limit = Math.max(0, maxSize);
  const out = new Set<string>();
  for (let count = buckets.length - 1; count > 0 && out.size < limit; count -= 1) {
    for (const pk of buckets[count] ?? []) {
      if (out.size >= limit) break;
      out.add(pk);
    }
  }
  return out;
};

// Pure core — no relay or storage I/O. Takes the already-fetched kind-3
// data and applies the heuristics. Exported so tests can target the logic
// directly without stubbing fetchKind3. With `maxSize`, the returned Set
// iterates most-shared first (heuristic 4); without it, in discovery order.
export const buildFofSet = (
  userPubkey: string | null,
  myFollows: readonly string[],
  followListsByFriend: Record<string, readonly string[]>,
  maxSize?: number,
): { set: Set<string>; excludedFriends: number } => {
  const plan = planFof(userPubkey, myFollows, followListsByFriend);
  const fof = new Map<string, number>();
  for (const friend of plan.contributors) tallyFriend(fof, followListsByFriend[friend], plan);
  if (maxSize === undefined)
    return { set: new Set(fof.keys()), excludedFriends: plan.excludedFriends };
  const buckets: string[][] = [];
  for (const [pk, count] of fof) (buckets[count] ??= []).push(pk);
  return { set: topOfBuckets(buckets, maxSize), excludedFriends: plan.excludedFriends };
};

// Bucketing yields every this many candidates: a real graph can hold well
// over 100k distinct follows-of-follows.
const RANK_YIELD_EVERY = 1024;

/**
 * `buildFofSet`, but cooperative: yields the JS thread between friends via
 * the budget-gated scheduler (one RAF per ~4 ms of work, not per friend) so
 * tallying hundreds of 500-follow lists never stalls taps or paint (#565).
 * Rejects with an AbortError — and returns nothing — once `signal` fires.
 */
export const buildFofSetYielding = async (
  userPubkey: string | null,
  myFollows: readonly string[],
  followListsByFriend: Record<string, readonly string[]>,
  maxSize?: number,
  signal?: AbortSignal,
): Promise<{ set: Set<string>; excludedFriends: number }> => {
  const scheduler = createYieldScheduler({ signal, safetyEvery: 32 });
  try {
    const plan = planFof(userPubkey, myFollows, followListsByFriend);
    const fof = new Map<string, number>();
    for (const friend of plan.contributors) {
      await scheduler.maybeYield();
      if (signal?.aborted) throw abortError();
      tallyFriend(fof, followListsByFriend[friend], plan);
    }
    await scheduler.maybeYield();
    if (signal?.aborted) throw abortError();
    if (maxSize === undefined) {
      return { set: new Set(fof.keys()), excludedFriends: plan.excludedFriends };
    }
    const buckets: string[][] = [];
    let seen = 0;
    for (const [pk, count] of fof) {
      (buckets[count] ??= []).push(pk);
      if (++seen % RANK_YIELD_EVERY === 0) {
        await scheduler.maybeYield();
        if (signal?.aborted) throw abortError();
      }
    }
    return { set: topOfBuckets(buckets, maxSize), excludedFriends: plan.excludedFriends };
  } finally {
    scheduler.dispose();
  }
};

// Full pipeline: fetch kind-3 lists, apply heuristics, persist with TTL.
// Returns the FoF set + how many friends were excluded by heuristic 1.
// An aborted or failed run rejects and persists nothing.
export const computeFofSet = async (
  userPubkey: string | null,
  myFollows: readonly string[],
  opts: ComputeFofOptions,
): Promise<FofResult> => {
  // A sign-out wipe that lands while this build runs retires the account:
  // the finished build must not write the graph back afterwards.
  const epoch = accountEpoch(userPubkey);
  const friendsLower = [...new Set(myFollows.map((p) => p.toLowerCase()))];
  if (friendsLower.length === 0) {
    return { set: new Set(), excludedFriends: 0, computedAt: Date.now() };
  }
  // Chunk into 50-author batches, fetched one batch at a time, so a single
  // relay is never asked for 500 authors in one filter and at most 50
  // kind-3 lists are in flight — matches the chunking note in #535 / #565.
  const BATCH_SIZE = 50;
  const batches: string[][] = [];
  for (let i = 0; i < friendsLower.length; i += BATCH_SIZE) {
    batches.push(friendsLower.slice(i, i + BATCH_SIZE));
  }
  const followLists: Record<string, string[]> = {};
  let done = 0;
  for (const batch of batches) {
    if (opts.signal?.aborted) throw abortError();
    const partial = await opts.fetchKind3(batch);
    for (const [k, v] of Object.entries(partial)) followLists[k.toLowerCase()] = v;
    done += 1;
    opts.onProgress?.(done, batches.length);
  }
  const { set, excludedFriends } = await buildFofSetYielding(
    userPubkey,
    friendsLower,
    followLists,
    opts.maxSize,
    opts.signal,
  );
  if (opts.signal?.aborted) throw abortError();
  const result: FofResult = { set, excludedFriends, computedAt: Date.now() };
  await writeFofCache(userPubkey, friendsLower, result, opts.maxSize, epoch);
  return result;
};

export interface LoadFofCacheOptions {
  // Return an expired / follow-list-mismatched entry too (flagged `stale`)
  // so a caller can show the last good set while it rebuilds.
  allowStale?: boolean;
}

// Readers invalidate on TTL or friend-set hash mismatch (unless `allowStale`).
export const loadFofCache = async (
  userPubkey: string | null,
  currentFriends: readonly string[],
  maxSize?: number,
  opts: LoadFofCacheOptions = {},
): Promise<(FofResult & { stale: boolean }) | null> => {
  if (!userPubkey) return null;
  try {
    const raw = await AsyncStorage.getItem(fofCacheKey(userPubkey, maxSize));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.userPubkey !== userPubkey.toLowerCase()) return null;
    if (parsed.maxSize !== maxSize || !Array.isArray(parsed.setArr)) return null;
    const stale =
      Date.now() - parsed.computedAt > FOF_CACHE_TTL_MS ||
      parsed.friendsHash !== hashFriends(currentFriends);
    if (stale && !opts.allowStale) return null;
    return {
      set: new Set(parsed.setArr),
      excludedFriends: parsed.excludedFriends,
      computedAt: parsed.computedAt,
      stale,
    };
  } catch {
    return null;
  }
};

// Sign-out retirement (#565 review). `retireFofCache` bumps the account's
// epoch and drains writes already in flight; a build that started before
// the bump then skips its write, so the wipe's key scan can't be outrun.
// Builds started after it (a re-login) carry the new epoch and write normally.
const fofEpochs = new Map<string, number>();
const pendingWrites = new Set<Promise<void>>();
const accountEpoch = (userPubkey: string | null): number =>
  userPubkey ? (fofEpochs.get(userPubkey.toLowerCase()) ?? 0) : 0;

/** Stop in-flight FoF builds of `userPubkey` from persisting; await writes already started. */
export const retireFofCache = async (userPubkey: string): Promise<void> => {
  const key = userPubkey.toLowerCase();
  fofEpochs.set(key, accountEpoch(key) + 1);
  await Promise.allSettled([...pendingWrites]);
};

const writeFofCache = (
  userPubkey: string | null,
  friends: readonly string[],
  result: FofResult,
  maxSize: number | undefined,
  epoch: number,
): Promise<void> => {
  // Checked synchronously right before the write is registered, so a
  // retirement either sees this write in `pendingWrites` or stops it here.
  if (!userPubkey || accountEpoch(userPubkey) !== epoch) return Promise.resolve();
  const write = persistFofCache(userPubkey, friends, result, maxSize);
  pendingWrites.add(write);
  return write.finally(() => pendingWrites.delete(write));
};

export const persistFofCache = async (
  userPubkey: string | null,
  friends: readonly string[],
  result: FofResult,
  maxSize?: number,
): Promise<void> => {
  if (!userPubkey) return;
  try {
    const entry: CacheEntry = {
      userPubkey: userPubkey.toLowerCase(),
      maxSize,
      friendsHash: hashFriends(friends),
      setArr: [...result.set],
      excludedFriends: result.excludedFriends,
      computedAt: result.computedAt,
    };
    await AsyncStorage.setItem(fofCacheKey(userPubkey, maxSize), JSON.stringify(entry));
  } catch {
    // Best-effort.
  }
};
