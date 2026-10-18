import { enabledAppRelays } from './appRelayPrefs';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';

export const DM_INBOX_LIMIT = 1000;
export const KIND4_REPLAY_OVERLAP_SECONDS = 120;

/** Two kind-4 filters, each limited independently on every queried relay.
 * Sized for at least one relay: before the App Relays prefs load (cold
 * start), the enabled defaults are empty, and a zero capacity made the
 * kind-4 retry store throw during the first render. */
export function kind4FetchCapacity(relays: string[] = [], limit = DM_INBOX_LIMIT) {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid DM fetch limit');
  const relayCount = new Set([...relays, ...enabledAppRelays('default', DEFAULT_RELAYS)]).size;
  return 2 * limit * Math.max(1, relayCount);
}
