/**
 * AsyncStorage-backed cache of resolved kind-0 profiles for **zap senders**
 * (and outgoing-zap recipients) keyed by hex pubkey.
 *
 * Why a separate cache from the contact-profile cache in `NostrContext`?
 * The contact cache only covers people the user follows (kind-3). Zap
 * senders are typically strangers — without persistence we re-query
 * relays on every cold start, which costs 2–5 s per avatar in the
 * common case and up to ~36 s when relays are slow / profile missing.
 * Persisting the resolved kind-0 means avatars render in ~50 ms on the
 * next launch (#95).
 *
 * Mirrors the patterns established by `zapCounterpartyStorage`:
 *   - in-memory mirror so reads after first hydration are sync-fast,
 *   - single JSON blob in AsyncStorage,
 *   - LRU-style cap so the blob can't grow unbounded,
 *   - a 24-hour TTL on read so stale-but-not-catastrophic profiles
 *     (display name / avatar swaps) don't stick forever.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ZapCounterpartyInfo } from '../types/wallet';

const STORAGE_KEY = 'zap_sender_profiles_v1';
// Match the contact-profile cache TTL (`CACHE_MAX_AGE_MS` in NostrContext).
// Profiles change infrequently and a stale display name / avatar is not
// catastrophic — but a day is recent enough that visible churn (rebrand,
// avatar swap) gets picked up the next cold start.
const TTL_MS = 24 * 60 * 60 * 1000;
// LRU cap — busy accounts can accumulate hundreds of one-off zap-sender
// pubkeys over the lifetime of an install. 500 covers the long tail
// while keeping the persisted blob comfortably under ~150 KB. Matches
// the cap chosen for `zapCounterpartyStorage`.
const MAX_ENTRIES = 500;

// Just the fields the avatar / sender chip needs in `TransactionList`.
// Keeping the persisted shape minimal (vs. the full `NostrProfile`) means
// smaller blobs and a stable on-disk format independent of upstream type
// churn.
export type CachedZapSenderProfile = NonNullable<ZapCounterpartyInfo['profile']>;

interface Entry {
  profile: CachedZapSenderProfile;
  /** Epoch ms when written — used for TTL filtering AND LRU eviction. */
  savedAt: number;
}

type CacheShape = Record<string, Entry>;

let memoryCache: CacheShape | null = null;
const listeners = new Set<() => void>();
/** Batch writers notify display consumers; consumers coalesce before rendering. */
export function subscribeProfilesChanged(receive: () => void): () => void {
  listeners.add(receive);
  return () => {
    listeners.delete(receive);
  };
}

async function load(): Promise<CacheShape> {
  if (memoryCache) return memoryCache;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    memoryCache = raw ? (JSON.parse(raw) as CacheShape) : {};
  } catch {
    memoryCache = {};
  }
  return memoryCache;
}

async function persist(cache: CacheShape): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage failure is non-fatal — the in-memory mirror still serves
    // the rest of this session, and the worst case is a re-fetch on
    // next launch.
  }
}

/**
 * Lookup a single zap-sender profile. Returns null when missing or
 * when the cached entry has aged past `TTL_MS`.
 */
export async function get(pubkey: string): Promise<CachedZapSenderProfile | null> {
  if (!pubkey) return null;
  const cache = await load();
  const entry = cache[pubkey];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > TTL_MS) return null;
  return entry.profile;
}

/**
 * Bulk lookup — the resolver uses this to filter the kind-0 fetch set
 * down to genuinely-unknown pubkeys. TTL-expired entries are skipped
 * so callers refetch them.
 */
export async function getMany(pubkeys: string[]): Promise<Map<string, CachedZapSenderProfile>> {
  const out = new Map<string, CachedZapSenderProfile>();
  if (pubkeys.length === 0) return out;
  const cache = await load();
  const now = Date.now();
  for (const pk of pubkeys) {
    const entry = cache[pk];
    if (!entry) continue;
    if (now - entry.savedAt > TTL_MS) continue;
    out.set(pk, entry.profile);
  }
  return out;
}

/**
 * Synchronous peek into the in-memory mirror — used to SEED a consumer's
 * initial state so a warm profile (its avatar URL) paints on the FIRST frame
 * instead of after the async `get` resolves (the "avatars load late" symptom).
 * Returns null until the mirror has been loaded once this session (`get` /
 * `getMany` populate it — the common case, since the surfaces using this peek
 * also call `get`). TTL-aware, same as `get`.
 */
export function peekSync(pubkey: string): CachedZapSenderProfile | null {
  if (!pubkey || !memoryCache) return null;
  const entry = memoryCache[pubkey];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > TTL_MS) return null;
  return entry.profile;
}

/**
 * Write-through after a successful relay resolution. Evicts the
 * oldest entries when the cache crosses `MAX_ENTRIES`.
 */
export async function setMany(profiles: Map<string, CachedZapSenderProfile>): Promise<void> {
  if (profiles.size === 0) return;
  const cache = await load();
  const now = Date.now();
  for (const [pubkey, profile] of profiles) {
    if (!pubkey || !profile) continue;
    cache[pubkey] = { profile, savedAt: now };
  }

  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    // Sort by savedAt ascending → drop the oldest until we're back under cap.
    const sorted = keys.map((k) => [k, cache[k].savedAt] as const).sort((a, b) => a[1] - b[1]);
    const drop = sorted.slice(0, keys.length - MAX_ENTRIES);
    for (const [k] of drop) delete cache[k];
  }

  for (const receive of listeners) receive();
  await persist(cache);
}

/** Test-only: wipe the in-memory cache so reloads re-read from storage. */
export function __resetForTests(): void {
  memoryCache = null;
}

/** Test-only: expose constants for test parameterisation. */
export const __TEST__ = { TTL_MS, MAX_ENTRIES };
