import { readCachedDisplayProfiles } from './cachedDisplayProfiles';
import { pool, trackRelays } from './nostrPool';
import { querySyncAbortable } from './relayQuery';
import * as storage from './zapSenderProfileStorage';

export interface MentionProfile {
  name: string | null;
  picture: string | null;
}
const EMPTY: MentionProfile = { name: null, picture: null };
const MAX_BATCH = 64;
const owners = new Map<string, Set<(profile: MentionProfile) => void>>();
const lookupOwners = new Map<string, number>();
const pending = new Set<string>();
const cache = new Map<string, { profile: MentionProfile; at: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let active: { keys: string[]; controller: AbortController } | undefined;
let readRelays: string[] = [];
let retryRelays: string[] = [];
let profileOwner: string | null = null;
let unsubscribeStorage: (() => void) | undefined;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function watchStorage(): void {
  unsubscribeStorage ??= storage.subscribeProfilesChanged(() => {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      for (const [key, listeners] of owners) {
        const profile = peekMentionProfile(key);
        if (profile !== EMPTY) for (const receive of listeners) receive(profile);
      }
    }, 60);
  });
}

export function peekMentionProfile(pubkey: string): MentionProfile {
  const stored = storage.peekSync(pubkey);
  const name = stored?.displayName?.trim() || stored?.name?.trim();
  if (name) return { name, picture: stored?.picture ?? null };
  const hit = cache.get(pubkey);
  return hit && Date.now() - hit.at < 10 * 60 * 1000 ? hit.profile : EMPTY;
}

function schedule(): void {
  if (!timer && !active && pending.size) timer = setTimeout(() => void flush(), 60);
}

/** Each focused consumer owns its interest. The last lookup-enabled blur aborts
 * a running batch; cache-only consumers keep observing storage. Cosmetic kind-0 fields
 * never enter the verified payment cache. */
export function subscribeMentionProfile(
  pubkey: string,
  relays: string[],
  receive: (profile: MentionProfile) => void,
  fallbackRelays: string[] = [],
  owner: string | null = null,
  // Group sender rows observe the screen-owned member batch through storage.
  allowRelayLookup = true,
): () => void {
  if (allowRelayLookup) profileOwner = owner;
  watchStorage();
  const listeners = owners.get(pubkey) ?? new Set();
  listeners.add(receive);
  owners.set(pubkey, listeners);
  if (allowRelayLookup) {
    lookupOwners.set(pubkey, (lookupOwners.get(pubkey) ?? 0) + 1);
    readRelays = [...new Set(relays)].slice(0, 6);
    retryRelays = [...new Set(fallbackRelays)]
      .filter((url) => !readRelays.includes(url))
      .slice(0, 6);
  }
  const hit = peekMentionProfile(pubkey);
  if (hit !== EMPTY) receive(hit);
  else if (
    allowRelayLookup &&
    (!active?.keys.includes(pubkey) || active.controller.signal.aborted)
  ) {
    pending.add(pubkey);
    schedule();
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    listeners.delete(receive);
    if (!listeners.size) owners.delete(pubkey);
    if (allowRelayLookup) {
      const remaining = (lookupOwners.get(pubkey) ?? 1) - 1;
      if (remaining) lookupOwners.set(pubkey, remaining);
      else lookupOwners.delete(pubkey);
    }
    if (!lookupOwners.has(pubkey)) {
      pending.delete(pubkey);
    }
    if (!owners.size) {
      unsubscribeStorage?.();
      unsubscribeStorage = undefined;
      if (notifyTimer) clearTimeout(notifyTimer);
      notifyTimer = undefined;
    }
    if (active && active.keys.every((key) => !lookupOwners.has(key))) active.controller.abort();
    if (!pending.size && timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

async function flush(): Promise<void> {
  timer = undefined;
  const keys = [...pending].slice(0, MAX_BATCH);
  keys.forEach((key) => pending.delete(key));
  const batch = { keys, controller: new AbortController(), owner: profileOwner };
  active = batch;
  const signal = batch.controller.signal;
  const resolved = new Map<string, MentionProfile>();
  const queried = new Set<string>();
  try {
    const stored = await (
      batch.owner ? readCachedDisplayProfiles(batch.owner, keys) : storage.getMany(keys)
    ).catch(() => new Map<string, storage.CachedZapSenderProfile>());
    if (signal.aborted) return;
    for (const [key, profile] of stored) {
      const name = profile.displayName?.trim() || profile.name?.trim();
      if (!name) continue;
      resolved.set(key, {
        name,
        picture: profile.picture,
      });
    }
    const missing = keys.filter((key) => !resolved.has(key) && lookupOwners.has(key));
    // Snapshot relay configuration for this shared batch. Retry only missing
    // authors, once, with the same abort signal and bounded filter.
    const attempts = [readRelays, retryRelays];
    const best = new Map<string, number>();
    for (const relays of attempts) {
      const unresolved = missing.filter((key) => !resolved.get(key)?.name && lookupOwners.has(key));
      if (signal.aborted) return;
      if (!unresolved.length || !relays.length) continue;
      unresolved.forEach((key) => queried.add(key));
      trackRelays(relays);
      // kind-0 is structure-only in the shared pool. Display fields don't
      // need schnorr checks; payment fields are fetched on the profile page.
      const events = await querySyncAbortable(
        pool,
        relays,
        { kinds: [0], authors: unresolved, limit: unresolved.length * 2 },
        { signal, maxWait: 3000 },
      ).catch(() => []);
      for (const event of events) {
        if (signal.aborted) return;
        if (
          event.kind !== 0 ||
          !unresolved.includes(event.pubkey) ||
          event.content.length > 32768 ||
          event.created_at > Date.now() / 1000 + 300 ||
          event.created_at <= (best.get(event.pubkey) ?? -Infinity)
        )
          continue;
        try {
          const data = JSON.parse(event.content);
          const field = (value: unknown) =>
            typeof value === 'string' ? value.trim() || null : null;
          resolved.set(event.pubkey, {
            name: field(data.display_name) ?? field(data.name),
            picture: field(data.picture),
          });
          best.set(event.pubkey, event.created_at);
        } catch {
          /* Invalid cosmetic metadata. */
        }
      }
    }
    if (signal.aborted) return;
    for (const key of keys) {
      if (!resolved.has(key) && !queried.has(key)) {
        // A consumer can return after the relay filter was built. Its key
        // has not been queried, so a negative cache entry would be fabricated.
        if (lookupOwners.has(key) && readRelays.length) pending.add(key);
        continue;
      }
      const profile = resolved.get(key) ?? { ...EMPTY };
      cache.delete(key);
      cache.set(key, { profile, at: Date.now() });
      // A member/cache write may have arrived while the relay query waited.
      // Preserve the higher-priority local name instead of flashing a miss.
      const latest = peekMentionProfile(key);
      for (const receive of owners.get(key) ?? []) receive(latest);
    }
    while (cache.size > 300) cache.delete(cache.keys().next().value!);
  } catch {
    /* A later focus can retry a failed batch. */
  } finally {
    active = undefined;
    schedule();
  }
}

export function __resetMentionProfilesForTests(): void {
  unsubscribeStorage?.();
  unsubscribeStorage = undefined;
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = undefined;
  active?.controller.abort();
  if (timer) clearTimeout(timer);
  timer = undefined;
  owners.clear();
  lookupOwners.clear();
  pending.clear();
  cache.clear();
  readRelays = [];
  retryRelays = [];
  profileOwner = null;
}
