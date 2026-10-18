import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { fetchCachesByAuthor } from '../services/nostrPlacesPublisher';
import type { ParsedCache } from '../services/nostrPlacesService';

/** Refresh owned Piglets on each map visit, even after an edit moves them
 * outside the nearby subscription. Relay array identity must not cancel an
 * in-flight fetch: Nostr hydration often replaces it with identical URLs. */
export function useMapAuthorCaches(args: {
  pubkey: string | null;
  relays: readonly { read: boolean; url: string }[];
  enqueue: (key: string, cache: ParsedCache) => void;
  flush: () => void;
}): void {
  const { pubkey, relays, enqueue, flush } = args;
  const relayScope = useAppRelayPrefs();
  const relayKey = JSON.stringify(
    [...new Set(relays.filter((r) => r.read).map((r) => r.url))].sort(),
  );

  useFocusEffect(
    useCallback(() => {
      if (!pubkey) return;
      let cancelled = false;
      const readRelays: string[] = JSON.parse(relayKey);
      void fetchCachesByAuthor(pubkey, readRelays.length > 0 ? readRelays : undefined)
        .then((mine) => {
          if (cancelled || mine.length === 0) return;
          for (const cache of mine) enqueue(cache.coord, cache);
          flush();
        })
        .catch(() => {
          // Best-effort: keep the existing pins if relays are unavailable.
        });
      return () => {
        cancelled = true;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- App relay defaults are read inside the service.
    }, [pubkey, relayKey, relayScope, enqueue, flush]),
  );
}
