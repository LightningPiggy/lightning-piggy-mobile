import { useCallback, type Dispatch, type SetStateAction } from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NostrProfile } from '../types/nostr';
import * as nostrService from '../services/nostrService';
import { perAccountKey } from '../services/perAccountStorage';
import {
  OWN_PROFILE_CACHE_KEY_BASE,
  OWN_PROFILE_TIMESTAMP_KEY_BASE,
  CACHE_MAX_AGE_MS,
  readCachedWithTtl,
} from './nostrCacheKeys';

/**
 * Shallow field-equality for own-profile updates. Every `loadProfile` /
 * `loadProfileFromCache` call builds a *fresh* object (JSON.parse / relay
 * fetch), and Home/Friends call `refreshProfile()` on every tab focus — so
 * without this guard each focus minted a new `profile` identity, rebuilt the
 * main context value, and re-rendered every `useNostr()` consumer even when
 * nothing changed. Profile fields are all primitives, so shallow compare is
 * exact.
 */
const sameProfile = (a: NostrProfile | null, b: NostrProfile): boolean => {
  if (!a) return false;
  const ka = Object.keys(a) as (keyof NostrProfile)[];
  const kb = Object.keys(b) as (keyof NostrProfile)[];
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
};

/** Own-profile hydration and refresh always write on behalf of the requested account. */
export function useOwnProfile(
  profileSetterFor: (owner: string) => Dispatch<SetStateAction<NostrProfile | null>>,
) {
  const loadProfile = useCallback(
    async (pk: string, relayUrls: string[], opts?: { force?: boolean }) => {
      const setProfile = profileSetterFor(pk);
      const t0 = Date.now();
      // Cache-fresh fast path: hydrate UI from cache and skip the relay RTT.
      // `force` bypasses it for user-initiated refreshes.
      const { value: cached, ageMs } = await readCachedWithTtl<NostrProfile>(
        perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, pk),
        perAccountKey(OWN_PROFILE_TIMESTAMP_KEY_BASE, pk),
      );
      if (!opts?.force && cached && ageMs < CACHE_MAX_AGE_MS) {
        setProfile((prev) => (sameProfile(prev, cached) ? prev : cached));
        if (__DEV__) console.log(`[Nostr] fetchProfile: skipped (cache fresh)`);
        return;
      }
      // A switched account may have no live profile yet. Keep its saved
      // display name visible while refreshing stale metadata, including when
      // the current relays no longer carry its kind-0. Never replace newer
      // in-memory state with this stale seed.
      if (cached) setProfile((prev) => prev ?? cached);
      const fetchedProfile = await nostrService.fetchProfile(pk, relayUrls);
      if (__DEV__) console.log(`[Nostr] fetchProfile: ${Date.now() - t0}ms`);
      if (fetchedProfile) {
        setProfile((prev) => (sameProfile(prev, fetchedProfile) ? prev : fetchedProfile));
        InteractionManager.runAfterInteractions(() => {
          AsyncStorage.setItem(
            perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, pk),
            JSON.stringify(fetchedProfile),
          ).catch(() => {});
          AsyncStorage.setItem(
            perAccountKey(OWN_PROFILE_TIMESTAMP_KEY_BASE, pk),
            Date.now().toString(),
          ).catch(() => {});
        });
      }
    },
    [profileSetterFor],
  );

  /** Eagerly hydrate own `profile` state from the per-account cache so
   * the drawer header + tab profile avatar paint on cold start without
   * waiting for the deferred `loadProfile` relay round-trip. Matches the
   * pattern of `loadContactsFromCache`. The cache-fresh setProfile-from-
   * cache was previously only happening inside the deferred `loadProfile`
   * fast path, which meant a fresh cold-start with grace-window deferral
   * left `profile` null for ~1.5 s. */
  const loadProfileFromCache = useCallback(
    async (pk: string) => {
      const setProfile = profileSetterFor(pk);
      try {
        const raw = await AsyncStorage.getItem(perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, pk));
        if (!raw) return false;
        const cached = JSON.parse(raw) as NostrProfile;
        setProfile((prev) => (sameProfile(prev, cached) ? prev : cached));
        return true;
      } catch (error) {
        console.warn('Failed to load profile cache:', error);
        return false;
      }
    },
    [profileSetterFor],
  );

  return { loadProfile, loadProfileFromCache };
}
