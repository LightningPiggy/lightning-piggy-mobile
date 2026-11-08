import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { OUTBOX_FRAMES_PER_LEASE } from './authorFeedLimits';
import { sanitizePeerRelayUrls } from '../utils/peerRelayUrls';
import { normalizeRelayUrl } from '../utils/relayListKey';
import {
  areCurrentUserOwnRelaysHydrated,
  getCurrentUserOwnRelays,
  getCurrentUserPubkey,
  onCurrentUserOwnRelaysChange,
} from './nostrActiveAccount';
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

// Raw frames an owned socket may receive per lease (derived in ./authorFeedLimits).
export { OUTBOX_FRAMES_PER_LEASE };

/** Whether `url` is quarantined (not to be asked again for now). */
export function isOutboxRelayQuarantined(url: string, now = Date.now()): boolean {
  return isQuarantined(normalizeRelayUrl(url), now);
}

/**
 * Run `fn` once the viewer's own relays are known (at once if they are):
 * nothing is leased before that, so callers that arrive early (a profile
 * opened at cold start) retry then instead of giving up. Returns a cancel.
 */
export function whenOwnRelaysHydrated(fn: () => void): () => void {
  if (areCurrentUserOwnRelaysHydrated()) {
    fn();
    return () => {};
  }
  const stop = onCurrentUserOwnRelaysChange(() => {
    if (!areCurrentUserOwnRelaysHydrated()) return;
    stop();
    fn();
  });
  return () => {
    stop();
  };
}

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
  // Nobody holds it any more: drop the grant now rather than linger until
  // the pool notices the closed socket.
  if (leased.get(url)?.holders.size === 0) forget(url);
}

function forget(url: string): void {
  leased.delete(url);
  clearRelayFrameBudget(url);
}

// A leased relay that BECOMES one of the viewer's own relays (account switch,
// relay edit) is theirs now: drop its grant and frame count at once — the
// viewer's own subs (e.g. the live DM inbox) keep the socket open — and take
// it back from any pending release, so it isn't closed under them.
onCurrentUserOwnRelaysChange((relays) => {
  for (const raw of relays) {
    const url = normalizeRelayUrl(raw);
    if (!leased.has(url)) continue;
    claimPendingRelease(url);
    forget(url);
  }
});
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
 * MAX_OUTBOX_EXTRA_RELAYS are leased or still closing. Quarantined relays, and
 * the viewer's own relays (read + DM inbox, whoever asks), are never granted —
 * and nothing is granted before the viewer's own relays are known (their lists
 * hydrated), so a cold start can't take one of them as an outbox socket.
 * Each lease on an owned socket adds OUTBOX_FRAMES_PER_LEASE to its frame
 * budget; `onRevoked` runs if that budget is blown (drop the lease).
 */
export function leaseOutboxRelays(
  urls: readonly string[],
  onRevoked?: () => void,
  /** Frames this lease adds to an owned socket's budget (sized by the caller's `limit`). */
  frames: number = OUTBOX_FRAMES_PER_LEASE,
): OutboxRelayLease {
  if (!areCurrentUserOwnRelaysHydrated()) return { relays: [], release: () => {} };
  forgetClosed();
  const granted: string[] = [];
  const now = Date.now();
  const own = new Set(getCurrentUserOwnRelays().map(normalizeRelayUrl));
  // This lease's own registration: two leases passing the same callback still
  // each get notified, and releasing one never unregisters the other.
  const revoke = onRevoked && (() => onRevoked());
  let pooled: ReadonlySet<string> | undefined;
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw);
    if (granted.includes(url) || own.has(url) || isQuarantined(url, now)) continue;
    let held = leased.get(url);
    if (held) {
      // Back in use before its socket closed: stop the pending release.
      if (held.count === 0 && held.owned) claimPendingRelease(url);
      // A borrowed socket that has since closed: the next one is ours to close.
      if (!held.owned) {
        pooled ??= pooledRelayUrls();
        if (!pooled.has(url)) held.owned = true;
      }
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
    if (held.owned) addRelayFrameBudget(url, frames, () => revokeOutboxRelay(url));
    if (revoke) held.holders.add(revoke);
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
        if (revoke) held.holders.delete(revoke);
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
