import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useMemo, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { fetchListingRevision } from '../services/marketListingsService';
import type { MarketProduct } from '../data/marketProducts';

/**
 * The product page's listing, kept current by pull-to-refresh (#1301). A live
 * listing (kind 30402 / 30018) is replaceable by its `d` tag, so `refresh`
 * re-fetches its newest revision; only a NEWER revision of the same listing
 * replaces what's shown. Curated catalogue products (no `listing`) are
 * returned as-is. `withdrawn` turns true when a refresh finds the listing
 * gone — deleted by its seller (kind 5), sold / inactive, or expired — so the
 * page can stop offering to buy it. It stays true for the life of the page:
 * that was signed evidence, and a later refresh that happens to hit lagging
 * relays (still serving the old active revision) must not bring Buy back.
 */
export function useLatestListing(product: MarketProduct | undefined) {
  const { relays } = useNostr();
  const readRelays = useMemo(() => {
    const r = relays.filter((x) => x.read).map((x) => x.url);
    return r.length > 0 ? r : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [relays]);
  const [fresh, setFresh] = useState<MarketProduct | null>(null);
  const [withdrawn, setWithdrawn] = useState(false);

  const current = product?.listing?.event;
  // `id` encodes kind + author + `d`, so equal ids are the same listing.
  // Newer wins, ties broken by lower event id — reduceMarketListings' order.
  const freshEvent = fresh?.listing?.event;
  const shown =
    freshEvent &&
    current &&
    fresh?.id === product?.id &&
    (freshEvent.created_at > current.created_at ||
      (freshEvent.created_at === current.created_at && freshEvent.id < current.id))
      ? fresh
      : product;

  const refresh = useCallback(
    async (signal: AbortSignal) => {
      const base = shown?.listing;
      if (!shown || !base) return;
      const next = await fetchListingRevision(base.event, readRelays, signal);
      if (signal.aborted) return;
      if (!next) setWithdrawn(true);
      if (!next?.listing || next.listing.event.id === base.event.id) return;
      // Keep the seller's display name the feed resolved from contacts — the
      // parser alone only knows a shortened pubkey.
      setFresh({
        ...next,
        sellerName: shown.sellerName,
        listing: { ...next.listing, vendor: { ...next.listing.vendor, name: base.vendor.name } },
      });
    },
    [shown, readRelays],
  );

  return { product: shown, withdrawn, refresh };
}
