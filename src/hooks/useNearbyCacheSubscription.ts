import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useRef } from 'react';
import { subscribeNearbyCaches } from '../services/nostrPlacesPublisher';
import type { ParsedCache } from '../services/nostrPlacesService';
import { isHiddenInProd } from '../utils/exploreContentFilter';

/**
 * Owns MapScreen's nearby-caches relay subscription and lets the caller
 * re-key it as the viewport moves (#1065).
 *
 * Pre-#1065 the subscription was opened once at mount for the 9
 * precision-5 tiles around the user's GPS and never re-issued — panning
 * the map re-fetched BTC Map merchants but not caches, so Piglets
 * outside the user's home neighbourhood could never render (the report
 * was Johnnymoonshine's Danish/German/Polish Piglets being invisible
 * from Cambridge).
 *
 * `resubscribeForPrefixes` closes the previous subscription and opens a
 * new one when — and only when — the covering prefix set actually
 * changes: panning within the same tiles is a no-op, so relay backlogs
 * aren't replayed per pan (#31's freeze was exactly that replay).
 * Ingest applies the same test-account filter the inline path used and
 * feeds the caller's coalesced map (#824), and the filter carries a
 * `limit` so a coarse-precision viewport can't pull an unbounded event
 * set (CLAUDE.md relay-filter rule; NIP-40 expiry + WoT are applied at
 * render by useMapPins).
 */
const VIEWPORT_CACHE_LIMIT = 500;

export function useNearbyCacheSubscription(args: {
  enqueue: (key: string, cache: ParsedCache) => void;
  flush: () => void;
}): { resubscribeForPrefixes: (prefixes: string[]) => void } {
  const { enqueue, flush } = args;
  const relayScope = useAppRelayPrefs();
  const closerRef = useRef<(() => void) | null>(null);
  const focusedRef = useRef(false);
  const prefixesRef = useRef<string[]>([]);
  const keyRef = useRef<string | null>(null);

  const resubscribeForPrefixes = useCallback(
    (prefixes: string[]) => {
      prefixesRef.current = prefixes;
      if (!focusedRef.current || prefixes.length === 0) return;
      const key = `${relayScope}:${[...prefixes].sort().join(',')}`;
      if (key === keyRef.current) return;
      keyRef.current = key;
      closerRef.current?.();
      closerRef.current = subscribeNearbyCaches(
        prefixes,
        (cache) => {
          // Hide the project's own test-account ("Piggy") Piglets on the
          // map in the production app; dev/preview keep them for Maestro.
          if (!focusedRef.current || keyRef.current !== key || isHiddenInProd(cache.hiderPubkey))
            return;
          enqueue(cache.coord, cache);
        },
        undefined,
        { limit: VIEWPORT_CACHE_LIMIT },
      );
    },
    [enqueue, relayScope],
  );

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      resubscribeForPrefixes(prefixesRef.current);
      return () => {
        focusedRef.current = false;
        closerRef.current?.();
        closerRef.current = null;
        keyRef.current = null;
        flush();
      };
    }, [flush, resubscribeForPrefixes]),
  );

  return { resubscribeForPrefixes };
}
