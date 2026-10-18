import { useAppRelayPrefs } from './useAppRelayPrefs';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { cachedContactProfile } from '../utils/cachedContactProfile';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import {
  peekMentionProfile,
  subscribeMentionProfile,
  type MentionProfile,
} from '../services/nostrMentionProfiles';

/** Display-only lookup, shared across all mentions on focused screens. */
export function useMentionProfile(
  pubkey: string,
  memberProfile: MentionProfile | null = null,
  allowRelayLookup = true,
) {
  const { relays, pubkey: selfPubkey, profile: ownProfile } = useNostr();
  const { contacts } = useNostrContacts();
  const relayScope = useAppRelayPrefs();
  const own = pubkey.toLowerCase() === selfPubkey?.toLowerCase() ? ownProfile : null;
  const contact = cachedContactProfile(contacts, pubkey);
  const name =
    own?.displayName?.trim() ||
    own?.name?.trim() ||
    contact?.displayName?.trim() ||
    contact?.name?.trim() ||
    memberProfile?.name?.trim() ||
    null;
  const picture = own?.picture ?? contact?.picture ?? memberProfile?.picture ?? null;
  const knownProfile = name ? { name, picture } : null;
  const retryKey = [
    ...new Set([
      ...relays
        .filter((r) => r.write)
        .map((r) => r.url)
        .slice(0, 4),
      ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS),
    ]),
  ]
    .sort()
    .join('|');
  const relayKey = relays
    .filter((r) => r.read)
    .map((r) => r.url)
    .sort()
    .join('|');
  const [state, setState] = useState(() => ({ pubkey, profile: peekMentionProfile(pubkey) }));
  useFocusEffect(
    useCallback(() => {
      if (name) return;
      setState({ pubkey, profile: peekMentionProfile(pubkey) });
      return subscribeMentionProfile(
        pubkey,
        relayKey ? relayKey.split('|') : enabledAppRelays('default', DEFAULT_RELAYS),
        (profile) => setState({ pubkey, profile }),
        retryKey ? retryKey.split('|') : [],
        selfPubkey,
        allowRelayLookup,
      );
      // eslint-disable-next-line react-hooks/exhaustive-deps -- App relay defaults are read inside the service.
    }, [pubkey, relayKey, retryKey, name, selfPubkey, allowRelayLookup, relayScope]),
  );
  if (knownProfile) return knownProfile;
  return state.pubkey === pubkey ? state.profile : peekMentionProfile(pubkey);
}
