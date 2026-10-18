import MarketHeader from '../components/MarketHeader';
import MarketHeaderActions from '../components/MarketHeaderActions';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import { marketMerchants, resolveMerchantSelection } from '../utils/marketMerchants';
import { useCollectionFilter } from '../hooks/useCollectionFilter';
import MarketCollectionChips from '../components/MarketCollectionChips';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, useWindowDimensions } from 'react-native';
import MarketProductCard from '../components/MarketProductCard';
import MarketFilterBar from '../components/MarketFilterBar';
import MarketScopePill from '../components/MarketScopePill';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { useGroups } from '../contexts/GroupsContext';
import { useMarketScopeListings } from '../hooks/useMarketScopeListings';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import MarketShortcuts from '../components/MarketShortcuts';
import { createMarketScreenStyles } from '../styles/MarketScreen.styles';
import { sellerOf, type MarketProduct } from '../data/marketProducts';
import { featuredFirst } from '../utils/marketVendors';
import { useMarketPreferences } from '../hooks/useMarketPreferences';
import { useMarketShipsTo } from '../hooks/useMarketShipsTo';
import { localizedCountryName } from '../data/countries';
import { SHIPS_TO_UNKNOWN, shipsToOptions } from '../utils/marketShipsTo';
import { useMarketSelectionGuard } from '../hooks/useMarketSelectionGuard';
import { DEFAULT_MARKET_MODE, effectiveMarketMode, type MarketMode } from '../utils/marketMode';
import {
  canClearMarketFilters,
  countActiveMarketFilters,
  distinctCurrencies,
  filterMarketProducts,
  isMarketFilterActive,
  type MarketFilter,
} from '../utils/marketFilters';
import { MARKET_GRID_COLUMNS, marketGridTileWidth } from '../utils/marketGrid';
import type { ExploreNavigation, MarketRoute } from '../navigation/types';
import { perfLog } from '../utils/perfLog';

interface Props {
  navigation: ExploreNavigation;
  route?: MarketRoute;
}

/** Preferred catalogue, or foreground relay listings for the chosen seller scope
 * (follows; experimental: friends of friends / anyone). */
const MarketScreen: React.FC<Props> = ({ navigation, route }) => {
  const colors = useThemeColors();
  const { t, locale, formatLocale } = useLocale();
  const styles = useMemo(() => createMarketScreenStyles(colors), [colors]);

  // Derive the square tile width from the live window so rotation / tablet
  // widths stay a clean 2-up grid; a fixed width (not flex) also keeps a lone
  // last tile in an odd-length list at column width instead of stretching.
  const { width: windowWidth } = useWindowDimensions();
  const tileWidth = useMemo(() => marketGridTileWidth(windowWidth), [windowWidth]);

  const { ready, preferences, update } = useMarketPreferences();
  const { merchant: savedMerchant, shipsTo, includeUnknownShipping, currency } = preferences;
  // "Show experimental features" unlocks the friends-of-friends and All
  // scopes. With it off, a saved experimental scope reads as Preferred (it
  // isn't overwritten: the setting hydrates after the Market may mount).
  const { secretMode: experimental } = useGroups();
  const mode = effectiveMarketMode(preferences.mode, experimental);
  const { live, fofProgress, fofFailed } = useMarketScopeListings(mode, ready);
  const setMerchant = useCallback((merchant: string | null) => update({ merchant }), [update]);
  const setShipsTo = useCallback((shipsTo: string | null) => update({ shipsTo }), [update]);
  const setIncludeUnknownShipping = useCallback(
    (includeUnknownShipping: boolean) => update({ includeUnknownShipping }),
    [update],
  );
  const setCurrency = useCallback((currency: string | null) => update({ currency }), [update]);
  const selectMode = useCallback(
    (next: MarketMode) => {
      perfLog(`[PerfBlock] market mode tap ${next}`);
      update({ mode: next });
    },
    [update],
  );
  // Pairs with the tap marker above: the delta is tap-to-commit latency.
  useEffect(() => {
    perfLog(`[PerfBlock] market mode committed ${mode}`);
  }, [mode]);

  // The category filters (merchant / ships to / currency) live in a right-anchored
  // slide-in panel to keep the main view compact; the search box stays inline.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const openFilters = useCallback(() => {
    perfLog('[PerfBlock] market filter tap');
    setFiltersOpen(true);
  }, []);

  // Search + merchant + ships-to + currency filters. The query is debounced so
  // re-filtering stays off the per-keystroke path; the chip axes apply
  // immediately.
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);

  // Mode-scoped catalogue (preferred sellers / WoT friends), featured-first.
  // This is the set the filter options and the filtered list both derive from.
  const baseProducts = useMemo(() => {
    return ready ? featuredFirst(live.products) : [];
  }, [ready, live.products]);

  // Filter option lists sourced from the data actually loaded (not hardcoded).
  const loadedMerchants = useMemo(() => marketMerchants(baseProducts), [baseProducts]);
  const merchant = resolveMerchantSelection(savedMerchant, loadedMerchants, live.merchantAliases);
  // Ships-to comes from the sellers' published shipping options, fetched in
  // batches for the whole catalogue — never per card.
  const shipping = useMarketShipsTo(baseProducts, ready, live.generation);
  const shipsToCountries = useMemo(
    () =>
      shipsToOptions(shipping.byProduct.values(), {
        deviceCountry: shipping.deviceCountry,
        selected: shipsTo,
        nameOf: (code) => localizedCountryName(code, locale),
        locale: formatLocale,
      }),
    [shipping, shipsTo, locale, formatLocale],
  );
  const resolveShipsTo = useCallback(
    (product: MarketProduct) => shipping.byProduct.get(product.id) ?? SHIPS_TO_UNKNOWN,
    [shipping],
  );
  const loadedCurrencies = useMemo(() => distinctCurrencies(baseProducts), [baseProducts]);

  // A transient load (one seller's relay slow or silent) must never wipe a
  // choice the shopper made: selections are only reconciled on a seller-scope
  // change or after the choice has been missing from consecutive answered
  // loads, and their chips stay rendered (and selected) meanwhile.
  const { merchantOptions, currencies, merchantMissing, merchantName } = useMarketSelectionGuard({
    ready,
    mode,
    live,
    products: baseProducts,
    preferences,
    merchant,
    merchantOptions: loadedMerchants,
    currencies: loadedCurrencies,
    update,
  });

  const filter = useMemo<MarketFilter>(
    () => ({ query: debouncedQuery, merchant, shipsTo, includeUnknownShipping, currency }),
    [debouncedQuery, merchant, shipsTo, includeUnknownShipping, currency],
  );
  // The live (un-debounced) query — drives the empty-state copy and badges.
  const liveFilter: MarketFilter = { ...filter, query };
  // `active` tracks the live (un-debounced) query so the empty-state copy flips
  // as soon as the user types.
  const filterActive = isMarketFilterActive(liveFilter);
  // The seller scope counts toward the button badge whenever it narrows the
  // catalogue — including the default preferred-sellers view — so the button
  // never looks unfiltered while the list is scoped. Search also contributes,
  // but retains its own clear control.
  const panelFilterCount = countActiveMarketFilters(liveFilter, mode);
  const activeFilterCount = panelFilterCount + (query.trim().length > 0 ? 1 : 0);
  const filtersActive = activeFilterCount > 0;
  // The panel's Clear only shows when something can actually be reset.
  const filtersClearable = canClearMarketFilters(liveFilter, mode);

  const collectionFilter = useCollectionFilter(baseProducts, ready && merchant !== null, merchant);
  const products = useMemo(
    () => filterMarketProducts(collectionFilter.products, filter, sellerOf, resolveShipsTo),
    [collectionFilter.products, filter, resolveShipsTo],
  );

  // A See all request replaces filters on a reused grid, including a collection
  // from this same merchant. Consume each navigation request once so later
  // user edits are not overwritten by preference updates.
  const { select: selectCollection } = collectionFilter;
  const appliedRequest = useRef<MarketRoute['params']>(undefined);
  const request = route?.params;
  useEffect(() => {
    if (!ready || !request?.merchant || appliedRequest.current === request) return;
    appliedRequest.current = request;
    update({
      merchant: request.merchant,
      ...(request.mode ? { mode: request.mode } : {}),
      shipsTo: null,
      includeUnknownShipping: true,
      currency: null,
    });
    setQuery('');
    selectCollection(null);
  }, [ready, request, update, selectCollection]);

  const resetScope = useCallback(() => selectMode(DEFAULT_MARKET_MODE), [selectMode]);
  const clearFilters = useCallback(() => {
    update({ merchant: null, shipsTo: null, includeUnknownShipping: true, currency: null });
    selectMode(DEFAULT_MARKET_MODE);
  }, [selectMode, update]);

  const openProduct = useCallback(
    (product: MarketProduct) => {
      perfLog('[PerfBlock] market product tap');
      navigation.navigate('MarketProductDetail', { productId: product.id, product });
    },
    [navigation],
  );

  const renderProduct = useCallback(
    ({ item }: { item: MarketProduct }) => {
      // Resolve the vendor once — `sellerOf` linearly scans MARKET_VENDORS, so
      // reuse the result for both `sellerName` and `vendor` (Copilot review on
      // #948).
      const vendor = sellerOf(item);
      return (
        // Fixed-width wrapper sizes the tile; the card fills it (width: '100%').
        // This is what keeps a lone last tile from stretching full-width.
        <View style={{ width: tileWidth }}>
          <MarketProductCard
            product={item}
            sellerName={vendor?.name ?? item.sellerName}
            vendor={vendor}
            shippingUnknown={shipping.byProduct.get(item.id)?.kind === 'unknown'}
            variant="grid"
            onPress={openProduct}
            testID={`market-product-card-${item.id}`}
          />
        </View>
      );
    },
    [tileWidth, openProduct, shipping],
  );

  const emptyCopy =
    live.loading && baseProducts.length === 0
      ? mode === 'wotFof'
        ? t('market.live.loadingNetwork')
        : mode === 'wotAll'
          ? t('market.live.loadingAll')
          : t('market.live.loading')
      : merchantMissing
        ? t('market.screen.emptyMerchantMissing', { name: merchantName ?? merchant ?? '' })
        : filterActive
          ? t('market.screen.emptyNoMatch')
          : mode === 'wotFriends'
            ? t('market.screen.emptyNoFriends')
            : mode === 'wotFof'
              ? t('market.screen.emptyNoFof')
              : mode === 'wotAll'
                ? t('market.screen.emptyNoAll')
                : t('market.screen.emptyNone');

  if (!ready) return <View style={styles.container} testID="market-screen" />;

  return (
    <View style={styles.container} testID="market-screen">
      <MarketHeader
        showProfile
        title={t('market.screen.title')}
        backLabel={t('market.screen.back')}
        onBack={() => navigation.goBack()}
        testID="market-back-button"
      >
        <MarketHeaderActions
          query={query}
          onChangeQuery={setQuery}
          filtersActive={filtersActive}
          activeFilterCount={activeFilterCount}
          onOpenFilters={openFilters}
        />
      </MarketHeader>

      <MarketShortcuts navigation={navigation} />

      {/* The seller scope is always shown as a pill: Preferred's opens
          Filters; every other scope's × returns to Preferred. */}
      <MarketScopePill
        mode={mode}
        onOpenFilters={openFilters}
        onReset={resetScope}
        fofProgress={fofProgress}
        fofFailed={fofFailed}
      />

      {/* Pull-to-refresh replaces the old status row; only a load that missed
          some sellers says so, inline. */}
      {live.sellersUnreachable && !live.loading ? (
        <View style={styles.partialBanner} testID="market-partial-banner">
          <Text style={styles.partialBannerText}>{t('market.live.partialToast')}</Text>
        </View>
      ) : null}
      {merchant !== null ? (
        <MarketCollectionChips
          collections={collectionFilter.collections}
          selected={collectionFilter.selected}
          onSelect={collectionFilter.select}
        />
      ) : null}
      <MarketFilterBar
        mode={mode}
        onSelectMode={selectMode}
        experimental={experimental}
        visible={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        merchants={merchantOptions}
        selectedMerchant={merchant}
        onSelectMerchant={setMerchant}
        shipsToCountries={shipsToCountries}
        selectedShipsTo={shipsTo}
        onSelectShipsTo={setShipsTo}
        includeUnknownShipping={includeUnknownShipping}
        onIncludeUnknownShippingChange={setIncludeUnknownShipping}
        currencies={currencies}
        selectedCurrency={currency}
        onSelectCurrency={setCurrency}
        active={filtersClearable}
        onClear={clearFilters}
      />

      <FlatList
        data={products}
        refreshControl={
          <BrandedRefreshControl refreshing={live.loading} onRefresh={live.refresh} />
        }
        keyExtractor={(p) => p.id}
        numColumns={MARKET_GRID_COLUMNS}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.gridContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        removeClippedSubviews
        initialNumToRender={8}
        windowSize={7}
        ListEmptyComponent={
          <View style={styles.emptyWrap} testID="market-empty">
            <Text style={styles.emptyText}>{emptyCopy}</Text>
          </View>
        }
        renderItem={renderProduct}
      />
    </View>
  );
};

export default MarketScreen;
