import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { MarketProduct } from '../data/marketProducts';
import { fetchMarketMerchantProfiles } from '../services/marketMerchantProfiles';
import type { CachedZapSenderProfile } from '../services/zapSenderProfileStorage';
import { curatedMerchant, merchantLabel } from '../utils/marketMerchants';

export function useMarketMerchantProfiles(products: MarketProduct[], enabled: boolean) {
  const [state, setState] = useState<{
    key: string;
    unresolved: ReadonlySet<string>;
    profiles: ReadonlyMap<string, CachedZapSenderProfile>;
  }>({ key: '', profiles: new Map(), unresolved: new Set() });
  const profiles = state.profiles;
  const authorsKey = useMemo(
    () =>
      [...new Set(products.flatMap((p) => (p.listing ? [p.listing.event.pubkey] : [])))]
        .sort()
        .join(','),
    [products],
  );
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !authorsKey) return;
      const controller = new AbortController();
      let unresolved: ReadonlySet<string> = new Set();
      void fetchMarketMerchantProfiles(authorsKey.split(','), controller.signal, (authors) => {
        unresolved = authors;
      })
        .then((resolved) => {
          if (!controller.signal.aborted)
            setState({ key: authorsKey, profiles: resolved, unresolved });
        })
        .catch(() => {});
      return () => controller.abort();
    }, [authorsKey, enabled]),
  );
  const resolvedProducts = useMemo(
    () =>
      products.map((product) => {
        if (!product.listing || !/^[a-f0-9]{64}$/.test(product.listing.event.pubkey))
          return product;
        const pk = product.listing.event.pubkey;
        const shop = curatedMerchant(pk);
        const profile = profiles.get(pk);
        const name = merchantLabel(pk, profile, shop?.name);
        return {
          ...product,
          sellerName: name,
          listing: {
            ...product.listing,
            vendor: {
              ...product.listing.vendor,
              ...shop,
              name,
              logo: shop?.logo || profile?.picture || product.listing.vendor.logo,
            },
          },
        };
      }),
    [products, profiles],
  );
  const profilesReady = !authorsKey || state.key === authorsKey;
  // Whether a seller has a kind-0 profile (cached or just fetched). Only
  // meaningful once `profilesReady` — the All scope's rule 3 keys off it.
  const hasProfile = useCallback((pubkey: string) => profiles.has(pubkey), [profiles]);
  const profileLookupFailed = useCallback(
    (pubkey: string) => state.key !== authorsKey || state.unresolved.has(pubkey),
    [state.key, state.unresolved, authorsKey],
  );
  return { products: resolvedProducts, profilesReady, hasProfile, profileLookupFailed };
}
