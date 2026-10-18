import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { Event } from 'nostr-tools';
import type { MarketProduct } from '../data/marketProducts';
import { useNostr } from '../contexts/NostrContext';
import { fetchMarketCollections } from '../services/marketCollectionsService';
import {
  collectionCoordinate,
  productsInCollection,
  visibleCollections,
} from '../utils/marketCollectionFilters';
/** Collections are local to one merchant; selections never enter remembered preferences. */
export function useCollectionFilter(
  products: MarketProduct[],
  enabled: boolean,
  merchant: string | null,
) {
  const { relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const relayKey = relays
    .filter((r) => r.read)
    .map((r) => r.url)
    .join(',');
  const scopedProducts = useMemo(
    () => (merchant ? products.filter((p) => p.listing?.event.pubkey === merchant) : []),
    [products, merchant],
  );
  const key = useMemo(
    () =>
      `${enabled}:${merchant}:${scopedProducts.map((p) => p.listing?.event.id ?? p.id).join(',')}`,
    [enabled, merchant, scopedProducts],
  );
  const [state, setState] = useState<{ key: string; events: Event[]; incomplete: boolean }>({
    key: '',
    events: [],
    incomplete: false,
  });
  const [selection, setSelection] = useState<{ key: string; coordinate: string | null }>({
    key: '',
    coordinate: null,
  });
  // Discard the old selection, even if the user later returns to the same scope.
  if (selection.key !== key) setSelection({ key, coordinate: null });
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !merchant || !scopedProducts.length) return;
      const controller = new AbortController();
      void fetchMarketCollections(scopedProducts, relayKey.split(','), controller.signal)
        .then(({ events, incomplete }) => {
          if (!controller.signal.aborted)
            setState({
              key,
              events: visibleCollections(events.filter((event) => event.pubkey === merchant)),
              incomplete,
            });
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setState((previous) => ({
              key,
              events: previous.key === key ? previous.events : [],
              incomplete: true,
            }));
        });
      return () => controller.abort();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- The service reads market app relays.
    }, [enabled, merchant, key, relayKey, scopedProducts, relayScope]),
  );
  const collections = enabled && merchant && state.key === key ? state.events : [];
  const selected = selection.key === key ? selection.coordinate : null;
  const collection = collections.find((e) => collectionCoordinate(e) === selected) ?? null;
  const filtered = useMemo(
    () => productsInCollection(products, collection),
    [products, collection],
  );
  const select = useCallback(
    (coordinate: string | null) => setSelection({ key, coordinate }),
    [key],
  );
  return {
    products: filtered,
    collections,
    selected: collection ? selected : null,
    select,
    incomplete: state.key === key && state.incomplete,
  };
}
