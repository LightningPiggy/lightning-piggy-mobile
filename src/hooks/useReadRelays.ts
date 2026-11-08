import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RelayConfig } from '../types/nostr';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { onCurrentUserPubkeyChange, setCurrentUserOwnRelays } from '../services/nostrActiveAccount';
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
  // The viewer's OWN relays: this read set plus their write relays (a
  // write-only relay carries their publishes) — never part of getReadRelays().
  const ownList = useMemo(
    () => [...new Set([...stable, ...relays.filter((r) => r.write).map((r) => r.url)])],
    [stable, relays],
  );
  const own = useStableByKey(ownList, relayListKey(ownList));
  // Republished after every account change too: the active-account module
  // clears hydration when the pubkey changes, and an incoming account whose
  // lists match must not be left looking unhydrated (switches reset these
  // lists BEFORE the pubkey changes, so a republish never carries stale state).
  const [accountEpoch, setAccountEpoch] = useState(0);
  useEffect(() => onCurrentUserPubkeyChange(() => setAccountEpoch((n) => n + 1)), []);
  // Published module-wide, so no outbox lease (feed or profile fallback, from
  // any caller) ever takes one of the viewer's own relays (#1390).
  useEffect(() => setCurrentUserOwnRelays(own, hydrated), [own, hydrated, accountEpoch]);
  // A copy per call, as before, so a caller can't mutate the shared list.
  return useCallback(() => [...stable], [stable]);
}
