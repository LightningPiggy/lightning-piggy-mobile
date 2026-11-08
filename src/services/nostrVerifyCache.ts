import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState } from 'react-native';
import { verifiedSymbol, type Event as NostrEvent } from 'nostr-tools/pure';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { nostrGetEventHash, nostrVerifyEvent } from './nostrCrypto';

// The canonical hash IS the event id. Retain the successful signature too:
// replaying a known payload with a forged signature must still be rejected.
// Storage is app-private, like the DM database; never hydrate relay-supplied
// trust records. Hashing the payload on every hit prevents id substitution.
export const VERIFIED_CACHE_CAP = 20_000;
const BUCKET_CAP = 128;
const PREFIX = 'nostr_verified_v1_';
const verified = new Map<string, string>();
const buckets = new Map<string, Map<string, string>>();
const dirty = new Set<string>();
let hydration: Promise<void> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let pendingRecords = 0;
let firstDirtyAt = 0;
let lastDirtyAt = 0;
let watchingAppState = false;
let writing: Promise<void> | undefined;
let generation = 0;
const bucketKey = (id: string) => id.slice(0, 2);
const storageKey = (bucket: string) => PREFIX + bucket;

function remove(id: string): void {
  verified.delete(id);
  const key = bucketKey(id);
  buckets.get(key)?.delete(id);
  dirty.add(key);
}

function remember(id: string, sig: string, persist: boolean): void {
  const key = bucketKey(id);
  let bucket = buckets.get(key);
  if (!bucket) buckets.set(key, (bucket = new Map()));
  bucket.delete(id);
  bucket.set(id, sig);
  verified.delete(id);
  verified.set(id, sig);
  if (bucket.size > BUCKET_CAP) remove(bucket.keys().next().value!);
  if (verified.size > VERIFIED_CACHE_CAP) remove(verified.keys().next().value!);
  if (persist) {
    dirty.add(key);
    schedulePersist();
  }
}

// Persistence is a cache write: it never runs on the relay receive/EOSE path
// (#1758). It waits until verification goes quiet, so a big ingest rewrites
// each bucket once rather than every few events. Process death before a
// write only costs a re-verification of those events next time.
/** Write once no new record has arrived for this long… */
export const PERSIST_IDLE_MS = 1_000;
/** …but never hold the first unwritten record longer than this… */
export const PERSIST_MAX_WAIT_MS = 5_000;
/** …or let more than this many unwritten records pile up. */
export const PERSIST_PENDING_RECORDS = 256;

function armPersist(delay: number): void {
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = setTimeout(persistWhenDue, Math.max(0, delay));
}

/** One timer per quiet period, not one per record: re-arm on fire if not yet due. */
function persistWhenDue(): void {
  persistTimer = undefined;
  const now = Date.now();
  const idleAt = lastDirtyAt + PERSIST_IDLE_MS;
  const maxAt = firstDirtyAt + PERSIST_MAX_WAIT_MS;
  if (pendingRecords < PERSIST_PENDING_RECORDS && now < idleAt && now < maxAt)
    armPersist(Math.min(idleAt, maxAt) - now);
  else void flushVerifiedEventCache();
}

function schedulePersist(): void {
  lastDirtyAt = Date.now();
  if (!pendingRecords++) firstDirtyAt = lastDirtyAt;
  watchAppState();
  if (pendingRecords === PERSIST_PENDING_RECORDS) armPersist(0);
  else if (persistTimer === undefined) armPersist(PERSIST_IDLE_MS);
}

/** Leaving the foreground writes now: the OS may suspend or kill the app next. */
function watchAppState(): void {
  if (watchingAppState) return;
  watchingAppState = true;
  try {
    AppState.addEventListener('change', (state) => {
      if (state !== 'active' && dirty.size) void flushVerifiedEventCache();
    });
  } catch {
    // No AppState (non-RN host): the timers alone still persist the cache.
  }
}

/** Bounded shards keep JSON parsing/serialization out of large sync blocks. */
export async function flushVerifiedEventCache(): Promise<void> {
  const epoch = generation;
  if (writing) {
    await writing;
    // A previous write may have snapshotted a bucket before the latest
    // events arrived. A caller awaiting a flush gets those newer records too.
    if (epoch === generation && dirty.size) await flushVerifiedEventCache();
    return;
  }
  // Don't overwrite persisted buckets before hydration has merged them.
  await hydrateVerifiedEventCache();
  if (epoch !== generation) return;
  if (writing) return flushVerifiedEventCache();
  // Whatever triggered this write, it covers every record pending so far.
  pendingRecords = 0;
  if (!dirty.size) return;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  writing = (async () => {
    const pacing = createYieldScheduler({ safetyEvery: 16, coldStart: true });
    try {
      for (const key of [...dirty]) {
        if (epoch !== generation) return;
        dirty.delete(key);
        const snapshot = JSON.stringify([...(buckets.get(key)?.entries() ?? [])]);
        try {
          await AsyncStorage.setItem(storageKey(key), snapshot);
        } catch {
          dirty.add(key); // Offline/full storage: keep RAM trust, retry with the next write.
          return;
        }
        await pacing.maybeYield();
      }
    } finally {
      pacing.dispose();
    }
  })();
  try {
    await writing;
  } finally {
    writing = undefined;
  }
}

const SHARD_KEYS = Array.from({ length: 256 }, (_, i) =>
  storageKey(i.toString(16).padStart(2, '0')),
);

/** All relay receive work awaits this single flight before any verification. */
export function hydrateVerifiedEventCache(): Promise<void> {
  if (hydration) return hydration;
  const epoch = generation;
  hydration = (async () => {
    let shards: readonly (readonly [string, string | null])[];
    try {
      // ONE native round trip: 256 serial getItems held every relay event
      // behind 256 bridge hops at cold start.
      shards = await AsyncStorage.multiGet(SHARD_KEYS);
    } catch {
      return; // A storage failure falls back to paced full verification.
    }
    const pacing = createYieldScheduler({ safetyEvery: 16, coldStart: true });
    try {
      for (const [storage, raw] of shards) {
        if (epoch !== generation) return;
        const key = storage.slice(PREFIX.length);
        try {
          // A malformed/oversized shard conveys no trust.
          if (raw && raw.length <= BUCKET_CAP * 205) {
            const records: unknown = JSON.parse(raw);
            if (Array.isArray(records) && records.length <= BUCKET_CAP) {
              for (const record of records) {
                if (
                  Array.isArray(record) &&
                  record.length === 2 &&
                  typeof record[0] === 'string' &&
                  /^[0-9a-f]{64}$/.test(record[0]) &&
                  bucketKey(record[0]) === key &&
                  typeof record[1] === 'string' &&
                  /^[0-9a-f]{128}$/.test(record[1]) &&
                  !verified.has(record[0])
                )
                  remember(record[0], record[1], false);
              }
            }
          }
        } catch {
          // A corrupt shard falls back to paced full verification.
        }
        await pacing.maybeYield();
      }
    } finally {
      pacing.dispose();
    }
  })();
  return hydration;
}

/** Full signature check; cache hits still check canonical content and signature. */
export function verifyEventCached(event: NostrEvent): boolean {
  if (typeof event?.id !== 'string' || typeof event.sig !== 'string') return false;
  try {
    if (verified.get(event.id) === event.sig) {
      if (nostrGetEventHash(event) !== event.id) return false;
      remember(event.id, event.sig, false);
      return true;
    }
    // A different signature can still validly sign the same canonical event.
    // Fall through to full verification before replacing the cached signature.
    // Drop nostr-tools' caller-provided verifiedSymbol; only our own records
    // may bypass the cryptographic check, including on locally mutated objects.
    const candidate = { ...event };
    delete candidate[verifiedSymbol];
    const ok = nostrVerifyEvent(candidate);
    if (ok && nostrGetEventHash(candidate) === candidate.id) {
      remember(candidate.id, candidate.sig, true);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Reset RAM only: simulates process restart without deleting persisted trust. */
export const __resetVerifiedEventCache = (): void => {
  generation++;
  if (persistTimer !== undefined) clearTimeout(persistTimer);
  persistTimer = undefined;
  pendingRecords = 0;
  hydration = undefined;
  verified.clear();
  buckets.clear();
  dirty.clear();
};
export const __verifiedEventCacheSize = (): number => verified.size;
