import { useCallback } from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as nip19 from 'nostr-tools/nip19';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import { ownEventPublishTargets } from '../services/ownEventPublishTargets';
import { perAccountKey } from '../services/perAccountStorage';
import type { NostrProfile, RelayConfig, SignerType } from '../types/nostr';
import { NSEC_KEY } from './nostrAuthKeys';
import { OWN_PROFILE_CACHE_KEY_BASE, OWN_PROFILE_TIMESTAMP_KEY_BASE } from './nostrCacheKeys';
import { nip46Sign } from './nip46DmDecrypt';
import { assertSigningKey } from '../utils/sellerSigning';

export interface ProfileFields {
  name?: string;
  display_name?: string;
  picture?: string;
  banner?: string;
  about?: string;
  lud16?: string;
  nip05?: string;
}

/**
 * Sign and publish the user's own profile (kind 0) — to their write relays
 * and the profile indexers — then adopt it locally. Extracted from
 * NostrContext (file-size cap).
 */
export function usePublishProfile({
  pubkey,
  isLoggedIn,
  signerType,
  relays,
  setProfile,
}: {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: SignerType | null;
  relays: RelayConfig[];
  setProfile: (profile: NostrProfile | null) => void;
}) {
  return useCallback(
    async (profileData: ProfileFields): Promise<boolean> => {
      if (!pubkey || !isLoggedIn) return false;
      try {
        const event = nostrService.createProfileEvent(profileData);
        const targetRelays = await ownEventPublishTargets(pubkey, relays, 0);

        if (signerType === 'nsec') {
          const nsec = await SecureStore.getItemAsync(NSEC_KEY);
          if (!nsec) return false;
          const { secretKey } = nostrService.decodeNsec(nsec);
          // The key must still be this account's (an account switch during the
          // target lookup would otherwise sign A's edits with B's key).
          assertSigningKey(secretKey, pubkey);
          await nostrService.signAndPublishEvent(event, secretKey, targetRelays);
        } else if (signerType === 'amber') {
          const eventJson = JSON.stringify(event);
          const { event: signedEventJson } = await amberService.requestEventSignature(
            eventJson,
            '',
            pubkey,
          );
          if (!signedEventJson) return false;
          const signed = JSON.parse(signedEventJson);
          if (signed.pubkey !== pubkey) return false;
          await nostrService.publishSignedEvent(signed, targetRelays);
        } else if (signerType === 'nip46') {
          const signedEventJson = await nip46Sign(event, pubkey);
          if (!signedEventJson) return false;
          const signed = JSON.parse(signedEventJson);
          if (signed.pubkey !== pubkey) return false;
          await nostrService.publishSignedEvent(signed, targetRelays);
        } else {
          // No usable signer: nothing was published, so don't adopt or cache it.
          return false;
        }

        // We just signed and published this kind-0, so the client already
        // has the authoritative new profile. Shortcut the relay round-trip
        // by updating local state + the 24h own-profile cache in-place,
        // otherwise the top-right profile icon keeps the pre-publish
        // avatar/name until the next force-refresh (up to 24h — see #148).
        //
        // Apply the same "drop falsy values" rule createProfileEvent uses
        // so local state matches exactly what was published — a caller
        // passing `name: ""` otherwise leaves the cache with an empty string
        // while the kind-0 on the wire omits the field entirely.
        const nullIfEmpty = (v: string | undefined): string | null => (v ? v : null);
        const updatedProfile: NostrProfile = {
          pubkey,
          npub: nip19.npubEncode(pubkey),
          name: nullIfEmpty(profileData.name),
          displayName: nullIfEmpty(profileData.display_name),
          picture: nullIfEmpty(profileData.picture),
          banner: nullIfEmpty(profileData.banner),
          about: nullIfEmpty(profileData.about),
          lud16: nullIfEmpty(profileData.lud16),
          nip05: nullIfEmpty(profileData.nip05),
        };
        setProfile(updatedProfile);
        InteractionManager.runAfterInteractions(() => {
          AsyncStorage.setItem(
            perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, pubkey),
            JSON.stringify(updatedProfile),
          ).catch(() => {});
          AsyncStorage.setItem(
            perAccountKey(OWN_PROFILE_TIMESTAMP_KEY_BASE, pubkey),
            Date.now().toString(),
          ).catch(() => {});
        });

        return true;
      } catch (error) {
        console.warn('Failed to publish profile:', error);
        return false;
      }
    },
    [setProfile, pubkey, isLoggedIn, signerType, relays],
  );
}
