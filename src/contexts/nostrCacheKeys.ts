import AsyncStorage from '@react-native-async-storage/async-storage';
import { InteractionManager } from 'react-native';

import { perAccountKey } from '../services/perAccountStorage';
import type { NostrProfile } from '../types/nostr';
import { newerProfile } from '../utils/profileFreshness';

// Cache key bases — each is suffixed with `_${pubkey}` via perAccountKey()
// at every call site (#288). The legacy un-suffixed keys are migrated on
// first launch by `migrateToPerAccountStorage`.
export const CONTACTS_CACHE_KEY_BASE = 'nostr_contacts_cache';
export const PROFILES_CACHE_KEY_BASE = 'nostr_profiles_cache';
export const CACHE_TIMESTAMP_KEY_BASE = 'nostr_cache_timestamp';
export const CONTACTS_TIMESTAMP_KEY_BASE = 'nostr_contacts_timestamp';
// Exported so AccountDrawerContent + AccountSwitcherSheet can seed
// their per-identity profile caches synchronously from AsyncStorage
// before fanning out to relays — otherwise they always wait on a
// network round-trip per non-active identity, making the switcher
// slow to populate names + avatars.
export const OWN_PROFILE_CACHE_KEY_BASE = 'nostr_own_profile_cache';
export const OWN_PROFILE_TIMESTAMP_KEY_BASE = 'nostr_own_profile_timestamp';
export const RELAY_LIST_CACHE_KEY_BASE = 'nostr_relay_list_cache';
/** The user's own NIP-17 DM inbox relays (kind 10050) — read for DMs, incl. in the background watch. */
export const DM_INBOX_RELAYS_CACHE_KEY_BASE = 'nostr_dm_inbox_relays_v1';
/** created_at of the cached DM inbox list, so an older relay copy never replaces it. */
export const DM_INBOX_CREATED_AT_KEY_BASE = 'nostr_dm_inbox_created_at_v1';
/** created_at of the adopted NIP-65 list, so an older relay copy never replaces it. */
export const RELAY_LIST_CREATED_AT_KEY_BASE = 'nostr_relay_list_created_at_v1';
export const RELAY_LIST_TIMESTAMP_KEY_BASE = 'nostr_relay_list_timestamp';
export const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours — for all-cached fast path
// A contact whose kind-0 we couldn't resolve on the previous attempt is
// retried much sooner than 24 h. The "miss" often reflects the user's
// profile being on a relay we hadn't hit yet at that moment, not that
// they've never published one — a shorter retry window turns a few of
// those no-profile contacts into resolved ones within the hour.
export const MISSING_PROFILE_RETRY_MS = 60 * 60 * 1000; // 1 hour

/**
 * Read a JSON-serialised cache value and its timestamp in a single
 * `multiGet` call. Returns the parsed value (or null if missing / corrupt)
 * and the cache age in ms (Infinity when no timestamp exists yet).
 */
export async function readCachedWithTtl<T>(
  dataKey: string,
  tsKey: string,
): Promise<{ value: T | null; ageMs: number }> {
  try {
    const pairs = await AsyncStorage.multiGet([dataKey, tsKey]);
    let dataStr: string | null = null;
    let tsStr: string | null = null;
    for (const [k, v] of pairs) {
      if (k === dataKey) dataStr = v;
      else if (k === tsKey) tsStr = v;
    }
    const value = dataStr ? (JSON.parse(dataStr) as T) : null;
    const ageMs = tsStr ? Date.now() - parseInt(tsStr, 10) : Infinity;
    return { value, ageMs };
  } catch {
    return { value: null, ageMs: Infinity };
  }
}

/**
 * Merge freshly-fetched profiles on top of the profile cache (so contacts we
 * didn't refetch keep their known profile) and bump the cache timestamp.
 * Deferred behind InteractionManager so the writes don't compete with an
 * in-progress render/gesture.
 *
 * `existing` is the caller's snapshot of the cache from when its fetch began.
 * Because refreshes can now run fire-and-forget (#852), a second fetch may
 * have persisted newer profiles while this one was in flight — so we re-read
 * the latest on-disk cache at write time and merge on top of THAT, falling
 * back to `existing` only if the read/parse fails. This prevents a slow
 * background fetch from clobbering fresher data written by a later fetch.
 *
 * Persists for one account run ONE AT A TIME (a promise chain per account):
 * otherwise two could read the same snapshot and the later write would drop
 * the other's profiles, or put an older kind-0 back (#1390).
 */
export function persistMergedProfileCache(
  pk: string,
  existing: Record<string, NostrProfile>,
  fetched: Map<string, NostrProfile>,
): Promise<void> {
  const epoch = persistEpochs.get(pk) ?? 0;
  const run = (persistChains.get(pk) ?? Promise.resolve()).then(() =>
    persistMergedProfileCacheNow(pk, existing, fetched, epoch),
  );
  const tail = run.catch(() => {});
  persistChains.set(pk, tail);
  void tail.then(() => {
    if (persistChains.get(pk) === tail) persistChains.delete(pk);
  });
  return run;
}

/** The tail of each account's queue of persists. */
const persistChains = new Map<string, Promise<void>>();
/** Bumped when an account's caches are wiped: persists queued before it never write. */
const persistEpochs = new Map<string, number>();

/**
 * Before wiping `pk`'s caches (sign-out / account deletion): every profile
 * persist already queued or running for it is retired — none writes after
 * this — and one mid-write finishes first, so the wipe removes what it wrote.
 */
export async function retireProfilePersists(pk: string): Promise<void> {
  persistEpochs.set(pk, (persistEpochs.get(pk) ?? 0) + 1);
  await persistChains.get(pk);
}

async function persistMergedProfileCacheNow(
  pk: string,
  existing: Record<string, NostrProfile>,
  fetched: Map<string, NostrProfile>,
  epoch: number,
): Promise<void> {
  const retired = () => (persistEpochs.get(pk) ?? 0) !== epoch;
  if (retired()) return;
  await new Promise<void>((resolve) => InteractionManager.runAfterInteractions(() => resolve()));
  let base: Record<string, NostrProfile> = existing;
  try {
    const onDisk = await AsyncStorage.getItem(perAccountKey(PROFILES_CACHE_KEY_BASE, pk));
    if (onDisk) {
      // On-disk wins over the caller's older snapshot for overlapping keys.
      base = { ...existing, ...(JSON.parse(onDisk) as Record<string, NostrProfile>) };
    }
  } catch {
    // Corrupt / unreadable cache — keep the caller's snapshot as the base.
  }
  // This fetch's results are the most authoritative for the keys it covers —
  // unless the cached copy is from a newer kind-0 (a late fallback, #1390).
  const merged: Record<string, NostrProfile> = { ...base };
  fetched.forEach((v, k) => {
    merged[k] = newerProfile(merged[k], v) ?? v;
  });
  // Await both writes (still swallowing errors) so the function only resolves
  // once persistence has completed. Callers that `await` this (e.g.
  // loadContacts with awaitProfiles) then get the durability the name implies,
  // and the on-disk state can't lag a resolved promise; fire-and-forget callers
  // (#852) are unaffected since they don't await the returned promise.
  // The account's caches were wiped meanwhile: write nothing back (#1390).
  if (retired()) return;
  await Promise.all([
    AsyncStorage.setItem(perAccountKey(PROFILES_CACHE_KEY_BASE, pk), JSON.stringify(merged)),
    AsyncStorage.setItem(perAccountKey(CACHE_TIMESTAMP_KEY_BASE, pk), Date.now().toString()),
  ]).catch(() => {});
}
