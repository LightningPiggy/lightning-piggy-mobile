import { useMemo } from 'react';
import type { RelayConfig } from '../types/nostr';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { mergeRelays } from '../services/nostrRelayStorage';
import { relayConfigSequenceKey } from '../utils/relayListKey';
import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useStableByKey } from './useStableRelayList';

/** Preference changes invalidate network plans, including non-default app groups.
 * Otherwise the returned array keeps its identity while its entries are
 * unchanged, so a re-parsed but identical NIP-65 list doesn't re-arm relay
 * subscriptions. */
export function useAppNetworkRelays(
  pubkey: string | null,
  nip65: RelayConfig[],
  user: RelayConfig[],
) {
  const revision = useAppRelayPrefs();
  const merged = useMemo(
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
  const key = useMemo(() => `${revision}\n${relayConfigSequenceKey(merged)}`, [merged, revision]);
  return useStableByKey(merged, key);
}
