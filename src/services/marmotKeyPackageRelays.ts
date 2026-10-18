import { enabledAppRelays } from './appRelayPrefs';
// MIP-00 kind-10051 discovery and bounded key-package relay selection.
import type { EventTemplate } from 'nostr-tools';

import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { isPublicRelayUrl } from '../utils/publicUrl';

export const MARMOT_KEY_PACKAGE_RELAYS = [
  'wss://relay.eu.whitenoise.chat',
  'wss://relay.us.whitenoise.chat',
  'wss://relay.primal.net',
];
export const MAX_KEY_PACKAGE_RELAYS = 12;

/** Public, credential-free URLs, canonicalised and capped before opening sockets. */
export function cleanKeyPackageRelays(urls: readonly string[], max = MAX_KEY_PACKAGE_RELAYS) {
  const out: string[] = [];
  for (const value of urls) {
    const url = value.trim().replace(/\/+$/, '');
    if (!isPublicRelayUrl(url)) continue;
    const canonical = new URL(url).href.replace(/\/+$/, '');
    if (!out.includes(canonical)) out.push(canonical);
    if (out.length === max) break;
  }
  return out;
}

/** Reserve room for all three discovery relays even with a huge account list. */
export function keyPackagePublishRelays(owner: string, own: string[]): string[] {
  if (isTestRelayLockdown(owner)) return [TEST_RELAY_URL];
  return cleanKeyPackageRelays([
    ...cleanKeyPackageRelays(
      own,
      MAX_KEY_PACKAGE_RELAYS - enabledAppRelays('marmot', MARMOT_KEY_PACKAGE_RELAYS, owner).length,
    ),
    ...enabledAppRelays('marmot', MARMOT_KEY_PACKAGE_RELAYS, owner),
  ]);
}

export function parseKeyPackageRelayList(tags: string[][]): string[] {
  return cleanKeyPackageRelays(tags.filter((t) => t[0] === 'relay' && t[1]).map((t) => t[1]));
}

export function buildKeyPackageRelayList(
  owner: string,
  relays: string[],
  nowSecs = Math.floor(Date.now() / 1000),
): EventTemplate {
  const targets = isTestRelayLockdown(owner) ? [TEST_RELAY_URL] : cleanKeyPackageRelays(relays);
  return { kind: 10051, created_at: nowSecs, tags: targets.map((r) => ['relay', r]), content: '' };
}

/** History can exceed selection size; visit it in sequential, bounded batches. */
export async function visitKeyPackageRelays<T>(
  relays: string[],
  visit: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const results: T[] = [];
  for (let offset = 0; offset < relays.length; offset += MAX_KEY_PACKAGE_RELAYS) {
    results.push(...(await visit(relays.slice(offset, offset + MAX_KEY_PACKAGE_RELAYS))));
  }
  return results;
}
