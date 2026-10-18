import { enabledAppRelays } from './appRelayPrefs';
import { DEFAULT_RELAYS } from './nostrService';
import { getCurrentUserReadRelays } from './nostrActiveAccount';

/** App fallbacks plus explicitly configured read relays, without duplicates. */
export const appReadRelays = (): string[] => [
  ...new Set([...enabledAppRelays('default', DEFAULT_RELAYS), ...getCurrentUserReadRelays()]),
];
