import type { Event, Filter } from 'nostr-tools';
import { isTestRelayLockdown, lockRelays } from '../config/testRelayLockdown';
import { perfLog, perfOwnerTag } from '../utils/perfLog';
import { sanitizePeerRelayUrls, MAX_PEER_RELAY_CANDIDATES } from '../utils/peerRelayUrls';
import { normalizeRelayUrl } from '../utils/relayListKey';
import { isRelayUrl, RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { enabledAppRelays } from './appRelayPrefs';
import { getCurrentUserPubkey, onCurrentUserPubkeyChange } from './nostrActiveAccount';
import { pool, pooledRelayUrls, releaseNewIdleRelays, trackRelays } from './nostrPool';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import { pickLatestReplaceable } from './nostrRelayLists';

// Someone else's relay lists (#1570) — the outbox model's lookup half: where a
// peer RECEIVES (kind-10050 NIP-17 inbox, kind-10002 NIP-65 read) and where
// they WRITE (kind-10002 write) — plus, for callers that ask, where they
// publish Marmot key packages (MIP-00 kind 10051, #1402). Shared, bounded, and
// cached so a busy chat doesn't re-query on every message:
//
//   - one REQ per lookup relay per batch, `limit` = authors per kind (so a
//     single pubkey is `limit: 1` per kind), resolved on EOSE or `maxWait`;
//     kind 10051 only when the caller asks (`withKeyPackageRelays`): DM
//     lookups don't ask the Marmot relays it lives on, so they never record
//     it as absent;
//   - lookups go to the indexers, the viewer's read relays and the defaults —
//     locked to the LAN test relay for test accounts, like every other read;
//   - newest-wins across relays (`pickLatestReplaceable`);
//   - in-memory LRU with TTLs PER KIND: found 10 min, absent 2 min, unknown
//     30 s (so a flaky network retries soon, a dead one doesn't get
//     hammered); one lookup in flight per pubkey. "Absent" needs a COMPLETED
//     lookup (a relay reached EOSE): a kind missing from a read no relay
//     completed is unknown, never absent, so a dropped connection can't hide a
//     peer's list for minutes;
//   - every relay URL is untrusted peer input: sanitised and capped
//     (utils/peerRelayUrls) before it is stored.
//
// Nothing here runs at cold start: lookups only happen when a send, a Marmot
// invite or Welcome (#1402), or a later caller (profile views) asks for them.

/**
 * A peer's lists, each one: the sanitised relays when found, `null` when a
 * completed lookup (a relay reached EOSE) found none, `undefined` when the
 * lookup couldn't tell.
 */
export interface PeerRelayLists {
  /** NIP-17 kind-10050 DM inbox relays. */
  inbox: string[] | null | undefined;
  /** NIP-65 kind-10002 read ("inbox") relays. */
  read: string[] | null | undefined;
  /** NIP-65 kind-10002 write ("outbox") relays. */
  write: string[] | null | undefined;
  /** MIP-00 kind-10051 KeyPackage relays. Only looked up `withKeyPackageRelays`;
   * otherwise left unknown (`undefined`). */
  keyPackage?: string[] | null | undefined;
  /**
   * A stricter "no 10050" for irreversible uses (a Marmot Welcome is signed
   * and frozen on fallback relays, #1402): `inbox` is absent AND that same
   * lookup either found another of the peer's lists or got an EOSE from a
   * relay-list indexer. One fast relay that never had the event can't confirm
   * it. NIP-17 delivery's reversible extras use `inbox` alone.
   */
  inboxAbsenceConfirmed?: boolean;
}

/**
 * `ok`: at least one kind is known (found, or absent per a completed lookup).
 * `failed`: nothing is known, e.g. no relay answered.
 */
export type PeerRelayListResult =
  | { status: 'ok'; lists: PeerRelayLists }
  | { status: 'failed'; error: string };

export interface PeerRelayLookupOptions {
  /** Whose lookup this is — decides test-relay lockdown. Defaults to the active account. */
  viewerPubkey?: string | null;
  /** The viewer's own read relays, asked alongside the indexers and defaults. */
  lookupRelays?: readonly string[];
  /** Cancels this caller's NEW lookups (closes their REQs). An aborted lookup
   * is never cached and never shared with other callers; lookups already in
   * flight for someone else are awaited, not cancelled. */
  signal?: AbortSignal;
  /** Also look up (and wait for) the kind-10051 KeyPackage relay list. */
  withKeyPackageRelays?: boolean;
}

export const PEER_LIST_TTL_MS = 10 * 60_000;
export const PEER_LIST_ABSENT_TTL_MS = 2 * 60_000;
export const PEER_LIST_FAILED_TTL_MS = 30_000;
/** Most peers remembered; the least recently used is dropped first. */
export const MAX_CACHED_PEERS = 256;
/** Most authors in one REQ; larger batches are split. */
export const MAX_AUTHORS_PER_LOOKUP = 20;
/** Most relays one lookup asks. */
export const MAX_LOOKUP_RELAYS = 10;
/** Relay-side wait for one lookup (callers on a send path race a shorter timeout). */
export const PEER_LOOKUP_MAX_WAIT_MS = 4_000;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

/** One kind's cached state. A found list keeps its event's identity so only a
 * strictly newer event (NIP-01: later created_at, ties to the lower id) replaces it. */
type KindState<T> =
  | { state: 'found'; value: T; at: number; createdAt: number; eventId: string }
  /** `indexer`: a relay-list indexer reached EOSE in the lookup that found it absent. */
  | { state: 'absent' | 'unknown'; at: number; indexer?: boolean };

interface Nip65Lists {
  read: string[];
  write: string[];
}

interface CacheEntry {
  inbox: KindState<string[]>;
  nip65: KindState<Nip65Lists>;
  /** Missing until a lookup asks for kind 10051. */
  keyPackage?: KindState<string[]>;
  /** Why the kinds are unknown, for a `failed` result. */
  error?: string;
}

const KIND_TTL_MS = {
  found: PEER_LIST_TTL_MS,
  absent: PEER_LIST_ABSENT_TTL_MS,
  unknown: PEER_LIST_FAILED_TTL_MS,
} as const;

/** The SDK's close reason for a relay that sent a real EOSE. */
const EOSE_REASON = 'closed automatically on eose';

const cache = new Map<string, CacheEntry>();
/** A lookup in flight per key, and whether it covers kind 10051. */
const inFlight = new Map<string, { run: Promise<PeerRelayListResult>; keyPackage: boolean }>();

/** Locked and unlocked lookups read different relays, so they never share an entry. */
function cacheKey(pubkey: string, viewer: string | null | undefined): string {
  return `${isTestRelayLockdown(viewer) ? 'locked' : 'open'}:${pubkey}`;
}

type Siblings = readonly (KindState<unknown> | undefined)[];

/** A kind's TTL. An absence confirmed by the same completed lookup that FOUND
 * another kind lives as long as that find, so a peer with just one list
 * isn't re-queried every couple of minutes. */
function isFresh(kind: KindState<unknown>, siblings: Siblings = [], now = Date.now()): boolean {
  const ttl =
    kind.state === 'absent' && siblings.some((s) => s?.state === 'found' && s.at === kind.at)
      ? PEER_LIST_TTL_MS
      : KIND_TTL_MS[kind.state];
  return now - kind.at < ttl;
}

function kindValue<T>(kind: KindState<T>): T | null | undefined {
  return kind.state === 'found' ? kind.value : kind.state === 'absent' ? null : undefined;
}

function toResult(entry: CacheEntry): PeerRelayListResult {
  if (
    entry.inbox.state === 'unknown' &&
    entry.nip65.state === 'unknown' &&
    (entry.keyPackage?.state ?? 'unknown') === 'unknown'
  ) {
    return { status: 'failed', error: entry.error ?? 'lookup incomplete' };
  }
  const nip65 = kindValue(entry.nip65);
  const { inbox } = entry;
  const inboxAbsenceConfirmed =
    inbox.state === 'absent' &&
    (inbox.indexer === true ||
      [entry.nip65, entry.keyPackage].some((k) => k?.state === 'found' && k.at === inbox.at));
  return {
    status: 'ok',
    lists: {
      inbox: kindValue(inbox),
      read: nip65 === undefined ? undefined : (nip65?.read ?? null),
      write: nip65 === undefined ? undefined : (nip65?.write ?? null),
      ...(entry.keyPackage ? { keyPackage: kindValue(entry.keyPackage) } : {}),
      ...(inboxAbsenceConfirmed ? { inboxAbsenceConfirmed } : {}),
    },
  };
}

interface CachedView {
  result: PeerRelayListResult;
  /** Every kind is fresh: no lookup needed. */
  complete: boolean;
}

/**
 * The cache's fresh knowledge for `key`. Kinds expire on their own: an expired
 * kind reads as unknown (and is re-looked up) while another kind's fresh list
 * is still served. `complete` covers kind 10051 only `withKeyPackage`.
 * Undefined when nothing is fresh.
 */
function cachedView(key: string, withKeyPackage = false): CachedView | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  const now = Date.now();
  const { inbox, nip65, keyPackage } = entry;
  const inboxFresh = isFresh(inbox, [nip65, keyPackage], now);
  const nip65Fresh = isFresh(nip65, [inbox, keyPackage], now);
  const keyPackageFresh = !!keyPackage && isFresh(keyPackage, [inbox, nip65], now);
  if (!inboxFresh && !nip65Fresh && !keyPackageFresh) return undefined;
  // Refresh recency: Map iteration order is the LRU order.
  cache.delete(key);
  cache.set(key, entry);
  const expired = (kind: KindState<unknown>) => ({ state: 'unknown', at: kind.at }) as const;
  const view: CacheEntry = {
    inbox: inboxFresh ? inbox : expired(inbox),
    nip65: nip65Fresh ? nip65 : expired(nip65),
    ...(keyPackage ? { keyPackage: keyPackageFresh ? keyPackage : expired(keyPackage) } : {}),
    error: entry.error,
  };
  return {
    result: toResult(view),
    complete: inboxFresh && nip65Fresh && (!withKeyPackage || keyPackageFresh),
  };
}

const isNewerList = (
  a: { createdAt: number; eventId: string },
  b: { createdAt: number; eventId: string },
): boolean => a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.eventId < b.eventId);

/**
 * Fold one lookup's state for a kind into what's cached:
 *   - two finds: the newer event wins; an older or identical one only
 *     re-confirms the cached list;
 *   - a fresh find is never downgraded by a later lookup — not to absent (that
 *     lookup may simply have asked relays without the event), not to unknown;
 *     a fresh absence isn't downgraded to unknown either;
 *   - otherwise the new state replaces it.
 */
function mergeKind<T>(
  old: KindState<T> | undefined,
  oldSiblings: Siblings,
  next: KindState<T>,
): KindState<T> {
  if (!old) return next;
  if (old.state === 'found' && next.state === 'found') {
    return isNewerList(next, old) ? next : { ...old, at: next.at };
  }
  const oldFresh = isFresh(old, oldSiblings);
  if (old.state === 'found' && oldFresh) return old;
  if (next.state === 'unknown' && old.state === 'absent' && oldFresh) return old;
  return next;
}

/** A lookup's states merged with what's cached (see `mergeKind`); writes nothing.
 * A lookup that didn't ask for kind 10051 leaves its cached state as it was. */
function mergedWithCache(key: string, next: CacheEntry): CacheEntry {
  const prev = cache.get(key);
  const keyPackage = next.keyPackage
    ? mergeKind(prev?.keyPackage, [prev?.inbox, prev?.nip65], next.keyPackage)
    : prev?.keyPackage;
  return {
    inbox: mergeKind(prev?.inbox, [prev?.nip65, prev?.keyPackage], next.inbox),
    nip65: mergeKind(prev?.nip65, [prev?.inbox, prev?.keyPackage], next.nip65),
    ...(keyPackage ? { keyPackage } : {}),
    error: next.error,
  };
}

/** Store a lookup's states, merged with what's cached. */
function store(key: string, next: CacheEntry): CacheEntry {
  const merged = mergedWithCache(key, next);
  cache.delete(key);
  cache.set(key, merged);
  while (cache.size > MAX_CACHED_PEERS) cache.delete(cache.keys().next().value!);
  return merged;
}

/** Indexers first (that's where relay lists live), then the viewer's read relays, then defaults. */
export function peerLookupRelays(
  viewer: string | null | undefined,
  lookupRelays: readonly string[] = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of [
    ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS, viewer),
    ...lookupRelays,
    ...enabledAppRelays('default', DEFAULT_RELAYS, viewer),
  ]) {
    if (out.length >= MAX_LOOKUP_RELAYS) break;
    if (typeof url !== 'string' || !isRelayUrl(url)) continue;
    const key = normalizeRelayUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return [...lockRelays(out, viewer)];
}

/** Bounded tag scan: the first values of `name` tags (optionally with a NIP-65 marker). */
function tagValues(event: Event, name: string, marker?: 'read' | 'write'): string[] {
  const out: string[] = [];
  for (const tag of event.tags) {
    if (out.length >= MAX_PEER_RELAY_CANDIDATES) break;
    if (!Array.isArray(tag) || tag[0] !== name || typeof tag[1] !== 'string') continue;
    if (marker && tag[2] && tag[2] !== marker) continue;
    out.push(tag[1]);
  }
  return out;
}

/**
 * Cache states for `pubkey` from one lookup's events. A kind without an event
 * is `absent` only if the lookup `complete`d (a relay reached EOSE).
 */
function peerEntryFromEvents(
  events: readonly Event[],
  pubkey: string,
  complete: boolean,
  withKeyPackage: boolean,
  at = Date.now(),
  indexerEose = false,
): CacheEntry {
  const missing: KindState<never> = complete
    ? { state: 'absent', at, ...(indexerEose ? { indexer: true } : {}) }
    : { state: 'unknown', at };
  /** A list of `relay` tags (kinds 10050, 10051). */
  const relayList = (kind: number): KindState<string[]> => {
    const event = pickLatestReplaceable(events, pubkey, kind);
    return event
      ? {
          state: 'found',
          value: sanitizePeerRelayUrls(tagValues(event, 'relay')),
          at,
          createdAt: event.created_at,
          eventId: event.id,
        }
      : missing;
  };
  const nip65 = pickLatestReplaceable(events, pubkey, 10002);
  return {
    inbox: relayList(10050),
    ...(withKeyPackage ? { keyPackage: relayList(10051) } : {}),
    nip65: nip65
      ? {
          state: 'found',
          value: {
            read: sanitizePeerRelayUrls(tagValues(nip65, 'r', 'read')),
            write: sanitizePeerRelayUrls(tagValues(nip65, 'r', 'write')),
          },
          at,
          createdAt: nip65.created_at,
          eventId: nip65.id,
        }
      : missing,
    ...(complete ? {} : { error: 'no relay completed the lookup' }),
  };
}

const unknownEntry = (error: string, withKeyPackage: boolean, at = Date.now()): CacheEntry => ({
  inbox: { state: 'unknown', at },
  nip65: { state: 'unknown', at },
  ...(withKeyPackage ? { keyPackage: { state: 'unknown', at } as const } : {}),
  error,
});

interface LookupBatch {
  entries: Map<string, CacheEntry>;
  /** False when the reads were redirected for another account (don't cache). */
  cacheable: boolean;
}

async function lookupBatch(
  pubkeys: string[],
  viewer: string | null | undefined,
  lookupRelays: readonly string[] | undefined,
  withKeyPackage: boolean,
  signal?: AbortSignal,
): Promise<LookupBatch> {
  if (signal?.aborted) {
    return {
      entries: new Map(pubkeys.map((pk) => [pk, unknownEntry('aborted', withKeyPackage)])),
      cacheable: false,
    };
  }
  const relays = peerLookupRelays(viewer, lookupRelays);
  const started = Date.now();
  const out = new Map<string, CacheEntry>();
  let complete = false;
  let indexerEose = false;
  // The relay-list indexers this viewer asks (only these can confirm an absence).
  const indexers = new Set(
    enabledAppRelays('indexers', RELAY_LIST_INDEXERS, viewer).map(normalizeRelayUrl),
  );
  let before: ReadonlySet<string> | undefined;
  // The pool routes reads by the ACTIVE account: if a test account is (or
  // becomes) active while an ordinary viewer's lookup runs, its reads go to the
  // test relay, and that answer must not be cached as the viewer's.
  const viewerLocked = isTestRelayLockdown(viewer);
  let redirected = !viewerLocked && isTestRelayLockdown(getCurrentUserPubkey());
  const stopWatching = viewerLocked
    ? undefined
    : onCurrentUserPubkeyChange((pubkey) => {
        if (isTestRelayLockdown(pubkey)) redirected = true;
      });
  try {
    before = pooledRelayUrls();
    trackRelays(relays);
    const filters: Filter[] = [
      { kinds: [10050], authors: pubkeys, limit: pubkeys.length },
      { kinds: [10002], authors: pubkeys, limit: pubkeys.length },
      ...(withKeyPackage ? [{ kinds: [10051], authors: pubkeys, limit: pubkeys.length }] : []),
    ];
    const events = await pool.querySyncFilters(relays, filters, PEER_LOOKUP_MAX_WAIT_MS, {
      abort: signal,
      requireAnswer: true,
      onClose: (reasons, urls = []) => {
        complete = reasons.includes(EOSE_REASON);
        indexerEose = reasons.some(
          (reason, i) => reason === EOSE_REASON && indexers.has(normalizeRelayUrl(urls[i] ?? '')),
        );
      },
    });
    const at = Date.now();
    for (const pubkey of pubkeys)
      out.set(
        pubkey,
        // Cut short by the caller: it can't tell "absent" from "not asked".
        signal?.aborted
          ? unknownEntry('aborted', withKeyPackage, at)
          : peerEntryFromEvents(events, pubkey, complete, withKeyPackage, at, indexerEose),
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const pubkey of pubkeys) out.set(pubkey, unknownEntry(message, withKeyPackage));
  } finally {
    stopWatching?.();
    // Indexers are usually one-off sockets: release the ones this lookup opened
    // once idle. Sockets that were already pooled are left alone.
    try {
      if (before) releaseNewIdleRelays(relays, before);
    } catch {
      // Releasing is best-effort.
    }
  }
  const found = [...out.values()].filter((e) => toResult(e).status === 'ok').length;
  perfLog(
    `peerRelayLists lookup owner=${perfOwnerTag(viewer ?? null)} n=${pubkeys.length} ` +
      `ok=${found} complete=${complete} relays=${relays.length} ${Date.now() - started}ms`,
  );
  return { entries: out, cacheable: !redirected && !signal?.aborted };
}

/** The fresh cached knowledge, without any network — a kind that expired (and
 * may be being re-looked up) reads as unknown while the other is still served. */
export function peekPeerRelayLists(
  pubkey: string,
  viewerPubkey: string | null | undefined = getCurrentUserPubkey(),
): PeerRelayListResult | undefined {
  return cachedView(cacheKey(pubkey.toLowerCase(), viewerPubkey))?.result;
}

/**
 * Relay lists for several peers: cached ones at once, in-flight lookups
 * shared, the rest fetched in batches. Never rejects.
 */
export async function getManyPeerRelayLists(
  pubkeys: readonly string[],
  options: PeerRelayLookupOptions = {},
): Promise<Map<string, PeerRelayListResult>> {
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  const withKeyPackage = options.withKeyPackageRelays === true;
  const pending = new Map<string, Promise<PeerRelayListResult>>();
  const toFetch: string[] = [];
  const queued = new Set<string>();
  let hits = 0;
  for (const raw of pubkeys) {
    const pubkey = raw.trim().toLowerCase();
    if (pending.has(pubkey) || queued.has(pubkey)) continue;
    if (!HEX_PUBKEY.test(pubkey)) {
      pending.set(pubkey, Promise.resolve({ status: 'failed', error: 'invalid pubkey' }));
      continue;
    }
    const key = cacheKey(pubkey, viewer);
    const cached = cachedView(key, withKeyPackage);
    if (cached?.complete) {
      hits++;
      pending.set(pubkey, Promise.resolve(cached.result));
      continue;
    }
    const shared = inFlight.get(key);
    // A lookup without kind 10051 can't answer a caller that needs it.
    if (shared && (shared.keyPackage || !withKeyPackage)) {
      pending.set(pubkey, shared.run);
      continue;
    }
    queued.add(pubkey);
    toFetch.push(pubkey);
  }
  const { signal } = options;
  for (let i = 0; i < toFetch.length; i += MAX_AUTHORS_PER_LOOKUP) {
    const chunk = toFetch.slice(i, i + MAX_AUTHORS_PER_LOOKUP);
    const batch = lookupBatch(chunk, viewer, options.lookupRelays, withKeyPackage, signal);
    for (const pubkey of chunk) {
      const key = cacheKey(pubkey, viewer);
      const run = batch
        .then(({ entries, cacheable }) => {
          const entry = entries.get(pubkey) ?? unknownEntry('missing result', withKeyPackage);
          // A redirected (uncacheable) answer still mustn't hide fresh cached
          // finds: merge it the same way, just don't write it.
          return toResult(cacheable ? store(key, entry) : mergedWithCache(key, entry));
        })
        .finally(() => {
          if (inFlight.get(key)?.run === run) inFlight.delete(key);
        });
      // A cancellable lookup isn't shared: another caller mustn't inherit its abort.
      if (!signal) inFlight.set(key, { run, keyPackage: withKeyPackage });
      pending.set(pubkey, run);
    }
  }
  if (hits > 0) perfLog(`peerRelayLists cache hits=${hits}/${pending.size}`);
  const entries = await Promise.all(
    [...pending].map(async ([pubkey, result]) => [pubkey, await result] as const),
  );
  return new Map(entries);
}

/** One peer's relay lists (see `getManyPeerRelayLists`). Never rejects. */
export async function getPeerRelayLists(
  pubkey: string,
  options: PeerRelayLookupOptions = {},
): Promise<PeerRelayListResult> {
  const results = await getManyPeerRelayLists([pubkey], options);
  return results.get(pubkey.trim().toLowerCase())!;
}

/** Forget every cached list (tests; a later caller may use it on sign-out). */
export function clearPeerRelayListCache(): void {
  cache.clear();
  inFlight.clear();
}
