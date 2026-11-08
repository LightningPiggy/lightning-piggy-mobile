import { normalizeURL } from 'nostr-tools/utils';
import type { RelayConfig } from '../types/nostr';

/**
 * Content keys for relay lists, so relay subscriptions re-arm only when the
 * relays actually change (not every time a list is re-parsed into a new
 * array with the same entries).
 *
 * Two shapes:
 *  - set keys (`relayListKey`, `relayConfigListKey`): normalised, deduped and
 *    sorted. Use them for subscription plans, where order doesn't matter.
 *  - `sameRelayUrls` / `sameRelayConfigs`: exact, ordered equality. Use them
 *    to skip a state update, so a list shown in the UI keeps its order.
 */

// Never part of a normalised URL, so keys can't collide across entries.
const SEPARATOR = '\n';

/** Normalise like the relay pool does, so `wss://X/` and `wss://x` match.
 * An unparsable URL falls back to its trimmed text instead of throwing. */
export function normalizeRelayUrl(url: string): string {
  try {
    return normalizeURL(url);
  } catch {
    return url.trim();
  }
}

/** Order-insensitive key of a relay URL list. */
export function relayListKey(urls: readonly string[]): string {
  return [...new Set(urls.map(normalizeRelayUrl))].sort().join(SEPARATOR);
}

const configEntry = (r: RelayConfig, url: string): string =>
  `${url} ${r.read ? 'r' : '-'}${r.write ? 'w' : '-'}`;

/** Order-insensitive key of a relay config list, read/write flags included. */
export function relayConfigListKey(list: readonly RelayConfig[]): string {
  return [...new Set(list.map((r) => configEntry(r, normalizeRelayUrl(r.url))))]
    .sort()
    .join(SEPARATOR);
}

/** Exact, ordered key of a relay config list (URLs as given). */
export function relayConfigSequenceKey(list: readonly RelayConfig[]): string {
  return list.map((r) => configEntry(r, r.url)).join(SEPARATOR);
}

/** True when both URL lists hold the same entries in the same order. */
export function sameRelayUrls(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((url, i) => url === b[i]);
}

/** True when both config lists hold the same entries in the same order. */
export function sameRelayConfigs(a: readonly RelayConfig[], b: readonly RelayConfig[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => r.url === b[i].url && r.read === b[i].read && r.write === b[i].write)
  );
}
