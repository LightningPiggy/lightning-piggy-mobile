import { useCallback, useEffect, useMemo } from 'react';
import type { RelayConfig } from '../types/nostr';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { setCurrentUserOwnRelays } from '../services/nostrActiveAccount';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { relayListKey } from '../utils/relayListKey';
import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useStableByKey } from './useStableRelayList';

/**
 * NostrContext's `getReadRelays`: the user's read relays (app defaults when
 * none), plus their own DM inbox relays, where others deliver NIP-17 DMs.
 * The getter's identity changes only when that set of relays changes, so the
 * live DM sub, cache notifications and `refreshDmInbox` (and the Messages
 * focus effect keyed on it) don't re-run for a re-parsed, identical list.
 *
 * `hydrated`: the lists are this identity's own (loaded), not the defaults
 * used before then — published with the set, so outbox leasing waits for it.
 */
export function useReadRelays(
  relays: RelayConfig[],
  dmInboxRelays: string[],
  hydrated = false,
): () => string[] {
  // The default fallback reads the app-relay preference store.
  const prefsRevision = useAppRelayPrefs();
  const list = useMemo(() => {
    const readRelays = relays.filter((r) => r.read).map((r) => r.url);
    const base = readRelays.length > 0 ? readRelays : enabledAppRelays('default', DEFAULT_RELAYS);
    return [...new Set([...base, ...dmInboxRelays])];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relays, dmInboxRelays, prefsRevision]);
  const key = useMemo(() => relayListKey(list), [list]);
  const stable = useStableByKey(list, key);
  // Published module-wide, so no outbox lease (feed or profile fallback, from
  // any caller) ever takes one of the viewer's own relays (#1390).
  useEffect(() => setCurrentUserOwnRelays(stable, hydrated), [stable, hydrated]);
  // A copy per call, as before, so a caller can't mutate the shared list.
  return useCallback(() => [...stable], [stable]);
}
