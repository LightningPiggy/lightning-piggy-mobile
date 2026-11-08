import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { sanitizePeerRelayUrls } from '../utils/peerRelayUrls';
import { normalizeRelayUrl } from '../utils/relayListKey';
import { getCurrentUserPubkey } from './nostrActiveAccount';
import { pooledRelayUrls, pruneIdleRelays, releaseNewIdleRelays } from './nostrPool';
import { getPeerRelayLists, peekPeerRelayLists } from './peerRelayLists';

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
// A relay the pool hadn't opened before its first lease is released once its
// last lease ends (the #1570 idle-release path), so browsing many profiles
// doesn't leave a trail of open sockets.
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
/** A released socket that was still busy is retried once after this long. */
export const OUTBOX_RELEASE_RETRY_MS = 5_000;

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

/** A person's cached read (inbox) relays (no network), capped. Empty under lockdown. */
export function cachedAuthorReadRelays(
  pubkey: string,
  viewerPubkey: string | null | undefined = getCurrentUserPubkey(),
): string[] {
  if (isTestRelayLockdown(viewerPubkey)) return [];
  const peek = peekPeerRelayLists(pubkey, viewerPubkey);
  if (peek?.status !== 'ok') return [];
  return (peek.lists.read ?? []).slice(0, MAX_AUTHOR_OUTBOX_RELAYS);
}

/**
 * A person's NIP-65 write relays — cached, or looked up once (shared, bounded,
 * TTL'd by ./peerRelayLists). Sanitised and capped; empty when unknown or
 * under lockdown. Never rejects.
 */
export async function authorWriteRelays(
  pubkey: string,
  options: { viewerPubkey?: string | null; lookupRelays?: readonly string[] } = {},
): Promise<string[]> {
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  if (isTestRelayLockdown(viewer)) return [];
  const result = await getPeerRelayLists(pubkey, {
    viewerPubkey: viewer,
    lookupRelays: options.lookupRelays,
  });
  if (result.status !== 'ok') return [];
  return (result.lists.write ?? []).slice(0, MAX_AUTHOR_OUTBOX_RELAYS);
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
  return withoutRelays(
    [...writeRelays, ...sanitizePeerRelayUrls(hints, MAX_AUTHOR_OUTBOX_RELAYS)],
    alreadyAsked,
  );
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
  count: number;
  /** Pooled before its first lease: someone else's socket, never released here. */
  wasPooled: boolean;
}

const leased = new Map<string, Leased>();

/** Distinct extra relays leased right now (tests, perf logs). */
export function leasedOutboxRelayCount(): number {
  return leased.size;
}

/**
 * Lease extra relays for one person's reads. A relay already leased is shared
 * (no new socket); a new one is granted only while fewer than
 * MAX_OUTBOX_EXTRA_RELAYS are leased.
 */
export function leaseOutboxRelays(urls: readonly string[]): OutboxRelayLease {
  const granted: string[] = [];
  let pooled: ReadonlySet<string> | undefined;
  for (const raw of urls) {
    const url = normalizeRelayUrl(raw);
    if (granted.includes(url)) continue;
    const held = leased.get(url);
    if (held) {
      held.count++;
    } else {
      if (leased.size >= MAX_OUTBOX_EXTRA_RELAYS) continue;
      pooled ??= pooledRelayUrls();
      leased.set(url, { count: 1, wasPooled: pooled.has(url) });
    }
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
        if (--held.count > 0) continue;
        leased.delete(url);
        if (!held.wasPooled) toRelease.push(url);
      }
      if (toRelease.length > 0) releaseSockets(toRelease);
    },
  };
}

function releaseSockets(urls: string[]): void {
  try {
    releaseNewIdleRelays(urls, new Set());
  } catch {
    // Releasing is best-effort.
  }
  // A socket still connecting (or finishing a CLOSE) isn't idle yet: try once more.
  setTimeout(() => {
    const idle = urls.filter((url) => !leased.has(url));
    if (idle.length === 0) return;
    try {
      pruneIdleRelays(idle);
    } catch {
      // Best-effort.
    }
  }, OUTBOX_RELEASE_RETRY_MS);
}

/** Forget every lease (tests). */
export function __resetOutboxLeasesForTests(): void {
  leased.clear();
}
