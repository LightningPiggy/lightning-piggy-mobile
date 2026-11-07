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
 *   - Wiped on logout / account switch: it holds public data only, but on a
 *     shared device it would show whose profiles the previous account opened.
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
// Bumped by every wipe. A fetch that started before a wipe (logout / account
// switch) must not write into the next account's cache.
let generation = 0;
// Writes run in call order, so a wipe can't be overtaken by an older snapshot.
let writeChain: Promise<void> = Promise.resolve();

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
    // A wipe during the read already installed an empty mirror: keep it.
    memoryCache ??= parsed;
    loading = null;
    return memoryCache;
  })();
  return loading;
}

function enqueueWrite(write: () => Promise<void>): Promise<void> {
  writeChain = writeChain.then(write).catch(() => {
    // Non-fatal: the in-memory mirror still serves this session.
  });
  return writeChain;
}

function persist(cache: CacheShape): void {
  const snapshot = JSON.stringify(cache);
  // Fire-and-forget: fetchProfile callers must not wait on storage.
  void enqueueWrite(() => AsyncStorage.setItem(STORAGE_KEY, snapshot));
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

/** Read before starting a fetch; pass to `recordVerifiedLud16`. */
export function verifiedLud16Generation(): number {
  return generation;
}

/**
 * Records the `lud16` of a signature-verified kind-0 by `pubkey`. Only call
 * with an event that passed verification and whose author is `pubkey`.
 * Returns the address from the NEWEST verified kind-0 seen so far, which
 * is `lud16` itself unless an older event arrived after a newer one.
 * `startedAt` is `verifiedLud16Generation()` from before the fetch: if a wipe
 * ran since, the address is returned but not stored.
 */
export async function recordVerifiedLud16(
  pubkey: string,
  lud16: string | null,
  createdAt: number,
  startedAt: number = generation,
): Promise<string | null> {
  if (startedAt !== generation) return lud16;
  const cache = await load();
  // A wipe may also land while the mirror loads.
  if (startedAt !== generation) return lud16;
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
  persist(cache);
  return lud16;
}

/** Drops every cached address (logout / account switch). */
export async function clearVerifiedLud16Cache(): Promise<void> {
  generation += 1;
  memoryCache = {};
  loading = null;
  await enqueueWrite(() => AsyncStorage.removeItem(STORAGE_KEY));
}

/** Test-only: drop the in-memory mirror so the next read hits storage. */
export function __resetForTests(): void {
  memoryCache = null;
  loading = null;
}

/** Test-only: resolves once queued storage writes have landed. */
export function __flushWritesForTests(): Promise<void> {
  return writeChain;
}

export const __TEST__ = { STORAGE_KEY, TTL_MS, MAX_ENTRIES, REFRESH_PERSIST_MS };
