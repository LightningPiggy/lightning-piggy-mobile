import { useAppRelayPrefs } from './useAppRelayPrefs';
import { loadSellerCurrency, subscribeSellerCurrency } from '../services/sellerPreferences';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
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
  reviveSellerAccount,
  sellerStoreState,
  subscribeSellerStore,
} from '../services/sellerEventStore';
import { reduceSellerSnapshot, type SellerSnapshot } from '../utils/marketSellerSnapshot';

/** A snapshot fetched this recently is reused when another seller screen
 * gains focus, instead of re-querying relays. */
const STALE_MS = 60_000;

const EMPTY: SellerSnapshot = { shop: null, zones: [], zoneEvents: new Map(), listings: [] };

export interface UseSellerShop {
  pubkey: string | null;
  defaultCurrency?: string;
  snapshot: SellerSnapshot;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Re-query relays now (pull-to-refresh / retry). */
  refresh: () => void;
  /** Signed in with a signer that can publish. */
  canPublish: boolean;
}

/**
 * The signed-in merchant's collections, shipping zones and listings.
 * Focus-armed one-shot fetch (no live subscription) into the shared
 * per-account store, so the seller screens share one snapshot.
 */
export function useSellerShop(): UseSellerShop {
  const { pubkey, relays, isLoggedIn, signerType } = useNostr();
  const relayScope = useAppRelayPrefs();
  const [version, setVersion] = useState(0);
  const [currency, setCurrency] = useState({ pubkey: '', shopId: '', value: 'SATS' });
  const [status, setStatus] = useState<UseSellerShop['status']>('idle');
  const [attempt, setAttempt] = useState(0);
  const forceNext = useRef(false);
  const fetchedScope = useRef<string | null>(null);
  const relayList = useMemo(() => sellerRelays(relays), [relays]);
  const relayKey = relayList.join(',');

  useEffect(() => subscribeSellerStore(() => setVersion((v) => v + 1)), []);

  useFocusEffect(
    useCallback(() => {
      if (!pubkey) {
        setStatus('idle');
        return;
      }
      let cancelled = false;
      // This screen only runs for the signed-in account.
      reviveSellerAccount(pubkey);
      const state = sellerStoreState(pubkey);
      if (!state.restored) {
        // Instant paint from the persisted snapshot; the relay fetch below
        // then merges anything newer.
        void Promise.all([loadSellerCache(pubkey), loadHiddenListings(pubkey)]).then(
          ([events, hidden]) => restoreSellerAccount(pubkey, events, hidden),
        );
      }
      if (
        !forceNext.current &&
        fetchedScope.current === relayScope &&
        Date.now() - state.fetchedAt < STALE_MS
      ) {
        setStatus('ready');
        return () => {
          cancelled = true;
        };
      }
      forceNext.current = false;
      const controller = new AbortController();
      setStatus('loading');
      fetchSellerEvents({ pubkey, relays: relayKey.split(','), signal: controller.signal })
        .then((events) => {
          if (cancelled) return;
          fetchedScope.current = relayScope;
          addSellerEvents(pubkey, events, true);
          void persistSellerSnapshot(pubkey);
          setStatus('ready');
        })
        .catch(() => {
          if (!cancelled) setStatus('error');
        });
      return () => {
        cancelled = true;
        controller.abort();
      };
      // attempt explicitly re-arms this focus effect for Retry / refresh.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pubkey, relayKey, attempt, relayScope]),
  );

  const refresh = useCallback(() => {
    forceNext.current = true;
    setAttempt((a) => a + 1);
  }, []);

  const snapshot = useMemo(() => {
    if (!pubkey) return EMPTY;
    const state = sellerStoreState(pubkey);
    return reduceSellerSnapshot([...state.events.values()], pubkey, state.hidden);
    // `version` is the store's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, version]);

  const shopId = snapshot.shop?.id ?? '';
  // Bumped when the Currencies screen saves, so every seller screen re-reads.
  const [currencyVersion, setCurrencyVersion] = useState(0);
  useEffect(
    () =>
      subscribeSellerCurrency((changed) => {
        if (changed === pubkey) setCurrencyVersion((v) => v + 1);
      }),
    [pubkey],
  );
  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    void loadSellerCurrency(pubkey, snapshot.shop)
      .then((value) => {
        if (!cancelled) setCurrency({ pubkey, shopId, value });
      })
      .catch(() => {
        if (!cancelled) setCurrency({ pubkey, shopId, value: 'SATS' });
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey, snapshot.shop, shopId, currencyVersion]);

  const canPublish = Boolean(isLoggedIn && ['nsec', 'amber', 'nip46'].includes(signerType ?? ''));
  const defaultCurrency = currency.pubkey === pubkey ? currency.value : 'SATS';
  return useMemo(
    () => ({
      pubkey,
      snapshot,
      status:
        status === 'ready' && (currency.pubkey !== pubkey || currency.shopId !== shopId)
          ? ('loading' as const)
          : status,
      refresh,
      canPublish,
      defaultCurrency,
    }),
    [
      pubkey,
      snapshot,
      status,
      refresh,
      canPublish,
      defaultCurrency,
      currency.pubkey,
      currency.shopId,
      shopId,
    ],
  );
}
