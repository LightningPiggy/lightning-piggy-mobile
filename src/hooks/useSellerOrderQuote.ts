import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import {
  fetchSellerEvents,
  loadHiddenListings,
  loadSellerCache,
  persistSellerSnapshot,
  sellerRelays,
} from '../services/marketSellerService';
import {
  addSellerEvents,
  restoreSellerAccount,
  sellerStoreState,
  subscribeSellerStore,
} from '../services/sellerEventStore';
import { useBtcRates } from './useBtcRates';
import { reduceSellerSnapshot } from '../utils/marketSellerSnapshot';
import { normalizeCurrencyCode } from '../utils/currencyCode';
import { isSatsDenominated } from '../utils/marketCheckoutPricing';
import { quoteSellerOrder, type SellerOrderQuote } from '../utils/sellerOrderQuote';
import type { ParsedOrderEvent } from '../utils/orderEvents';

/** Re-query the seller's own events at most this often from order cards. */
const REFRESH_MS = 5 * 60_000;
const inFlight = new Map<string, Promise<void>>();
const fetchedScopes = new Map<string, string>();
const requestedScopes = new Map<string, string>();

/** Restore the persisted snapshot, then refresh from relays if stale — one
 * request per account however many order cards mount at once. */
function ensureSellerSnapshot(pubkey: string, relays: string[], relayScope: string): Promise<void> {
  const key = JSON.stringify([pubkey, relayScope, relays]);
  // Record even a deduplicated request: switching A → B → A makes A current again.
  requestedScopes.set(pubkey, key);
  const pending = inFlight.get(key);
  if (pending) return pending;
  const run = (async () => {
    const state = sellerStoreState(pubkey);
    if (!state.restored) {
      const [events, hidden] = await Promise.all([
        loadSellerCache(pubkey),
        loadHiddenListings(pubkey),
      ]);
      if (requestedScopes.get(pubkey) !== key) return;
      restoreSellerAccount(pubkey, events, hidden);
    }
    if (
      fetchedScopes.get(pubkey) === key &&
      Date.now() - sellerStoreState(pubkey).fetchedAt < REFRESH_MS
    )
      return;
    const events = await fetchSellerEvents({ pubkey, relays });
    if (requestedScopes.get(pubkey) !== key) return;
    fetchedScopes.set(pubkey, key);
    addSellerEvents(pubkey, events, true);
    await persistSellerSnapshot(pubkey);
  })()
    .catch(() => undefined)
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

export interface UseSellerOrderQuote {
  quote: SellerOrderQuote | null;
  quoteCurrent: () => SellerOrderQuote | null;
  /** The shop snapshot is still loading (first paint). */
  loading: boolean;
  /** Titles by item ref, for summaries. */
  titles: ReadonlyMap<string, string>;
}

/**
 * Price an incoming order the way the seller would: from their OWN current
 * listings + shipping options (never the buyer's `amount`), converting fiat
 * at the app's current BTC rate. Null `order` (not an incoming order for the
 * signed-in seller) does nothing.
 */
export function useSellerOrderQuote(order: ParsedOrderEvent | null): UseSellerOrderQuote {
  const { pubkey, relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const relayKey = useMemo(() => sellerRelays(relays).join(','), [relays]);
  const active = Boolean(order && pubkey);

  useEffect(() => subscribeSellerStore(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    if (!active || !pubkey) return;
    let cancelled = false;
    void ensureSellerSnapshot(pubkey, relayKey.split(','), relayScope).then(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [active, pubkey, relayKey, relayScope]);

  const snapshot = useMemo(() => {
    if (!pubkey) return null;
    const state = sellerStoreState(pubkey);
    return reduceSellerSnapshot([...state.events.values()], pubkey, state.hidden);
    // `version` is the store's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, version]);

  // Fiat currencies involved: the ordered listings' prices + the chosen option.
  const currencies = useMemo(() => {
    if (!order || !snapshot) return [];
    const wanted = new Set<string>();
    const refs = new Set(order.items.map((i) => i.ref));
    for (const listing of snapshot.listings) {
      const d = listing.tags.find((t) => t[0] === 'd')?.[1];
      if (!d || !refs.has(`30402:${listing.pubkey}:${d}`)) continue;
      const cur = normalizeCurrencyCode(listing.tags.find((t) => t[0] === 'price')?.[2] ?? '');
      if (cur && !isSatsDenominated(cur)) wanted.add(cur);
    }
    const option = snapshot.zones.find((z) => z.coordinate === order.shipping);
    if (option && !isSatsDenominated(option.currency)) {
      wanted.add(normalizeCurrencyCode(option.currency));
    }
    return [...wanted].sort();
  }, [order, snapshot]);
  const { rates } = useBtcRates(currencies, active);

  const quote = useMemo(
    () =>
      order && pubkey && snapshot
        ? quoteSellerOrder({
            order,
            sellerPubkey: pubkey,
            listings: snapshot.listings,
            zones: snapshot.zones,
            rates,
          })
        : null,
    [order, pubkey, snapshot, rates],
  );
  const titles = useMemo(
    () => new Map((quote?.lines ?? []).map((l) => [l.ref, l.title] as const)),
    [quote],
  );
  const quoteCurrent = useCallback(() => {
    if (!order || !pubkey) return null;
    const state = sellerStoreState(pubkey);
    const current = reduceSellerSnapshot([...state.events.values()], pubkey, state.hidden);
    return quoteSellerOrder({
      order,
      sellerPubkey: pubkey,
      listings: current.listings,
      zones: current.zones,
      rates,
    });
  }, [order, pubkey, rates]);
  return {
    quote,
    quoteCurrent,
    loading: active && loading && !(quote && quote.lines.length > 0),
    titles,
  };
}
