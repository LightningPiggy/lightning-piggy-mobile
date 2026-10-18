import { useMemo } from 'react';
import { useNostr } from '../contexts/NostrContext';
import type { MarketMode } from '../utils/marketMode';
import { useMarketListings, type MarketListingsScope } from './useMarketListings';
import { usePreferredMarketListings } from './usePreferredMarketListings';
import { useMarketFofAuthors } from './useMarketFofAuthors';

/**
 * The Market's listings for the active seller scope. Each scope owns one
 * listings hook, armed only while it is the active scope (the others stay
 * idle — no relay work, no state churn), so flipping back to a scope reuses
 * its fresh snapshot.
 *
 *   preferred   — curated Lightning Piggy sellers (`usePreferredMarketListings`)
 *   wotFriends  — the viewer's follows
 *   wotFof      — follows + follows-of-follows (`useMarketFofAuthors`)
 *   wotAll      — anyone, spam-curated (`fetchOpenMarketListings`)
 *
 * `mode` must already be the EFFECTIVE mode (experimental scopes clamped by
 * `effectiveMarketMode`), so a locked scope never queries.
 */
export function useMarketScopeListings(mode: MarketMode, ready: boolean) {
  const { pubkey } = useNostr();
  const friends = useMarketListings(ready && mode === 'wotFriends');
  const preferred = usePreferredMarketListings(ready && mode === 'preferred');

  const fofActive = ready && mode === 'wotFof';
  const fofAuthors = useMarketFofAuthors(fofActive);
  // Until the set is known the scope is empty (and idle) — never the
  // contacts fallback, which would paint a Friends snapshot as FoF.
  const fofScope = useMemo<MarketListingsScope>(
    () => ({ account: pubkey ?? '', authors: fofAuthors.authors ?? [] }),
    [pubkey, fofAuthors.authors],
  );
  const fofListings = useMarketListings(fofActive && fofAuthors.authors !== undefined, fofScope);

  const allScope = useMemo<MarketListingsScope>(
    () => ({ account: pubkey ?? '', open: true }),
    [pubkey],
  );
  const all = useMarketListings(ready && mode === 'wotAll' && !!pubkey, allScope);

  const fof = useMemo(
    () => ({
      ...fofListings,
      loading: fofActive && (fofAuthors.authors === undefined || fofListings.loading),
      incomplete: fofListings.incomplete || fofAuthors.failed,
    }),
    [fofListings, fofActive, fofAuthors.authors, fofAuthors.failed],
  );

  const live =
    mode === 'wotFriends' ? friends : mode === 'wotFof' ? fof : mode === 'wotAll' ? all : preferred;
  return {
    live,
    fofProgress: mode === 'wotFof' ? fofAuthors.progress : null,
    fofFailed: mode === 'wotFof' && fofAuthors.failed,
  };
}
