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
// they WRITE (kind-10002 write). Shared, bounded, and cached so a busy chat
// doesn't re-query on every message:
//
//   - one REQ per lookup relay per batch, `limit` = authors per kind (so a
//     single pubkey is `limit: 1` per kind), resolved on EOSE or `maxWait`;
//   - lookups go to the indexers, the viewer's read relays and the defaults —
//     locked to the LAN test relay for test accounts, like every other read;
//   - newest-wins across relays (`pickLatestReplaceable`);
//   - in-memory LRU with TTLs: found lists 10 min, "nothing published" 2 min,
//     a failed lookup 30 s (so a flaky network retries soon, a dead one
//     doesn't get hammered); one lookup in flight per pubkey;
//   - every relay URL is untrusted peer input: sanitised and capped
//     (utils/peerRelayUrls) before it is stored.
//
// Nothing here runs at cold start: lookups only happen when a send (or a later
// caller — Marmot welcomes #1402, profile views) asks for them.

/** A peer's lists. `null` means the peer hasn't published that kind. */
export interface PeerRelayLists {
  /** NIP-17 kind-10050 DM inbox relays. */
  inbox: string[] | null;
  /** NIP-65 kind-10002 read ("inbox") relays. */
  read: string[] | null;
  /** NIP-65 kind-10002 write ("outbox") relays. */
  write: string[] | null;
}

/**
 * `ok`: at least one relay answered (lists may all be `null` — "nothing
 * published"). `failed`: no relay answered, so absence is unknown.
 */
export type PeerRelayListResult =
  | { status: 'ok'; lists: PeerRelayLists }
  | { status: 'failed'; error: string };

export interface PeerRelayLookupOptions {
  /** Whose lookup this is — decides test-relay lockdown. Defaults to the active account. */
  viewerPubkey?: string | null;
  /** The viewer's own read relays, asked alongside the indexers and defaults. */
  lookupRelays?: readonly string[];
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

interface CacheEntry {
  result: PeerRelayListResult;
  at: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PeerRelayListResult>>();

/** Locked and unlocked lookups read different relays, so they never share an entry. */
function cacheKey(pubkey: string, viewer: string | null | undefined): string {
  return `${isTestRelayLockdown(viewer) ? 'locked' : 'open'}:${pubkey}`;
}

function ttlFor(result: PeerRelayListResult): number {
  if (result.status === 'failed') return PEER_LIST_FAILED_TTL_MS;
  const { inbox, read, write } = result.lists;
  return inbox || read || write ? PEER_LIST_TTL_MS : PEER_LIST_ABSENT_TTL_MS;
}

function freshEntry(key: string): PeerRelayListResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at >= ttlFor(entry.result)) {
    cache.delete(key);
    return undefined;
  }
  // Refresh recency: Map iteration order is the LRU order.
  cache.delete(key);
  cache.set(key, entry);
  return entry.result;
}

function store(key: string, result: PeerRelayListResult): void {
  cache.delete(key);
  cache.set(key, { result, at: Date.now() });
  while (cache.size > MAX_CACHED_PEERS) cache.delete(cache.keys().next().value!);
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

/** Sanitised lists for `pubkey` from the events one lookup returned. */
export function peerListsFromEvents(events: readonly Event[], pubkey: string): PeerRelayLists {
  const inbox = pickLatestReplaceable(events, pubkey, 10050);
  const nip65 = pickLatestReplaceable(events, pubkey, 10002);
  return {
    inbox: inbox ? sanitizePeerRelayUrls(tagValues(inbox, 'relay')) : null,
    read: nip65 ? sanitizePeerRelayUrls(tagValues(nip65, 'r', 'read')) : null,
    write: nip65 ? sanitizePeerRelayUrls(tagValues(nip65, 'r', 'write')) : null,
  };
}

interface LookupBatch {
  results: Map<string, PeerRelayListResult>;
  /** False when the reads were redirected for another account (don't cache). */
  cacheable: boolean;
}

async function lookupBatch(
  pubkeys: string[],
  viewer: string | null | undefined,
  lookupRelays: readonly string[] | undefined,
): Promise<LookupBatch> {
  const relays = peerLookupRelays(viewer, lookupRelays);
  const started = Date.now();
  const out = new Map<string, PeerRelayListResult>();
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
    ];
    const events = await pool.querySyncFilters(relays, filters, PEER_LOOKUP_MAX_WAIT_MS, {
      requireAnswer: true,
    });
    for (const pubkey of pubkeys) {
      out.set(pubkey, { status: 'ok', lists: peerListsFromEvents(events, pubkey) });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    for (const pubkey of pubkeys) out.set(pubkey, { status: 'failed', error: message });
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
  const found = [...out.values()].filter((r) => r.status === 'ok').length;
  perfLog(
    `peerRelayLists lookup owner=${perfOwnerTag(viewer ?? null)} n=${pubkeys.length} ` +
      `ok=${found} relays=${relays.length} ${Date.now() - started}ms`,
  );
  return { results: out, cacheable: !redirected };
}

/** A fresh cached result, without any network. */
export function peekPeerRelayLists(
  pubkey: string,
  viewerPubkey: string | null | undefined = getCurrentUserPubkey(),
): PeerRelayListResult | undefined {
  return freshEntry(cacheKey(pubkey.toLowerCase(), viewerPubkey));
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
    const cached = freshEntry(key);
    if (cached) {
      hits++;
      pending.set(pubkey, Promise.resolve(cached));
      continue;
    }
    const shared = inFlight.get(key);
    if (shared) {
      pending.set(pubkey, shared);
      continue;
    }
    queued.add(pubkey);
    toFetch.push(pubkey);
  }
  for (let i = 0; i < toFetch.length; i += MAX_AUTHORS_PER_LOOKUP) {
    const chunk = toFetch.slice(i, i + MAX_AUTHORS_PER_LOOKUP);
    const batch = lookupBatch(chunk, viewer, options.lookupRelays);
    for (const pubkey of chunk) {
      const key = cacheKey(pubkey, viewer);
      const run = batch
        .then(({ results, cacheable }) => {
          const result = results.get(pubkey) ?? { status: 'failed', error: 'missing result' };
          if (cacheable) store(key, result);
          return result;
        })
        .finally(() => {
          if (inFlight.get(key) === run) inFlight.delete(key);
        });
      inFlight.set(key, run);
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
