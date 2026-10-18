import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { fetchMarketListings } from '../services/marketListingsService';
import type { MarketProduct } from '../data/marketProducts';

interface State {
  key: string;
  products: MarketProduct[];
  incomplete: boolean;
  loading: boolean;
}

/**
 * One seller's live Market listings (NIP-99 kind 30402) for the profile's
 * Shop tab — the Market's own snapshot (`fetchMarketListings`), scoped to
 * a single author, so signatures and the seller's deletions are verified
 * exactly as on the Market screen. Fetched lazily: only once the tab is
 * opened (`enabled`), only while the screen is focused, and once per
 * seller / relay set / refresh. Blurring aborts an in-flight snapshot.
 */
export function useSellerProducts(
  pubkey: string | null,
  enabled: boolean,
  reloadNonce: number,
  sellerName: string,
) {
  const { relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const relaysKey = useMemo(
    () =>
      relays
        .filter((r) => r.read)
        .map((r) => r.url)
        .sort()
        .join(','),
    [relays],
  );
  const key = `${pubkey ?? ''}|${relaysKey}|${reloadNonce}|${relayScope}`;
  const [state, setState] = useState<State>({
    key: '',
    products: [],
    incomplete: false,
    loading: false,
  });
  // The key the last COMPLETE snapshot answered; it includes the seller, so
  // a different profile always refetches.
  const doneKey = useRef<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      if (!enabled || !pubkey || !relaysKey || doneKey.current === key) return;
      const controller = new AbortController();
      setState((prev) =>
        prev.key.split('|')[0] === pubkey
          ? { ...prev, key, loading: true }
          : { key, products: [], incomplete: false, loading: true },
      );
      void fetchMarketListings([pubkey], relaysKey.split(','), controller.signal, (first) => {
        if (controller.signal.aborted) return;
        setState((prev) =>
          prev.products.length >= first.length ? prev : { ...prev, products: first },
        );
      }).then((result) => {
        if (controller.signal.aborted) return;
        // Only a complete snapshot is final; a partial one refetches on the
        // next focus (or pull-to-refresh).
        doneKey.current = result.incomplete ? null : key;
        setState({ key, ...result, loading: false });
      });
      return () => controller.abort();
    }, [enabled, pubkey, relaysKey, key]),
  );

  // The card shows the seller's name as the profile page knows it.
  const products = useMemo(
    () =>
      state.key.split('|')[0] === pubkey
        ? state.products.map((p) => (p.sellerName === sellerName ? p : { ...p, sellerName }))
        : [],
    [state, pubkey, sellerName],
  );

  return {
    products,
    // No read relays → nothing will ever be fetched: show the empty state,
    // not a spinner that never ends.
    loading: enabled && !!pubkey && !!relaysKey && (state.key !== key || state.loading),
    incomplete: state.key === key && state.incomplete,
  };
}
