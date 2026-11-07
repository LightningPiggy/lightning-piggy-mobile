/**
 * Device-wide cache of each pubkey's Lightning address (`lud16`), taken ONLY
 * from a signature-verified kind-0 of that pubkey (`fetchProfile`).
 *
 * Why: the contacts list and other batch paths strip `lud16`, because their
 * kind-0s skip schnorr verification and a forged address would redirect a zap
 * (`utils/profileSanitize`). So every profile open re-fetched the verified
 * kind-0 before it could show the address, and on a slow or flaky connection
 * the zap button sat greyed ("no Lightning address") for a contact whose
 * address we had already verified.
 *
 * Why caching it is safe:
 *   - Written only by `fetchProfile`, after `verifyEventCached` and an author
 *     check, so a relay can't plant an address it couldn't sign for.
 *   - Newest wins by the event's `created_at`: a stale relay's older kind-0
 *     can't resurrect an address the person has since changed or removed.
 *     A newer kind-0 with no `lud16` stores `null`, which clears it.
 *   - App-private storage, like the verified-event cache and the DM database.
 *   - Re-verified in the background on every profile open, and entries not
 *     re-confirmed for `TTL_MS` stop seeding the UI.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'verified_lud16_v1';
// An address not re-confirmed in this window falls back to the network.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Only the people the user actually opens or pays; 500 keeps the blob small.
const MAX_ENTRIES = 500;
// A same-event re-confirmation only rewrites storage this often.
const REFRESH_PERSIST_MS = 24 * 60 * 60 * 1000;

interface Entry {
  /** `null` when the newest verified kind-0 carries no address. */
  lud16: string | null;
  /** `created_at` of the verified kind-0 this came from (seconds). */
  createdAt: number;
  /** Epoch ms of the last verified fetch that confirmed it. */
  verifiedAt: number;
}

type CacheShape = Record<string, Entry>;

let memoryCache: CacheShape | null = null;
let loading: Promise<CacheShape> | null = null;

function load(): Promise<CacheShape> {
  if (memoryCache) return Promise.resolve(memoryCache);
  loading ??= (async () => {
    let parsed: CacheShape = {};
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw) as CacheShape;
    } catch {
      // Unreadable blob: start empty; the next verified fetch rebuilds it.
    }
    memoryCache = parsed;
    loading = null;
    return parsed;
  })();
  return loading;
}

async function persist(cache: CacheShape): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Non-fatal: the in-memory mirror still serves this session.
  }
}

function fresh(entry: Entry | undefined): string | null {
  if (!entry || Date.now() - entry.verifiedAt > TTL_MS) return null;
  return entry.lud16;
}

/** Sync read of the in-memory mirror, for a first-frame seed. Null until
 * the mirror has loaded once this session. */
export function peekVerifiedLud16(pubkey: string): string | null {
  if (!pubkey || !memoryCache) return null;
  return fresh(memoryCache[pubkey]);
}

/** The newest verified address for `pubkey`, or null if none is known. */
export async function getVerifiedLud16(pubkey: string): Promise<string | null> {
  if (!pubkey) return null;
  return fresh((await load())[pubkey]);
}

/**
 * Records the `lud16` of a signature-verified kind-0 by `pubkey`. Only call
 * with an event that passed verification and whose author is `pubkey`.
 * Returns the address from the NEWEST verified kind-0 seen so far, which
 * is `lud16` itself unless an older event arrived after a newer one.
 */
export async function recordVerifiedLud16(
  pubkey: string,
  lud16: string | null,
  createdAt: number,
): Promise<string | null> {
  const cache = await load();
  const existing = cache[pubkey];
  if (existing && existing.createdAt > createdAt) return existing.lud16;
  const now = Date.now();
  const unchanged = existing && existing.createdAt === createdAt && existing.lud16 === lud16;
  if (unchanged && now - existing.verifiedAt < REFRESH_PERSIST_MS) return lud16;
  // Re-insert so key order tracks recency for the eviction below.
  delete cache[pubkey];
  cache[pubkey] = { lud16, createdAt, verifiedAt: now };
  const keys = Object.keys(cache);
  for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete cache[keys[i]];
  await persist(cache);
  return lud16;
}

/** Test-only: drop the in-memory mirror so the next read hits storage. */
export function __resetForTests(): void {
  memoryCache = null;
  loading = null;
}

export const __TEST__ = { STORAGE_KEY, TTL_MS, MAX_ENTRIES, REFRESH_PERSIST_MS };
