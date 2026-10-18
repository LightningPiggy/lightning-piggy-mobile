// Friends-of-friends (FoF) set computation for the WoT tier picker (#535).
//
// Pure logic — relay I/O is injected via `fetchKind3` so jest can mock it
// without spinning up the real pool. Persistence is via AsyncStorage with a
// 24 h TTL keyed on the user's pubkey.
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

// 500 follows is the threshold from #535. Anyone above this is treated as
// a high-fanout account (curator / bot) and dropped from the FoF expansion;
// their own posts still pass under the Friends tier.
export const FANOUT_CAP = 500;
// Soft-cap fallback: if heuristic #1 leaves <50% of friends contributing,
// drop the exclusion. Stops a 3-friends-over-cap user from getting an
// FoF dominated by their remaining 2 friends.
export const SOFT_CAP_MIN_RATIO = 0.5;
// Invalidate discovery-ordered capped entries from before ranking was fixed.
const FOF_CACHE_KEY = '@lp:wot-fof:v2';
export const FOF_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

export interface FofResult {
  set: Set<string>;
  excludedFriends: number;
  computedAt: number;
}

interface CacheEntry extends FofResult {
  userPubkey: string;
  // The ranked cap the set was built with (absent = uncapped). A capped and
  // an uncapped set are different results, so a reader with another cap
  // must not reuse it.
  maxSize?: number;
  // Stable hash of the input friend set; if the user follows/unfollows we
  // want the cache to invalidate even within the TTL window.
  friendsHash: string;
  // Serialized form of `set`.
  setArr: string[];
}

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
  const friendsLower = [...new Set(myFollows.map((p) => p.toLowerCase()))];
  const friendSet = new Set(friendsLower);
  const userLower = userPubkey ? userPubkey.toLowerCase() : null;

  // Heuristic 1: which friends are over the fanout cap?
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

  // pubkey → how many contributing friends follow it (Map keeps discovery
  // order, the tie-break for the ranked cap).
  const fof = new Map<string, number>();
  let excludedFriends = 0;
  for (const friend of friendsLower) {
    if (applyHighFanoutExclusion && overCap.has(friend)) {
      excludedFriends += 1;
      continue;
    }
    const list = followListsByFriend[friend];
    if (!list) continue;
    // Heuristic 2: cap each contributing friend at FANOUT_CAP follows.
    // Kind-3 `p` tags have no timestamps so "first N" is roughly add-order
    // and client-dependent — acknowledged in #535.
    const slice = list.slice(0, FANOUT_CAP);
    for (const pk of new Set(slice.map((p) => p.toLowerCase()))) {
      const lower = pk.toLowerCase();
      // FoF tier explicitly excludes the user + their direct friends —
      // those already pass under the Friends tier, so including them
      // here would muddle the "n of friends excluded" reporting and add
      // dead weight to the set.
      if (lower === userLower) continue;
      if (friendSet.has(lower)) continue;
      fof.set(lower, (fof.get(lower) ?? 0) + 1);
    }
  }

  if (maxSize === undefined) {
    return { set: new Set(fof.keys()), excludedFriends };
  }
  // Stable sort: equal counts keep discovery order.
  const ranked = [...fof].sort((a, b) => b[1] - a[1]).slice(0, Math.max(0, maxSize));
  return { set: new Set(ranked.map(([pk]) => pk)), excludedFriends };
};

// Full pipeline: fetch kind-3 lists, apply heuristics, persist with TTL.
// Returns the FoF set + how many friends were excluded by heuristic 1.
export const computeFofSet = async (
  userPubkey: string | null,
  myFollows: readonly string[],
  opts: ComputeFofOptions,
): Promise<FofResult> => {
  const friendsLower = [...new Set(myFollows.map((p) => p.toLowerCase()))];
  if (friendsLower.length === 0) {
    return { set: new Set(), excludedFriends: 0, computedAt: Date.now() };
  }
  // Chunk into 50-author batches so a single relay isn't asked to return
  // 500 authors in one filter — matches the chunking note in #535.
  const BATCH_SIZE = 50;
  const batches: string[][] = [];
  for (let i = 0; i < friendsLower.length; i += BATCH_SIZE) {
    batches.push(friendsLower.slice(i, i + BATCH_SIZE));
  }
  const followLists: Record<string, string[]> = {};
  let done = 0;
  for (const batch of batches) {
    if (opts.signal?.aborted) {
      throw new DOMException('FoF compute aborted', 'AbortError');
    }
    const partial = await opts.fetchKind3(batch);
    for (const [k, v] of Object.entries(partial)) followLists[k.toLowerCase()] = v;
    done += 1;
    opts.onProgress?.(done, batches.length);
  }
  const { set, excludedFriends } = buildFofSet(userPubkey, friendsLower, followLists, opts.maxSize);
  const result: FofResult = { set, excludedFriends, computedAt: Date.now() };
  await persistFofCache(userPubkey, friendsLower, result, opts.maxSize);
  return result;
};

// Cache helpers. Stored under one key keyed on `userPubkey`; readers
// invalidate on TTL or friend-set hash mismatch.
export const loadFofCache = async (
  userPubkey: string | null,
  currentFriends: readonly string[],
  maxSize?: number,
): Promise<FofResult | null> => {
  if (!userPubkey) return null;
  try {
    const raw = await AsyncStorage.getItem(FOF_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (parsed.userPubkey !== userPubkey.toLowerCase()) return null;
    if (Date.now() - parsed.computedAt > FOF_CACHE_TTL_MS) return null;
    if (parsed.friendsHash !== hashFriends(currentFriends)) return null;
    if (parsed.maxSize !== maxSize) return null;
    return {
      set: new Set(parsed.setArr),
      excludedFriends: parsed.excludedFriends,
      computedAt: parsed.computedAt,
    };
  } catch {
    return null;
  }
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
      set: result.set,
      setArr: [...result.set],
      excludedFriends: result.excludedFriends,
      computedAt: result.computedAt,
    };
    // `set` (Set) is non-JSON-serialisable but stripped by JSON.stringify;
    // `setArr` carries the actual data through the round-trip.
    await AsyncStorage.setItem(FOF_CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Best-effort.
  }
};
