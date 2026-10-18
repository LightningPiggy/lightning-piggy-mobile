import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { Toast } from '../components/BrandedToast';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { fetchListingLikes } from '../services/marketLikesService';
import { MARKET_RELAYS } from '../utils/marketListingsQuery';
import {
  LIKE_CONTENT,
  LISTING_KIND,
  listingRelayHint,
  listingCoordinate,
} from '../utils/marketLikes';
import type { MarketProduct } from '../data/marketProducts';

interface LikeState {
  /** People with an active like; null until the first fetch lands. */
  count: number | null;
  /** The viewer's active like ids — Unlike retracts all of them. */
  myIds: string[];
}

const EMPTY: LikeState = { count: null, myIds: [] };

/**
 * Like / Unlike for a kind-30402 Market listing (#1541). The count and the
 * viewer's own like are fetched on screen focus (no live subscription); a tap
 * updates optimistically, then publishes a NIP-25 reaction (Like) or a NIP-09
 * deletion of the viewer's own reactions (Unlike), rolling back with a toast
 * if publishing fails. `coordinate` is null for products that can't be liked
 * (curated catalogue items, NIP-15 products).
 */
export function useListingLike(product: MarketProduct, onRequestSignIn: () => void) {
  const t = useTranslation();
  const { pubkey, relays, publishReaction, deleteReaction } = useNostr();
  const event = product.listing?.event;
  const coordinate = event ? listingCoordinate(event) : null;
  const readRelays = useMemo(() => {
    const r = relays.filter((x) => x.read).map((x) => x.url);
    return r.length > 0 ? r : enabledAppRelays('default', DEFAULT_RELAYS);
  }, [relays]);
  const [state, setState] = useState<LikeState>(EMPTY);
  // Focus results captured before a toggle must not overwrite its result.
  const busyRef = useRef(false);
  const mutationGeneration = useRef(0);
  const [busy, setBusy] = useState(false);

  useLayoutEffect(() => {
    setState(EMPTY);
    busyRef.current = false;
    setBusy(false);
    // Invalidate both reads and mutations belonging to the previous identity.
    return () => {
      mutationGeneration.current += 1;
    };
  }, [pubkey, coordinate]);

  useFocusEffect(
    useCallback(() => {
      if (!coordinate || busyRef.current) return undefined;
      const controller = new AbortController();
      const generation = mutationGeneration.current;
      fetchListingLikes(coordinate, pubkey, readRelays, controller.signal)
        .then((likes) => {
          if (
            controller.signal.aborted ||
            busyRef.current ||
            generation !== mutationGeneration.current
          )
            return;
          setState({ count: likes.count, myIds: likes.myReactionIds });
        })
        .catch(() => {
          // Keep the current identity's state. An unresolved first lookup
          // must not allow a toggle; the next focus will retry it.
        });
      return () => controller.abort();
    }, [coordinate, pubkey, readRelays]),
  );

  const liked = state.myIds.length > 0;

  const toggle = useCallback(async () => {
    if (!event || !coordinate || busyRef.current) return;
    if (!pubkey) {
      onRequestSignIn();
      return;
    }
    // Unlike needs every existing reaction id, including on the first tap.
    if (state.count === null) return;
    const before = state;
    const generation = ++mutationGeneration.current;
    const isCurrent = () => generation === mutationGeneration.current;
    busyRef.current = true;
    setBusy(true);
    const fail = () => {
      if (!isCurrent()) return;
      setState(before);
      Toast.show({
        type: 'error',
        text1: liked ? t('market.like.unlikeFailed') : t('market.like.likeFailed'),
      });
    };
    try {
      if (!liked) {
        setState({ count: (before.count ?? 0) + 1, myIds: ['pending'] });
        const id = await publishReaction({
          emoji: LIKE_CONTENT,
          targetEventId: event.id,
          targetAuthorPubkey: event.pubkey,
          targetEventKind: LISTING_KIND,
          targetAddress: { coordinate, relayHint: listingRelayHint() },
          extraRelays: enabledAppRelays('market', MARKET_RELAYS),
        });
        if (!isCurrent()) return;
        if (id) setState({ count: (before.count ?? 0) + 1, myIds: [id] });
        else fail();
      } else {
        setState({ count: Math.max(0, (before.count ?? 1) - 1), myIds: [] });
        const results = await Promise.all(
          before.myIds.map((id) => deleteReaction(id, enabledAppRelays('market', MARKET_RELAYS))),
        );
        if (!isCurrent()) return;
        const remaining = before.myIds.filter((_, i) => !results[i]);
        if (remaining.length > 0) {
          setState({ count: before.count, myIds: remaining });
          Toast.show({ type: 'error', text1: t('market.like.unlikeFailed') });
        }
      }
    } catch {
      fail();
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [
    event,
    coordinate,
    pubkey,
    state,
    liked,
    publishReaction,
    deleteReaction,
    onRequestSignIn,
    t,
  ]);

  return {
    available: !!coordinate,
    liked,
    count: state.count,
    busy: busy || (!!pubkey && !!coordinate && state.count === null),
    toggle,
  };
}
