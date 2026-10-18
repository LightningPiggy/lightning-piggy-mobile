import { useMemo } from 'react';
import type { RelayConfig } from '../types/nostr';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { mergeRelays } from '../services/nostrRelayStorage';
import { useAppRelayPrefs } from './useAppRelayPrefs';

/** Preference changes invalidate network plans, including non-default app groups. */
export function useAppNetworkRelays(
  pubkey: string | null,
  nip65: RelayConfig[],
  user: RelayConfig[],
) {
  const revision = useAppRelayPrefs();
  return useMemo(
    () =>
      mergeRelays({
        nip65,
        user,
        defaults: enabledAppRelays('default', DEFAULT_RELAYS, pubkey),
      }),
    // enabledAppRelays reads the external preference store synchronously.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pubkey, nip65, user, revision],
  );
}
