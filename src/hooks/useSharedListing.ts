import { useCallback, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { loadedMarketSnapshots, readLoadedMarketSnapshots } from '../services/marketStorage';
import { peekEmbed, resolveEmbed, type EmbedRef } from '../services/nostrEmbedCache';
import { embedKey } from '../utils/nip27';
import { parseMarketListing } from '../utils/marketListings';
import type { MarketProduct } from '../data/marketProducts';

function findListing(
  snapshots: ReturnType<typeof loadedMarketSnapshots>,
  ref: EmbedRef,
): MarketProduct | undefined {
  if (ref.type !== 'address') return undefined;
  return snapshots
    .flatMap((snapshot) => snapshot.products)
    .find((product) => {
      const event = product.listing?.event;
      return (
        event &&
        event.kind === ref.kind &&
        event.pubkey === ref.pubkey &&
        event.tags.some((tag) => tag[0] === 'd' && tag[1] === ref.identifier) &&
        parseMarketListing(event) !== null
      );
    });
}

/** Local catalogue first; misses share bounded embed batches owned by focused readers. */
export function useSharedListing(ref: EmbedRef) {
  const { pubkey, relays } = useNostr();
  const key = `${pubkey}:${embedKey(ref)}`;
  const [state, setState] = useState<{ key: string; product?: MarketProduct }>();
  const local = useMemo(
    () => findListing(loadedMarketSnapshots(pubkey ? [pubkey] : []), ref),
    // Re-read after disk hydration, without scanning the catalogue on delivery ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, state],
  );
  const relayKey = relays
    .filter((relay) => relay.read)
    .map((relay) => relay.url)
    .join('|');
  const hintKey = ref.relays.join('|');
  useFocusEffect(
    useCallback(() => {
      const controller = new AbortController();
      const resolve = async () => {
        const cached =
          findListing(loadedMarketSnapshots(pubkey ? [pubkey] : []), ref) ??
          (pubkey ? findListing(await readLoadedMarketSnapshots(pubkey), ref) : undefined);
        if (controller.signal.aborted) return;
        if (cached) {
          setState({ key, product: cached });
          return;
        }
        const result = await resolveEmbed(
          ref,
          relayKey ? relayKey.split('|') : [],
          controller.signal,
        );
        if (!controller.signal.aborted) setState({ key, product: result.product ?? undefined });
      };
      void resolve();
      return () => controller.abort();
      // The key and relay strings identify the request; render-created objects do not restart it.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, relayKey, hintKey]),
  );
  return (
    local ??
    (state?.key === key ? state.product : undefined) ??
    peekEmbed(embedKey(ref))?.product ??
    undefined
  );
}
