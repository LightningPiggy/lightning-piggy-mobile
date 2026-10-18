import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { Toast } from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { MARKET_PRODUCTS, PIG_TEST_PRODUCTS } from '../data/marketProducts';
import {
  fetchPreferredSellers,
  getPreferredSellers,
  PREFERRED_SELLERS_ACCOUNT,
} from '../services/marketPreferredSellers';
import { samplePreferredProducts } from '../utils/marketSample';
import { preferredMarketScope } from '../utils/preferredMarketScope';
import { useMarketListings } from './useMarketListings';

export function usePreferredMarketListings(enabled = true) {
  const { relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const t = useTranslation();
  const [authors, setAuthors] = useState<readonly string[] | undefined>(
    () => getPreferredSellers()?.authors,
  );
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const relaysKey = relays
    .filter((relay) => relay.read)
    .map((relay) => relay.url)
    .sort()
    .join(',');
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return;
      // Explicit refresh also invalidates a fresh kind-3 cache.
      const controller = new AbortController();
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let dismissToast: (() => void) | undefined;
      const load = (retry = false) =>
        fetchPreferredSellers(
          relaysKey.split(','),
          controller.signal,
          (cached) => {
            if (!controller.signal.aborted) setAuthors(cached);
          },
          retry || revision > 0,
        )
          .then((next) => {
            if (!controller.signal.aborted) {
              setAuthors(next);
              setFailed(false);
            }
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            setFailed(true);
            if (!retry) retryTimer = setTimeout(() => void load(true), 1500);
            else
              dismissToast = Toast.showOwned({
                type: 'info',
                text1: t('market.live.partialToast'),
                autoHide: true,
                visibilityTime: 3500,
              });
          });
      void load();
      return () => {
        controller.abort();
        if (retryTimer) clearTimeout(retryTimer);
        dismissToast?.();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- App relay defaults are read inside the service.
    }, [enabled, relaysKey, revision, relayScope, t]),
  );
  const scope = useMemo(
    () => ({ account: PREFERRED_SELLERS_ACCOUNT, authors: preferredMarketScope(authors ?? []) }),
    [authors],
  );
  const live = useMarketListings(enabled && (authors !== undefined || failed), scope);
  const refreshListings = live.refresh;
  const refresh = useCallback(() => {
    setRevision((value) => value + 1);
    refreshListings();
  }, [refreshListings]);
  // Dev builds keep the 21-sat pig test items (#948) next to the live
  // catalogue, so the in-app checkout can be exercised end to end; release
  // builds have none (PIG_TEST_PRODUCTS is empty outside __DEV__).
  const products = useMemo(
    () => (live.hasSnapshot ? [...PIG_TEST_PRODUCTS, ...live.products] : MARKET_PRODUCTS),
    [live.hasSnapshot, live.products],
  );
  return {
    ...live,
    refresh,
    incomplete: failed || live.incomplete,
    loading: enabled && !failed && (authors === undefined || live.loading),
    products,
  };
}

const PIG_TEST_IDS = new Set(PIG_TEST_PRODUCTS.map((product) => product.id));

export function usePreferredMarketSample() {
  const { products } = usePreferredMarketListings();
  // The dev-only pig test items belong in the Market grid, not the Explore rail.
  return useMemo(
    () => samplePreferredProducts(products.filter((product) => !PIG_TEST_IDS.has(product.id))),
    [products],
  );
}
