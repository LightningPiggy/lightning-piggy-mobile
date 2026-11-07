import AsyncStorage from '@react-native-async-storage/async-storage';
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

function schedulePersist(): void {
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void flushVerifiedEventCache();
  }, 250);
}

/** Bounded shards keep JSON parsing/serialization out of large sync blocks. */
export async function flushVerifiedEventCache(): Promise<void> {
  const epoch = generation;
  if (writing) {
    await writing;
    // A previous debounce may have snapshotted a bucket before the latest
    // events arrived. EOSE must flush those newer dirty records as well.
    if (epoch === generation && dirty.size) await flushVerifiedEventCache();
    return;
  }
  // Don't overwrite persisted buckets before hydration has merged them.
  await hydrateVerifiedEventCache();
  if (epoch !== generation) return;
  if (writing) return flushVerifiedEventCache();
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
          dirty.add(key); // Offline/full storage: keep RAM trust, retry later.
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
  hydration = undefined;
  verified.clear();
  buckets.clear();
  dirty.clear();
};
export const __verifiedEventCacheSize = (): number => verified.size;
