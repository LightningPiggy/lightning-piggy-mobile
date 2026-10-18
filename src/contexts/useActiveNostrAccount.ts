import { loadAppRelayPrefs } from '../services/appRelayPrefs';
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { reviveBuyerOrderTitles } from '../services/buyerOrderTitles';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { setActivePubkeyForWalletStorage } from '../services/walletStorageService';

/** Own active identity and its synchronous DEV relay-routing mirror. */
export function useActiveNostrAccount(onRelayPrefsRecovered?: (pk: string) => Promise<unknown>) {
  const [pubkey, setPubkeyState] = useState<string | null>(null);
  const setPubkey = useCallback((pk: string | null) => {
    if (pk) {
      reviveBuyerOrderTitles(pk);
      void loadAppRelayPrefs(pk).catch(() => {
        /* App defaults stay disabled if preferences cannot be read. */
      });
    }
    if (__DEV__) setCurrentUserPubkey(pk);
    setPubkeyState(pk);
  }, []);
  // Retry while this identity is active even if no consumer reads relay defaults
  // again. Account changes and unmount cancel queued retries.
  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    let failed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const hydrate = () => {
      void loadAppRelayPrefs(pubkey)
        .then(() => {
          // Startup discovery may have run with defaults closed on the failed read.
          if (!cancelled && failed)
            void onRelayPrefsRecovered?.(pubkey).catch((error) => {
              console.warn('[Nostr] relay discovery after preference recovery failed:', error);
            });
        })
        .catch(() => {
          failed = true;
          if (!cancelled) retry = setTimeout(hydrate, 3000);
        });
    };
    hydrate();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [pubkey, onRelayPrefsRecovered]);
  // Release builds retain the existing before-paint publication timing.
  useLayoutEffect(() => {
    setCurrentUserPubkey(pubkey);
    setActivePubkeyForWalletStorage(pubkey);
  }, [pubkey]);
  return [pubkey, setPubkey] as const;
}
