import { createPlacesScreenStyles as createStyles } from '../styles/PlacesScreen.styles';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import BrandedSpinner from '../components/BrandedSpinner';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, FlatList, Linking } from 'react-native';
import * as Location from 'expo-location';
import {
  ChevronLeft,
  ChevronRight,
  MapPin,
  Search,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import type { Palette } from '../styles/palettes';
import { ExploreNavigation } from '../navigation/types';
import {
  type BtcMapPlace,
  acceptsLightning,
  acceptsOnchain,
  fetchPlacesInBboxResult,
  formatAddress,
  isBoosted,
  lightningAddressOf,
} from '../services/btcMapService';
import { usePlacesCache } from '../hooks/usePlacesCache';
import { shouldShowEmptyState } from '../utils/placesCache';
import { formatDistance, haversineMetres } from '../utils/geohash';
import { orderFeaturedFirst } from '../utils/featuredPlaces';
import { placeContactLinks } from '../utils/placeContactLinks';
import { btcMapIconComponent } from '../utils/btcMapIcon';
import BrandPatternBackground from '../components/BrandPatternBackground';
import BtcMapAttribution from '../components/BtcMapAttribution';
import { LibreMiniMap } from '../components/LibreMiniMap';
import { MerchantDetailSheet } from '../components/MerchantDetailSheet';
import { useUserLocation } from '../contexts/UserLocationContext';
import PlacesFilterSheet, { countActiveFilters } from '../components/PlacesFilterSheet';
import LegendSheet from '../components/LegendSheet';

interface Props {
  navigation: ExploreNavigation;
}

/**
 * Places sub-screen — list of nearby Bitcoin-accepting merchants
 * sourced from BTC Map / OSM, sorted by distance from the user.
 * Tap a row to open `PlaceDetail` for the full address, payment
 * methods, contact info and a Pay-via-Lightning button. The
 * `See all →` link on the Hub's "Places near you" rail routes here
 * instead of jumping straight to the full map — most users want a
 * list view first; the map is one tap away from the header.
 *
 * Implementation mirrors `EventsScreen` / `HuntDiscoverScreen`:
 *   - pos captured up front so distance + sort work
 *   - client-side search box for substring match
 *   - "Open map" button in the header for users who want the visual
 */
const PlacesScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [mapBbox, setMapBbox] = useState<{
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  } | null>(null);
  // Cache-first hydration: seeds `places` + the loading flag synchronously
  // off the in-memory mirror so a warm visit paints the last-known list
  // immediately instead of flashing "No places nearby" (#910). The screen
  // still revalidates on mount via `reload` below — `applyFetched`
  // reconciles the fresh set in (cache-first: an empty/offline blip keeps
  // the existing list rather than blanking it).
  const { places, seededPos, loading, setLoading, applyFetched, seedFromCacheAsync } =
    usePlacesCache();
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  // Seed `pos` from the cached anchor so the distance-sorted list renders
  // before GPS resolves (otherwise `sortedPlaces` is empty until a fix
  // lands — the original cause of the empty flash).
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(seededPos);
  // True once a fetch attempt has settled this session — gates the
  // "No places nearby" empty state so it can't show while a fetch is
  // still in flight (or before one has run).
  const [fetchSettled, setFetchSettled] = useState(false);
  // True only while a *user-initiated* pull-to-refresh is in flight.
  // The background revalidate on mount must NOT show the spinner (that
  // would compete with the cold-start blocking spinner / would spin on
  // every warm visit). Separating this from `loading` lets a warm pull
  // show the RefreshControl spinner while the cached list stays painted
  // (no empty-flash), which `loading` alone can't express — on a warm
  // visit `loading` is seeded false and `reload` deliberately keeps it
  // false so the list isn't blanked.
  const [refreshing, setRefreshing] = useState(false);
  // Live user-position for the dot on the embedded mini-map — refreshes
  // as the user walks around without re-running the nearby-places fetch
  // (that fires once from `pos` above).
  const { pos: livePos } = useUserLocation();
  const { profile } = useNostr();
  const lastReloadRef = useRef<number>(0);

  const reload = useCallback(async () => {
    // Only show the blocking spinner when there's nothing cached to paint.
    // A warm visit keeps the list on-screen and refreshes quietly behind
    // the pull-to-refresh control.
    setLoading((wasLoading) => wasLoading || places.length === 0);
    setError(null);
    try {
      // Stale-while-revalidate: paint the last cached result instantly so
      // the list isn't a blank spinner while GPS + the live search resolve.
      // (The sync seed above already covers the warm path; this awaits the
      // disk-hydrated cache for the cold-start case where the mirror is
      // still empty.)
      void seedFromCacheAsync();
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setError(t('placesScreen.locationPermissionRequired'));
        setFetchSettled(true);
        setLoading(false);
        // Clear the pull-to-refresh spinner on the permission-denied early
        // return too, otherwise a user pull would spin forever.
        setRefreshing(false);
        return;
      }
      const fix = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      const lat = fix.coords.latitude;
      const lon = fix.coords.longitude;
      setPos({ lat, lon });
      // ±2° (~220 km half-side) — wider than the on-screen mini-map's
      // min-zoom bbox so the user can zoom out and still see merchants.
      // The BTC Map dataset is already fully in memory; bbox filtering
      // is an O(28k) in-memory walk, so a wider window costs nothing.
      // Earlier ±0.5° (~55 km) capped the on-screen list at ~38 km no
      // matter how far the user zoomed out — felt like a load bug.
      const result = await fetchPlacesInBboxResult({
        minLon: lon - 2,
        minLat: lat - 2,
        maxLon: lon + 2,
        maxLat: lat + 2,
      });
      applyFetched(result);
      lastReloadRef.current = Date.now();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFetchSettled(true);
      setLoading(false);
      // Always clear the pull-to-refresh spinner once the fetch settles.
      // Harmless on the background/mount path (it was never set there).
      setRefreshing(false);
    }
  }, [applyFetched, places.length, seedFromCacheAsync, setLoading, t]);

  // User-initiated pull-to-refresh: show the RefreshControl spinner while
  // the cached list stays on-screen, then revalidate. Distinct from the
  // silent on-mount revalidate so a warm refresh visibly responds without
  // reintroducing the empty-flash (#910).
  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    void reload();
  }, [reload]);

  useEffect(() => {
    reload();
    // Run once on mount — `reload` is stable enough for the SWR refresh and
    // re-running it on every identity change would re-fetch needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Plain nearest-first list. Featured pinning is intentionally NOT applied
  // here — it must run on the *visible* (filtered/searched/bbox-limited) set
  // so the (up to) three featured slots are always filled from what the user
  // can actually see, not from rows that a later filter removes. This array
  // feeds the mini-map + empty-state checks, neither of which cares about the
  // featured ordering, only the distance sort and the count.
  const sortedPlaces = useMemo(() => {
    if (!pos) return [] as { place: BtcMapPlace; distance: number }[];
    return places
      .map((place) => ({
        place,
        distance: haversineMetres(
          { lat: pos.lat, lon: pos.lon },
          { lat: place.lat, lon: place.lon },
        ),
      }))
      .sort((a, b) => a.distance - b.distance);
  }, [places, pos]);

  // Cache-first empty-state gate: only honest once a fetch has settled AND
  // both the cached list and the fetched list are empty — never flash
  // "No places nearby" while a cache exists or a fetch is still in flight
  // (#910). Keyed off `places` (the source list) rather than `sortedPlaces`
  // so it stays true even before GPS seeds `pos`.
  const showEmptyState = shouldShowEmptyState({
    cachedCount: places.length,
    fetchedCount: places.length,
    fetchSettled,
  });

  // Selected category filters — empty = show every category (default).
  // Categories are surfaced in the filter bottom-sheet; selected names
  // compose with `searchQuery` (AND), but OR within the set so the list
  // doesn't filter to zero (most listings carry 0-2 categories).
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [legendVisible, setLegendVisible] = useState(false);
  // Mini-map pin-tap → opens the shared `MerchantDetailSheet`, same
  // UX as the Explore mini-map + the full MapScreen. PR #630 follow-up.
  const [selectedMerchant, setSelectedMerchant] = useState<BtcMapPlace | null>(null);
  const availableCategories = useMemo(() => {
    const seen = new Set<string>();
    for (const p of places) for (const c of p.categories ?? []) seen.add(c);
    return [...seen].sort();
  }, [places]);
  const activeFilterCount = useMemo(
    () => countActiveFilters({ selectedCategories }),
    [selectedCategories],
  );

  const filteredPlaces = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let items = sortedPlaces;
    if (mapBbox) {
      items = items.filter(
        ({ place }) =>
          place.lat >= mapBbox.minLat &&
          place.lat <= mapBbox.maxLat &&
          place.lon >= mapBbox.minLon &&
          place.lon <= mapBbox.maxLon,
      );
    }
    if (selectedCategories.size > 0) {
      items = items.filter(({ place }) =>
        (place.categories ?? []).some((c) => selectedCategories.has(c)),
      );
    }
    if (q) {
      items = items.filter(({ place }) => {
        const hay = [
          place.tags.name ?? '',
          place.tags['addr:street'] ?? '',
          place.tags['addr:city'] ?? '',
          place.tags['addr:postcode'] ?? '',
          // Free-text search now also matches the curated category names
          // and the OSM cuisine tag, so "italian" / "cafe" / "bicycle"
          // resolve listings even when the user doesn't tap a chip.
          ...(place.categories ?? []),
          place.tags['cuisine'] ?? '',
        ]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    // Pin up to 3 boosted ("Featured") listings to the top of the VISIBLE
    // list, as the final step after every filter/search/bbox cut. Applying
    // it here (rather than on the unfiltered `sortedPlaces`) guarantees the
    // featured slots are filled from rows the user can actually see: if a
    // featured place is filtered out, the next nearest featured among the
    // visible set is promoted instead of being stranded in distance order.
    // The (up to) three nearest visible featured win the slots; everything
    // else, including any 4th+ featured listing, continues in distance order.
    // Each pinned row carries a "Featured" pill so the user can see why it's
    // at the top. Shared with the Explore "Places near you" rail via
    // `orderFeaturedFirst` so the cap lives in one place.
    return orderFeaturedFirst(items, (item) => isBoosted(item.place));
  }, [sortedPlaces, searchQuery, selectedCategories, mapBbox]);

  return (
    <View style={styles.container} testID="places-screen">
      <View style={styles.header}>
        <BrandPatternBackground variant="explore-compass" />
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            accessibilityLabel={t('placesScreen.backToExplore')}
            testID="places-back-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('placesScreen.title')}</Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('Map')}
            accessibilityLabel={t('placesScreen.openMapView')}
            testID="places-map-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <MapPin size={20} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTagline}>{t('placesScreen.tagline')}</Text>
      </View>

      <FlatList
        data={
          loading && places.length === 0
            ? []
            : error
              ? []
              : sortedPlaces.length === 0
                ? []
                : filteredPlaces
        }
        keyExtractor={({ place }) => String(place.id)}
        contentContainerStyle={styles.listContent}
        refreshControl={<BrandedRefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        ListHeaderComponent={
          <>
            <View style={styles.miniMapContainer}>
              <LibreMiniMap
                // Mini-map follows GPS — camera anchor should track
                // the live position, not the stale one-shot `pos`.
                lat={livePos?.lat ?? pos?.lat ?? null}
                lon={livePos?.lon ?? pos?.lon ?? null}
                userLat={livePos?.lat ?? null}
                userLon={livePos?.lon ?? null}
                userAvatarUri={profile?.picture ?? null}
                userAccuracyMetres={livePos?.accuracy ?? null}
                merchants={sortedPlaces.map((p) => p.place)}
                caches={[]}
                events={[]}
                onTapMap={() => navigation.navigate('Map')}
                onSelectMerchant={(m) => setSelectedMerchant(m)}
                onBoundsChange={setMapBbox}
                onOpenLegend={() => setLegendVisible(true)}
                defaultZoom={10}
              />
            </View>
            <View style={styles.attributionRow}>
              <BtcMapAttribution testID="places-btcmap-attribution" />
            </View>
            <View style={styles.searchRow}>
              <Search size={16} color={colors.textSupplementary} strokeWidth={2.5} />
              <TextInput
                style={styles.searchInput}
                placeholder={t('placesScreen.searchPlaces')}
                placeholderTextColor={colors.textSupplementary}
                value={searchQuery}
                onChangeText={setSearchQuery}
                autoCapitalize="none"
                autoCorrect={false}
                testID="places-search-input"
              />
              <TouchableOpacity
                style={styles.filterIconButton}
                onPress={() => setFilterSheetOpen(true)}
                testID="places-filter-button"
                accessibilityLabel={
                  activeFilterCount > 0
                    ? t('placesScreen.filtersActive', { count: activeFilterCount })
                    : t('placesScreen.filters')
                }
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <SlidersHorizontal size={18} color={colors.textHeader} strokeWidth={2.5} />
                {activeFilterCount > 0 ? (
                  <View style={styles.filterIconBadge}>
                    <Text style={styles.filterIconBadgeText}>{activeFilterCount}</Text>
                  </View>
                ) : null}
              </TouchableOpacity>
            </View>
            {loading && places.length === 0 ? (
              <View style={styles.center}>
                <BrandedSpinner />
                <Text style={styles.subtle}>{t('placesScreen.looking')}</Text>
              </View>
            ) : error ? (
              <View style={styles.center}>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={reload}>
                  <Text style={styles.retryButtonText}>{t('placesScreen.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : showEmptyState ? (
              <View style={styles.center} testID="places-empty-state">
                <MapPin size={56} color={colors.textSupplementary} strokeWidth={1.5} />
                <Text style={styles.emptyTitle}>{t('placesScreen.noPlacesNearby')}</Text>
                <Text style={styles.subtle}>{t('placesScreen.noPlacesNearbyHint')}</Text>
              </View>
            ) : !pos && places.length > 0 ? (
              // Legacy cache (disk blob predates the v1 anchor envelope): we
              // have cached places but no anchor yet, so the distance-sorted
              // list is empty until GPS resolves. Show a locating placeholder
              // rather than a blank header (Copilot #915).
              <View style={styles.center} testID="places-locating">
                <BrandedSpinner />
                <Text style={styles.subtle}>{t('placesScreen.gettingLocation')}</Text>
              </View>
            ) : null}
          </>
        }
        renderItem={({ item }) => (
          <PlaceRow
            place={item.place}
            distance={item.distance}
            colors={colors}
            styles={styles}
            onPress={() => navigation.navigate('PlaceDetail', { placeId: item.place.id })}
          />
        )}
        ListEmptyComponent={
          searchQuery.trim() !== '' && sortedPlaces.length > 0 ? (
            <Text style={styles.emptySearchText}>
              {t('placesScreen.noMatch', { query: searchQuery.trim() })}
            </Text>
          ) : null
        }
      />
      <PlacesFilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        availableCategories={availableCategories}
        selectedCategories={selectedCategories}
        onChangeCategories={setSelectedCategories}
        onClearAll={() => setSelectedCategories(new Set())}
      />
      <LegendSheet
        visible={legendVisible}
        onClose={() => setLegendVisible(false)}
        placesVisible
        availableCategories={availableCategories}
      />
      {/* Mini-map pin-tap sheet — same component MapScreen +
          ExploreHomeScreen use so the interaction shape is identical
          across every map surface. PR #630 follow-up. */}
      {selectedMerchant && (
        <MerchantDetailSheet
          place={selectedMerchant}
          colors={colors}
          onClose={() => setSelectedMerchant(null)}
          onViewDetails={() => {
            const placeId = selectedMerchant.id;
            setSelectedMerchant(null);
            navigation.navigate('PlaceDetail', { placeId });
          }}
        />
      )}
    </View>
  );
};

const PlaceRow: React.FC<{
  place: BtcMapPlace;
  distance: number;
  colors: Palette;
  styles: ReturnType<typeof createStyles>;
  onPress: () => void;
}> = ({ place, distance, colors, styles, onPress }) => {
  const t = useTranslation();
  const lightning = acceptsLightning(place);
  const onchain = acceptsOnchain(place);
  const lud16 = lightningAddressOf(place);
  const boosted = isBoosted(place);
  // Validated http(s) link only — the raw OSM tag never reaches Linking (#1785).
  const website = placeContactLinks(place).website;
  const websiteLabel = website ? website.value.replace(/^https?:\/\/(www\.)?/i, '') : null;
  return (
    <TouchableOpacity
      style={[styles.row, boosted ? styles.rowBoosted : null]}
      onPress={onPress}
      testID={`place-row-${place.id}`}
      accessibilityLabel={place.tags.name ?? t('placesScreen.unnamedMerchant')}
    >
      <View style={[styles.iconWrap, lightning ? styles.iconLightning : styles.iconOnchain]}>
        {/* Category icon (Coffee / UtensilsCrossed / Hotel / …) tells
            the user WHAT the place is at a glance. The pink / orange
            background still distinguishes Lightning vs on-chain
            payment — same idiom as MerchantDetailSheet, so list rows
            + the detail sheet read consistently. */}
        {(() => {
          const CategoryIcon = btcMapIconComponent(place.icon);
          return <CategoryIcon size={22} color={colors.white} strokeWidth={2.5} />;
        })()}
      </View>
      <View style={styles.rowMain}>
        <View style={styles.rowTitleLine}>
          <Text style={styles.rowTitle} numberOfLines={1}>
            {place.tags.name ?? t('placesScreen.unnamedMerchant')}
          </Text>
          {boosted ? (
            <View style={styles.rowFeaturedPill}>
              <Sparkles size={10} color={colors.textHeader} strokeWidth={2.5} />
              <Text style={styles.rowFeaturedText}>{t('placesScreen.featured')}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {lightning
            ? t('placesScreen.payLightning')
            : onchain
              ? t('placesScreen.payOnchain')
              : t('placesScreen.payBitcoin')}
          {Number.isFinite(distance) ? ` · ${formatDistance(distance)}` : ''}
          {lud16 ? ` · ${lud16}` : ''}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {formatAddress(place)}
        </Text>
        {website && websiteLabel ? (
          <TouchableOpacity
            onPress={() => {
              Linking.openURL(website.href).catch(() => {});
            }}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            testID={`place-row-${place.id}-website`}
            accessibilityLabel={t('placesScreen.openWebsite', { website: websiteLabel })}
          >
            <Text style={styles.rowLink} numberOfLines={1}>
              {websiteLabel}
            </Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <ChevronRight size={20} color={colors.textSupplementary} />
    </TouchableOpacity>
  );
};

export default PlacesScreen;
