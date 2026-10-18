import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import type { Event } from 'nostr-tools';
import {
  loadedMarketSnapshots,
  readLoadedMarketSnapshots,
  subscribeMarketSnapshots,
  unexpiredMarketProducts,
} from '../services/marketStorage';
import { PREFERRED_SELLERS_ACCOUNT } from '../services/marketPreferredSellers';
import { hasOwnCuratedMarketListings, hasOwnMarketListings } from '../utils/marketShortcutCounts';

/** Reuse verified local catalogues, including listings visible before the seller hub loads. */
export function useKnownOwnListings(pubkey: string | null, sellerListings: readonly Event[]) {
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeMarketSnapshots(() => setRevision((value) => value + 1)), []);
  useFocusEffect(
    useCallback(() => {
      if (pubkey) {
        void readLoadedMarketSnapshots(pubkey);
        void readLoadedMarketSnapshots(PREFERRED_SELLERS_ACCOUNT);
      }
    }, [pubkey]),
  );
  return useMemo(
    () =>
      hasOwnCuratedMarketListings(pubkey) ||
      hasOwnMarketListings(pubkey, [
        ...sellerListings,
        ...loadedMarketSnapshots(pubkey ? [pubkey, PREFERRED_SELLERS_ACCOUNT] : []).flatMap(
          ({ products }) =>
            unexpiredMarketProducts(products).flatMap((product) =>
              product.listing ? [product.listing.event] : [],
            ),
        ),
      ]),
    // revision signals a local catalogue change, including account wipes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pubkey, sellerListings, revision],
  );
}
