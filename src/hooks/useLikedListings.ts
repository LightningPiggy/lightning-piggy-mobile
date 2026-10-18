import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { fetchLikedListings } from '../services/marketLikesService';
import type { MarketProduct } from '../data/marketProducts';

const EMPTY: MarketProduct[] = [];

interface State {
  /** Whose likes `products` are — never shown for another account. */
  owner: string | null;
  products: MarketProduct[];
  loading: boolean;
  failed: boolean;
}

/**
 * The viewer's liked Market listings (#1541), fetched on screen focus and on
 * pull-to-refresh — one bounded fetch, no live subscription. Listings that
 * are gone (deleted, sold, expired) are left out by the service.
 */
export function useLikedListings() {
  const { pubkey, relays } = useNostr();
  const readRelays = useMemo(() => {
    const r = relays.filter((x) => x.read).map((x) => x.url);
    return r.length > 0 ? r : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [relays]);
  const [state, setState] = useState<State>({
    owner: null,
    products: [],
    loading: false,
    failed: false,
  });
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    controllerRef.current?.abort();
    if (!pubkey) {
      setState({ owner: null, products: [], loading: false, failed: false });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    // Keep the current list while refreshing, but only if it's this account's.
    setState((prev) =>
      prev.owner === pubkey
        ? { ...prev, loading: true, failed: false }
        : { owner: pubkey, products: [], loading: true, failed: false },
    );
    fetchLikedListings(pubkey, readRelays, controller.signal).then(
      (products) => {
        if (!controller.signal.aborted)
          setState({ owner: pubkey, products, loading: false, failed: false });
      },
      () => {
        if (!controller.signal.aborted)
          setState((prev) => ({ ...prev, loading: false, failed: true }));
      },
    );
  }, [pubkey, readRelays]);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => controllerRef.current?.abort();
    }, [load]),
  );
  const products = state.owner === pubkey ? state.products : EMPTY;
  return {
    products,
    loading: state.loading,
    failed: state.failed,
    signedIn: !!pubkey,
    refresh: load,
  };
}
