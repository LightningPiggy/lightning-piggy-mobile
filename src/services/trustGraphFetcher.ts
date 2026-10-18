import { enabledAppRelays } from './appRelayPrefs';
/**
 * Runtime side of the trust-graph service — fetches the L2 set
 * (friends-of-follows) from relays + persists it to AsyncStorage.
 * Kept separate from `trustGraphService.ts` so the latter stays pure
 * (no `pool` / `nostr-tools/pool` ESM-only dep) and unit tests don't
 * need to mock the relay layer.
 */

import type { Event as NostrEvent, Filter } from 'nostr-tools';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_RELAYS, pool } from './nostrService';

const L2_CACHE_KEY_PREFIX = '@lp:trust-graph-l2:';
const L2_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000; // 7 days
const FETCH_TIMEOUT_MS = 12_000;

interface L2CacheEntry {
  fetchedAt: number;
  pubkeys: string[];
  /** Stable hash of the L1 input — invalidates the cache when the user
   * follows / unfollows so we don't keep stale friends-of-friends. */
  l1Hash: string;
}

const cacheKeyFor = (userPubkey: string): string =>
  `${L2_CACHE_KEY_PREFIX}${userPubkey.toLowerCase()}`;

/** Cheap, order-insensitive hash of an L1 follow set. */
const hashL1 = (l1: ReadonlySet<string>): string => {
  const sorted = [...l1].map((s) => s.toLowerCase()).sort();
  // 32-bit rolling hash (Java-style `31*h + char`, OR'd to keep within
  // i32). Plenty of collision resistance for cache-key invalidation
  // (we're comparing two snapshots of a single user's follow list,
  // not anti-pre-image work). Per Copilot review on PR #488.
  let h = 0;
  for (const s of sorted) {
    for (let i = 0; i < s.length; i += 1) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
  }
  return `${sorted.length}:${h}`;
};

/**
 * Fetch the union of `p` tags from every L1 follow's most recent
 * kind-3 event. Returns a Set of hex pubkeys (lowercase).
 *
 * Note: this can be a large query — a user with 200 follows whose
 * follows each follow ~100 people yields ~20k kind-3 `p` tags. We cap
 * the result at ~10k via dedup; relays generally cap the response set
 * themselves. Timeout is 12 s; we resolve whatever's landed by then.
 */
export const fetchL2Follows = async (
  l1Pubkeys: ReadonlySet<string>,
  relays: string[] = enabledAppRelays('default', DEFAULT_RELAYS),
): Promise<Set<string>> => {
  const authors = [...l1Pubkeys].map((p) => p.toLowerCase());
  if (authors.length === 0) return new Set();

  const result = new Set<string>();
  const seenLatest = new Map<string, number>(); // pubkey → newest kind-3 created_at

  await new Promise<void>((resolve) => {
    let closed = false;
    let sub: { close(): void } | undefined;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try {
        sub?.close();
      } finally {
        resolve();
      }
    };
    const timer = setTimeout(finish, FETCH_TIMEOUT_MS);
    const filter: Filter = { kinds: [3], authors, limit: authors.length };
    sub = pool.subscribeManyEose(relays, filter, {
      maxWait: FETCH_TIMEOUT_MS,
      onclose: finish,
      onevent: (ev: NostrEvent) => {
        // Keep only the latest kind-3 per author — Nostr clients edit
        // their contact list and we want the newest revision.
        const prev = seenLatest.get(ev.pubkey);
        if (prev !== undefined && ev.created_at <= prev) return;
        seenLatest.set(ev.pubkey, ev.created_at);
        for (const tag of ev.tags) {
          if (tag[0] === 'p' && typeof tag[1] === 'string' && tag[1].length === 64) {
            result.add(tag[1].toLowerCase());
          }
        }
      },
    });
    if (closed) sub.close();
  });

  return result;
};

/**
 * Load the L2 set from AsyncStorage, returning null if cold / stale /
 * keyed against a different L1 hash. Caller should then call
 * `fetchL2Follows` and `persistL2Cache` to refresh.
 */
export const loadL2Cache = async (
  userPubkey: string,
  currentL1: ReadonlySet<string>,
): Promise<Set<string> | null> => {
  try {
    const raw = await AsyncStorage.getItem(cacheKeyFor(userPubkey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as L2CacheEntry;
    if (Date.now() - parsed.fetchedAt > L2_CACHE_TTL_MS) return null;
    if (parsed.l1Hash !== hashL1(currentL1)) return null;
    return new Set(parsed.pubkeys);
  } catch {
    return null;
  }
};

export const persistL2Cache = async (
  userPubkey: string,
  l1: ReadonlySet<string>,
  l2: ReadonlySet<string>,
): Promise<void> => {
  try {
    const entry: L2CacheEntry = {
      fetchedAt: Date.now(),
      pubkeys: [...l2],
      l1Hash: hashL1(l1),
    };
    await AsyncStorage.setItem(cacheKeyFor(userPubkey), JSON.stringify(entry));
  } catch {
    /* best-effort */
  }
};
