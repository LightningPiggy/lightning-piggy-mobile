import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { enabledAppRelays } from './appRelayPrefs';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import { relayAllowsKind } from './relayKindPolicy';
import type { RelayConfig } from '../types/nostr';

/**
 * Where the user's own profile (kind 0) and follow list (kind 3) go: their
 * write relays (app defaults when they have none), plus the relay-list
 * indexers other clients look these up on, where the indexer stores the
 * kind. Test accounts in lockdown publish to the LAN test relay only (and
 * never ask a public indexer anything).
 */
export async function ownEventPublishTargets(
  pubkey: string,
  relays: RelayConfig[],
  kind: number,
): Promise<string[]> {
  if (isTestRelayLockdown(pubkey)) return [TEST_RELAY_URL];
  const write = relays.filter((r) => r.write).map((r) => r.url);
  const base = write.length > 0 ? write : enabledAppRelays('default', DEFAULT_RELAYS);
  const indexers = enabledAppRelays('indexers', RELAY_LIST_INDEXERS);
  const allowed = await Promise.all(indexers.map((url) => relayAllowsKind(url, kind)));
  return [...new Set([...base, ...indexers.filter((_, i) => allowed[i])])];
}
