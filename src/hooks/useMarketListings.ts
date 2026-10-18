import { useAppRelayPrefs } from './useAppRelayPrefs';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { Toast } from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import { useMarketMerchantProfiles } from './useMarketMerchantProfiles';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import {
  fetchMarketListings,
  fetchOpenMarketListings,
  type MarketListingsResult,
} from '../services/marketListingsService';
import {
  getMarketSnapshot,
  unexpiredMarketProducts,
  readMarketSnapshot,
  writeMarketSnapshot,
} from '../services/marketStorage';
import { carriedListingEvents, mergeMarketSnapshot } from '../utils/marketSnapshotMerge';
import { curateOpenListingProducts, withKnownProfiles } from '../utils/marketOpenScope';
import type { MarketProduct } from '../data/marketProducts';

/**
 * A snapshot younger than this is reused when the user flips back to WoT:
 * Friends (or the screen refocuses) instead of re-querying every relay. The
 * Refresh button always fetches.
 */
export const MARKET_SNAPSHOT_FRESH_MS = 2 * 60 * 1000;

/**
 * Whose listings to load: an explicit author set (preferred sellers,
 * friends of friends), or `open` — anyone (the experimental All scope).
 * Omitted = the viewer's direct follows.
 */
export type MarketListingsScope =
  | { account: string; authors: readonly string[] }
  | { account: string; open: true };

/** Snapshot-key stand-in for the author list of the open (All) scope. */
const OPEN_SCOPE_KEY = '*';

export function useMarketListings(enabled: boolean, scope?: MarketListingsScope) {
  const { pubkey, relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const { contacts } = useNostrContacts();
  const t = useTranslation();
  const focused = useIsFocused();
  const open = !!scope && 'open' in scope;
  const scopedAuthors = scope && 'authors' in scope ? scope.authors : undefined;
  const authorsKey = useMemo(
    () =>
      open
        ? OPEN_SCOPE_KEY
        : [...new Set(scopedAuthors ?? contacts.map((contact) => contact.pubkey.toLowerCase()))]
            .sort()
            .join(','),
    [contacts, scopedAuthors, open],
  );
  const relaysKey = useMemo(
    () =>
      relays
        .filter((r) => r.read)
        .map((r) => r.url)
        .sort()
        .join(','),
    [relays],
  );
  const account = scope?.account ?? pubkey;
  const key = `${account ?? ''}|${authorsKey}|${relaysKey}`;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<
    MarketListingsResult & { key: string; loading: boolean; completed: boolean }
  >(() => ({
    ...(getMarketSnapshot(key)?.result ?? { products: [], incomplete: false }),
    key,
    loading: false,
    completed: false,
  }));
  // The last complete snapshot, with its scope, landing time and the refresh
  // revision it answered — a ref, so recording it never re-runs the effect.
  const lastFetch = useRef<{
    key: string;
    at: number;
    revision: number;
    relayScope: string;
    result: MarketListingsResult;
  } | null>(null);
  // The last whole catalogue for a scope (never a first page): what the next
  // result merges over, so a relay that stays silent can't shrink the grid.
  const confirmed = useRef<{ key: string; products: MarketProduct[] }>({
    key,
    products: getMarketSnapshot(key)?.result.products ?? [],
  });
  // Counts completed loads, so consumers can tell one load from the next.
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setRevision((r) => r + 1), []);
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !focused || !account) return;
      const last = lastFetch.current;
      if (
        last &&
        last.key === key &&
        last.revision === revision &&
        last.relayScope === relayScope &&
        Date.now() - last.at < MARKET_SNAPSHOT_FRESH_MS
      ) {
        // Show the cached snapshot. State may hold something else: a refetch
        // aborted mid-flight (mode switch / blur) leaves `loading` set, and a
        // brief detour through another scope leaves that scope's key.
        const cached = last.result;
        confirmed.current = { key, products: cached.products };
        setState((prev) =>
          prev.key === key && !prev.loading
            ? prev
            : { ...cached, key, loading: false, completed: true },
        );
        return;
      }
      const controller = new AbortController();
      const cached = getMarketSnapshot(key);
      let received = false;
      if (!cached)
        void readMarketSnapshot(key).then((snapshot) => {
          if (!snapshot || received || controller.signal.aborted) return;
          confirmed.current = { key, products: snapshot.result.products };
          setState({ ...snapshot.result, key, loading: true, completed: false });
        });
      // Refreshing the same account/follow scope keeps the current snapshot on
      // screen (and so the user's filters); only a new scope starts empty.
      if (confirmed.current.key !== key)
        confirmed.current = { key, products: cached?.result.products ?? [] };
      setState((prev) =>
        prev.key === key
          ? { ...prev, loading: true }
          : {
              ...(cached?.result ?? { products: [], incomplete: false }),
              key,
              loading: true,
              completed: false,
            },
      );
      // Paint the newest verified listings early on a first load. A refresh
      // keeps showing its previous (longer) snapshot until the full result.
      const onFirstPage = (products: MarketListingsResult['products']) => {
        if (controller.signal.aborted) return;
        received = true;
        setState((prev) =>
          prev.key === key && prev.products.length >= products.length
            ? prev
            : { key, products, incomplete: false, loading: true, completed: false },
        );
      };
      let dismissToast: (() => void) | undefined;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      const load = () =>
        (open
          ? fetchOpenMarketListings(relaysKey.split(','), controller.signal, onFirstPage, {
              carried: carriedListingEvents(confirmed.current.products),
            })
          : fetchMarketListings(
              authorsKey.split(','),
              relaysKey.split(','),
              controller.signal,
              onFirstPage,
              {
                carried: carriedListingEvents(confirmed.current.products),
                previousProducts: confirmed.current.products,
              },
            )
        ).catch(
          (): MarketListingsResult => ({
            products: [],
            incomplete: true,
            transportFailed: true,
            answeredRelays: [],
          }),
        );
      // Merge over the last whole catalogue (stale-while-revalidate): listings
      // whose relays stayed silent this round stay on screen.
      const showResult = (fetched: MarketListingsResult, loading: boolean, completed: boolean) => {
        const base = confirmed.current.key === key ? confirmed.current.products : [];
        const merged = mergeMarketSnapshot(base, fetched);
        const products = open ? curateOpenListingProducts(merged) : merged;
        const shownSellers = new Set(products.map((product) => product.listing?.event.pubkey));
        const result = {
          ...fetched,
          products,
          unreachableSellers: (fetched.unreachableSellers ?? []).filter(
            (author) => !shownSellers.has(author),
          ),
        };
        confirmed.current = { key, products: result.products };
        setState({ ...result, key, loading, completed });
        return result;
      };
      const publish = (fetched: MarketListingsResult) => {
        if (controller.signal.aborted) return;
        received = true;
        const result = showResult(fetched, false, true);
        setGeneration((value) => value + 1);
        if (!result.incomplete || result.products.length > 0) void writeMarketSnapshot(key, result);
        // Only a complete snapshot is worth reusing; a partial one refetches.
        lastFetch.current = result.incomplete
          ? null
          : { key, at: Date.now(), revision, relayScope, result };
        return result;
      };
      void load().then((result) => {
        if (controller.signal.aborted) return;
        if (!result.incomplete) {
          publish({ ...result, unreachableSellers: [] });
          return;
        }
        received = true;
        showResult({ ...result, unreachableSellers: [] }, true, false);
        retryTimer = setTimeout(() => {
          void load().then((retried) => {
            if (controller.signal.aborted) return;
            const firstUnreachable = new Set(result.unreachableSellers ?? []);
            const published = publish({
              ...retried,
              unreachableSellers: (retried.unreachableSellers ?? []).filter((author) =>
                firstUnreachable.has(author),
              ),
            });
            if (published?.unreachableSellers?.length)
              dismissToast = Toast.showOwned({
                type: 'info',
                text1: t('market.live.partialToast'),
                autoHide: true,
                visibilityTime: 3500,
              });
          });
        }, 1500);
      });
      return () => {
        controller.abort();
        if (retryTimer) clearTimeout(retryTimer);
        dismissToast?.();
      };
    }, [enabled, focused, key, account, authorsKey, relaysKey, revision, relayScope, t, open]),
  );
  // Legacy filters stored contact labels. Preserve those selections while
  // moving to pubkey keys, even when a petname differs from the shop profile.
  const merchantAliases = useMemo(() => {
    const aliases = new Map<string, string>();
    for (const contact of contacts) {
      for (const label of [
        contact.petname,
        contact.profile?.displayName,
        contact.profile?.name,
        contact.profile?.nip05,
      ]) {
        if (label) aliases.set(label, contact.pubkey.toLowerCase());
      }
    }
    return aliases;
  }, [contacts]);
  const currentProducts = useMemo(
    () => (state.key === key ? unexpiredMarketProducts(state.products) : []),
    // Recheck expiration when returning to this scope, even with a fresh snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, key, enabled, focused],
  );
  const {
    products: resolvedProducts,
    profilesReady,
    hasProfile,
  } = useMarketMerchantProfiles(currentProducts, enabled && focused);
  // All scope, rule 3 (utils/marketOpenScope): once the profile pass has
  // completed, retain only sellers with a known kind-0, even after lookup failures.
  const products = useMemo(
    () =>
      open && profilesReady ? withKnownProfiles(resolvedProducts, hasProfile) : resolvedProducts,
    [open, profilesReady, resolvedProducts, hasProfile],
  );
  return useMemo(
    () => ({
      products,
      profilesReady,
      merchantAliases,
      loading: enabled && !!account && (state.key !== key || state.loading),
      completed: state.key === key && state.completed,
      generation,
      answeredRelays: state.key === key ? state.answeredRelays : undefined,
      hasSnapshot:
        state.key === key &&
        ((state.completed && !state.incomplete) ||
          state.products.length > 0 ||
          !!getMarketSnapshot(key)),
      incomplete: state.key === key && state.incomplete,
      sellersUnreachable:
        state.key === key && state.completed && !!state.unreachableSellers?.length,
      refresh,
    }),
    [state, key, enabled, account, refresh, products, profilesReady, merchantAliases, generation],
  );
}
