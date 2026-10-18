import { enabledAppRelays } from '../services/appRelayPrefs';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
import type { RelayConfig } from '../types/nostr';

/** Relay-list indexers most clients consult when looking up someone's relays. */
export const RELAY_LIST_INDEXERS = ['wss://purplepag.es', 'wss://user.kindpag.es'];

export interface UnsignedEvent {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

const norm = (url: string) => url.trim().replace(/\/+$/, '');

/**
 * A published relay list must be reachable by everyone: wss:// only, with a
 * real host. (A `ws://localhost` entry is how a test account once ended up
 * advertising an unreachable relay to the whole network.)
 */
const PRIVATE_IPV4 =
  /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** IPv4 dotted form embedded in an IPv4-mapped IPv6 literal (::ffff:…), else null. */
function mappedIPv4(v6: string): string | null {
  const m = /^::ffff:(.+)$/i.exec(v6);
  if (!m) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(m[1])) return m[1];
  const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(m[1]); // URL normalises to hex
  if (!hex) return null;
  const hi = parseInt(hex[1], 16);
  const lo = parseInt(hex[2], 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isPublishableRelayUrl(url: string): boolean {
  try {
    const u = new URL(norm(url));
    // Strip a terminal DNS dot ("localhost.") so it can't bypass the checks.
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (u.protocol !== 'wss:' || !host) return false;
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
      return false;
    // IPv6 literal: reject loopback, unspecified, unique-local (fc00::/7),
    // link-local (fe80::/10), and IPv4-mapped private addresses.
    if (host.startsWith('[')) {
      const v6 = host.slice(1, -1);
      const v4 = mappedIPv4(v6);
      if (v4) return !PRIVATE_IPV4.test(v4);
      return !(v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6));
    }
    // IPv4 private, loopback, link-local, CGNAT and unspecified ranges.
    return !PRIVATE_IPV4.test(host);
  } catch {
    return false;
  }
}

/** One row per relay: merge duplicate URLs (e.g. separate read and write
 * tags) by unioning their permissions, keeping first-seen order. */
export function mergeRelayRows(rows: RelayConfig[]): RelayConfig[] {
  const merged = new Map<string, RelayConfig>();
  for (const r of rows) {
    const url = norm(r.url);
    const prev = merged.get(url);
    merged.set(url, {
      url,
      read: (prev?.read ?? false) || r.read,
      write: (prev?.write ?? false) || r.write,
    });
  }
  return [...merged.values()];
}

/** NIP-65 relay rows from a kind-10002 event's `r` tags, one row per relay. */
export function relayListFromTags(tags: string[][]): RelayConfig[] {
  return mergeRelayRows(
    tags
      .filter((t) => t[0] === 'r' && t[1] && isRelayUrl(t[1]))
      .map((t) => ({
        url: t[1],
        read: !t[2] || t[2] === 'read',
        write: !t[2] || t[2] === 'write',
      })),
  );
}

/** NIP-65 kind 10002: `["r", url]` (read+write) / `["r", url, "read"|"write"]`. */
export function buildRelayListEvent(relays: RelayConfig[], now = Date.now()): UnsignedEvent {
  if (isTestRelayLockdown(getCurrentUserPubkey()))
    return {
      kind: 10002,
      created_at: Math.floor(now / 1000),
      tags: [['r', TEST_RELAY_URL]],
      content: '',
    };
  // Merge duplicate rows per URL (a list may carry separate read and write
  // tags for one relay) so neither permission is silently dropped.
  const merged = new Map<string, { read: boolean; write: boolean }>();
  for (const r of relays) {
    const url = norm(r.url);
    if (!isPublishableRelayUrl(url)) continue;
    const prev = merged.get(url) ?? { read: false, write: false };
    merged.set(url, { read: prev.read || r.read, write: prev.write || r.write });
  }
  const tags: string[][] = [];
  for (const [url, { read, write }] of merged) {
    if (!read && !write) continue;
    tags.push(read && write ? ['r', url] : ['r', url, read ? 'read' : 'write']);
  }
  return { kind: 10002, created_at: Math.floor(now / 1000), tags, content: '' };
}

/** NIP-17 kind 10050: the relays where the user receives DMs (`["relay", url]`). */
export function buildDmInboxEvent(urls: string[], now = Date.now()): UnsignedEvent {
  if (isTestRelayLockdown(getCurrentUserPubkey()))
    return {
      kind: 10050,
      created_at: Math.floor(now / 1000),
      tags: [['relay', TEST_RELAY_URL]],
      content: '',
    };
  const tags = [...new Set(urls.map(norm))]
    .filter(isPublishableRelayUrl)
    .map((url) => ['relay', url]);
  return { kind: 10050, created_at: Math.floor(now / 1000), tags, content: '' };
}

/** A well-formed ws(s) relay URL. Lists published by other clients may carry
 * junk (e.g. `wss://`), and one bad URL makes nostr-tools throw for the whole
 * subscription — so parsed lists keep only these. */
export function isRelayUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'wss:' || u.protocol === 'ws:') && u.hostname.length > 0;
  } catch {
    return false;
  }
}

/** Relay URLs from a kind-10050 event's `relay` tags. */
export function dmInboxRelaysFromTags(tags: string[][]): string[] {
  return tags
    .filter((t) => t[0] === 'relay' && t[1])
    .map((t) => norm(t[1]))
    .filter(isRelayUrl);
}

/**
 * Where to publish an updated list: everywhere the old list could be read
 * from (so it gets replaced there), the new list's relays, and the indexers.
 */
export function relayListPublishTargets(previous: string[], next: string[]): string[] {
  if (isTestRelayLockdown(getCurrentUserPubkey())) return [TEST_RELAY_URL];
  return [
    ...new Set(
      [...previous, ...next, ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS)].map(norm),
    ),
  ].filter(isPublishableRelayUrl);
}
