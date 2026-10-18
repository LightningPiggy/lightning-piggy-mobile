import { useEffect } from 'react';
import { useAppRelayPrefs } from './useAppRelayPrefs';
import { fetchCache } from '../services/nostrPlacesPublisher';
import { loadCachedCaches } from '../services/nostrPlacesStorage';
import { parseCacheCoord, type ParsedCache } from '../services/nostrPlacesService';

/** Paint a deep-linked cache from disk, then refresh after relay hydration or edits. */
export function useCacheDetailHydration(
  coord: string,
  cache: ParsedCache | null,
  setCache: (cache: ParsedCache) => void,
  setLoading: (loading: boolean) => void,
  setError: (error: string | null) => void,
) {
  const relayScope = useAppRelayPrefs();
  useEffect(() => {
    let cancelled = false;
    const parts = parseCacheCoord(coord);
    if (!parts) {
      setError('Invalid cache coordinate.');
      setLoading(false);
      return;
    }
    (async () => {
      // Paint from disk first (cold deep-link path) to hide relay latency.
      if (!cache) {
        try {
          const onDisk = await loadCachedCaches();
          if (cancelled) return;
          const local = onDisk.find((c) => c.coord === coord);
          if (local) {
            setCache(local);
            setLoading(false);
          }
        } catch {
          // AsyncStorage hiccups are non-fatal — fall through to relays.
        }
      }
      try {
        const c = await fetchCache(parts.pubkey, parts.d);
        if (cancelled) return;
        if (!c) {
          // Only error when there's no cached snapshot to fall back on.
          if (!cache) setError('Cache not found on relays — it may have expired.');
        } else {
          setCache(c);
          setError(null);
        }
      } catch (e) {
        if (!cancelled && !cache) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Capture the listing snapshot for this coordinate; setCache must not restart the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coord, relayScope, setCache, setLoading, setError]);
}
