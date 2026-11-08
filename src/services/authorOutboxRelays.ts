import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { sanitizePeerRelayUrls } from '../utils/peerRelayUrls';
import { normalizeRelayUrl } from '../utils/relayListKey';
import { getCurrentUserPubkey } from './nostrActiveAccount';
import { claimPendingRelease, pooledRelayUrls, releaseNewIdleRelays } from './nostrPool';
import { addRelayFrameBudget, clearRelayFrameBudget } from './nostrRelayReceiveQueue';
import { getPeerRelayLists, peekPeerRelayLists } from './peerRelayLists';
import { recordRelayFailure } from './relayHealth';

// Reading someone else's posts and profile from THEIR relays (#1390) — the
// outbox model's read half. A person's kind-10002 write relays (looked up and
// cached by ./peerRelayLists) say where they publish; the viewer's own relays
// may never see those events.
//
// Every extra socket is bounded twice:
//   - per person: at most MAX_AUTHOR_OUTBOX_RELAYS of their relays (write
//     relays first, then hints), after dropping relays the viewer already uses;
//   - globally: at most MAX_OUTBOX_EXTRA_RELAYS distinct extra relays leased at
//     once, across every open feed and profile lookup. A lease that would go
//     past the ceiling gets fewer relays (or none), never more sockets.
// A relay the pool hadn't opened before its first lease (or one already
// waiting to be released) is "owned": when its last lease ends it's handed to
// the pool's deferred release (the #1570 path), which closes it as soon as
// its last read or publish ends — and it keeps counting against the ceiling
// until its socket is actually closed. Browsing many profiles doesn't leave
// a trail of open sockets.
//
// Hardening: an owned socket has a raw-frame budget (counted at the socket's
// message hook, before any parsing — nostrRelayReceiveQueue); one that blows
// it, or floods an outbox feed (authorFeedService), is closed, its leases are
// revoked and it's quarantined for a while (never leased again).
//
// Privacy: a query for person X only ever goes to X's own relays (plus the
// viewer's), with `authors: [X]`. Callers never batch several people onto one
// person's relay, so X's relay operator doesn't learn who else the viewer
// looks at.
//
// Test accounts in lockdown read only the LAN test relay, so they get no
// outbox relays at all (the test relay is already in their current set).

/** Most of one person's relays read on their behalf. */
export const MAX_AUTHOR_OUTBOX_RELAYS = 3;
/** Most distinct extra (outbox) relays leased at once, app-wide. */
export const MAX_OUTBOX_EXTRA_RELAYS = 25;
/** How long a quarantined relay isn't leased. */
export const OUTBOX_QUARANTINE_MS = 30 * 60_000;
/** Most quarantined relays remembered (oldest dropped first). */
const MAX_QUARANTINED = 64;

/** Ordered, deduped `urls` minus anything in `exclude` (normalised), capped. */
export function withoutRelays(
  urls: readonly string[],
  exclude: readonly string[],
  max = MAX_AUTHOR_OUTBOX_RELAYS,
): string[] {
  const skip = new Set(exclude.map(normalizeRelayUrl));
  const out: string[] = [];
  for (const url of urls) {
    if (out.length >= max) break;
    const key = normalizeRelayUrl(url);
    if (skip.has(key)) continue;
    skip.add(key);
    out.push(key);
  }
  return out;
}

/** A person's cached write relays (no network), capped. Empty under lockdown. */
export function cachedAuthorWriteRelays(
  pubkey: string,
  viewerPubkey: string | null | undefined = getCurrentUserPubkey(),
): string[] {
  if (isTestRelayLockdown(viewerPubkey)) return [];
  const peek = peekPeerRelayLists(pubkey, viewerPubkey);
  if (peek?.status !== 'ok') return [];
  return (peek.lists.write ?? []).slice(0, MAX_AUTHOR_OUTBOX_RELAYS);
}

/** A person's cached read (inbox) relays (no network; sanitised, ≤ 4). Empty
 * under lockdown. Cap AFTER dropping your own relays (`withoutRelays`). */
export function cachedAuthorReadRelays(
  pubkey: string,
  viewerPubkey: string | null | undefined = getCurrentUserPubkey(),
): string[] {
  if (isTestRelayLockdown(viewerPubkey)) return [];
  const peek = peekPeerRelayLists(pubkey, viewerPubkey);
  if (peek?.status !== 'ok') return [];
  return peek.lists.read ?? [];
}

/**
 * A person's NIP-65 write relays — cached, or looked up once (shared, bounded,
 * TTL'd by ./peerRelayLists). Sanitised (≤ 4), not yet capped: callers drop
 * their own relays first, then cap (`withoutRelays`), so an author whose first
 * relays overlap the viewer's still gets extras. Empty when unknown or under
 * lockdown. Never rejects.
 */
export async function authorWriteRelays(
  pubkey: string,
  options: {
    viewerPubkey?: string | null;
    lookupRelays?: readonly string[];
    signal?: AbortSignal;
  } = {},
): Promise<string[]> {
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  if (isTestRelayLockdown(viewer)) return [];
  const result = await getPeerRelayLists(pubkey, {
    viewerPubkey: viewer,
    lookupRelays: options.lookupRelays,
    signal: options.signal,
  });
  if (result.status !== 'ok' || options.signal?.aborted) return [];
  return result.lists.write ?? [];
}

/**
 * The relays one person's lookup may use: their write relays, then the
 * (untrusted, so sanitised) hints, minus the viewer's relays, capped.
 */
export function personOutboxRelays(
  writeRelays: readonly string[],
  hints: readonly unknown[],
  alreadyAsked: readonly string[],
): string[] {
  return withoutRelays([...writeRelays, ...sanitizePeerRelayUrls(hints)], alreadyAsked);
}

/**
 * NIP-57 zap request `relays`: where the recipient's LNURL server publishes
 * the receipt. The zapper's read relays, plus the recipient's cached read
 * relays so the recipient sees it too. Cache-only — a zap never waits on a
 * lookup — and the zapper's relays alone under lockdown.
 */
export function zapReceiptRelays(
  recipientPubkey: string,
  zapperReadRelays: readonly string[],
  viewerPubkey: string | null | undefined = getCurrentUserPubkey(),
): string[] {
  const extra = withoutRelays(
    cachedAuthorReadRelays(recipientPubkey, viewerPubkey),
    zapperReadRelays,
  );
  return [...zapperReadRelays, ...extra];
}

export interface OutboxRelayLease {
  /** The relays granted (a subset of the ask, within the global ceiling). */
  relays: string[];
  /** Ends the lease; idempotent. */
  release(): void;
}

interface Leased {
  /** Open leases; 0 while an owned socket waits to be closed. */
  count: number;
  /** Opened by a lease (or claimed back from a pending release): we close it. */
  owned: boolean;
  /** Each open lease's revocation callback (set when it asked for one). */
  holders: Set<() => void>;
}

const leased = new Map<string, Leased>();

/**
 * Raw frames (any message type, counted before any parsing) an owned socket
 * may receive per lease before it's cut off — hardening, sized so honest use
 * never trips it: a lease covers one person's live feed (at most
 * 4 × 30 events, see authorFeedService) plus up to 10 older pages of 30, plus
 * EOSE / CLOSED / NOTICE frames. Only owned sockets are counted.
 */
export const OUTBOX_FRAMES_PER_LEASE = 480;

/** An owned socket blew its frame budget: quarantine it, report it, and have
 * every holder drop its lease (the receive hook has closed the socket). */
function revokeOutboxRelay(url: string): void {
  quarantineOutboxRelay(url);
  try {
    recordRelayFailure(url);
  } catch {
    // Best-effort.
  }
  const held = leased.get(url);
  if (!held) return;
  for (const revoke of [...held.holders]) revoke();
}

function forget(url: string): void {
  leased.delete(url);
  clearRelayFrameBudget(url);
}
const quarantined = new Map<string, number>();

/** Stop leasing `url` for OUTBOX_QUARANTINE_MS (it misbehaved). */
export function quarantineOutboxRelay(url: string, now = Date.now()): void {
  const key = normalizeRelayUrl(url);
  quarantined.delete(key);
  quarantined.set(key, now + OUTBOX_QUARANTINE_MS);
  while (quarantined.size > MAX_QUARANTINED) quarantined.delete(quarantined.keys().next().value!);
}

function isQuarantined(url: string, now: number): boolean {
  const until = quarantined.get(url);
  if (until === undefined) return false;
  if (until > now) return true;
  quarantined.delete(url);
  return false;
}

/** Owned sockets whose leases ended stop counting once the pool closed them. */
function forgetClosed(): void {
  let pooled: ReadonlySet<string> | undefined;
  for (const [url, held] of leased) {
    if (held.count > 0) continue;
    pooled ??= pooledRelayUrls();
    if (!pooled.has(url)) forget(url);
  }
}

/** Distinct extra relays leased or still closing right now (tests, perf logs). */
export function leasedOutboxRelayCount(): number {
  forgetClosed();
  return leased.size;
}

/**
 * Lease extra relays for one person's reads. A relay already leased is shared
 * (no new socket); a new one is granted only while fewer than
 * MAX_OUTBOX_EXTRA_RELAYS are leased or still closing. Quarantined relays are
 * never granted. Each lease on an owned socket adds OUTBOX_FRAMES_PER_LEASE to
 * its frame budget; `onRevoked` runs if that budget is blown (drop the lease).
 */
export function leaseOutboxRelays(
  urls: readonly string[],
  onRevoked?: () => void,
): OutboxRelayLease {
  forgetClosed();
  const granted: string[] = [];
  const now = Date.now();
  let pooled: ReadonlySet<string> | undefined;
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw);
    if (granted.includes(url) || isQuarantined(url, now)) continue;
    let held = leased.get(url);
    if (held) {
      // Back in use before its socket closed: stop the pending release.
      if (held.count === 0 && held.owned) claimPendingRelease(url);
      held.count++;
    } else {
      if (leased.size >= MAX_OUTBOX_EXTRA_RELAYS) continue;
      pooled ??= pooledRelayUrls();
      // A pooled socket that's only waiting to be released is still a one-off:
      // claim it, or nobody would ever close it.
      const owned = !pooled.has(url) || claimPendingRelease(url);
      held = { count: 1, owned, holders: new Set() };
      leased.set(url, held);
    }
    if (held.owned) addRelayFrameBudget(url, OUTBOX_FRAMES_PER_LEASE, () => revokeOutboxRelay(url));
    if (onRevoked) held.holders.add(onRevoked);
    granted.push(url);
  }
  let released = false;
  return {
    relays: granted,
    release: () => {
      if (released) return;
      released = true;
      const toRelease: string[] = [];
      for (const url of granted) {
        const held = leased.get(url);
        if (!held) continue;
        if (onRevoked) held.holders.delete(onRevoked);
        if (--held.count > 0) continue;
        // Someone else's socket: just stop counting it. Ours: keep counting it
        // until the pool has closed it.
        if (held.owned) toRelease.push(url);
        else forget(url);
      }
      if (toRelease.length === 0) return;
      try {
        releaseNewIdleRelays(toRelease, new Set());
      } catch {
        // Releasing is best-effort.
      }
    },
  };
}

/** Forget every lease (tests). */
export function __resetOutboxLeasesForTests(): void {
  for (const url of leased.keys()) clearRelayFrameBudget(url);
  leased.clear();
  quarantined.clear();
}
