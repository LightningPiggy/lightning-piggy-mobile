import BrandedRefreshControl from '../components/BrandedRefreshControl';
import ExploreEventCard from '../components/ExploreEventCard';
import { useLocale } from '../contexts/LocaleContext';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, TouchableOpacity, ScrollView } from 'react-native';
import { useExploreRailsPosition } from '../hooks/useExploreRailsPosition';
import { useFocusEffect } from '@react-navigation/native';
import { ChevronRight, Compass, Sparkles } from 'lucide-react-native';
import TabHeader from '../components/TabHeader';
import { useTranslation } from '../contexts/LocaleContext';
import BrandPatternBackground from '../components/BrandPatternBackground';
import { GeocacheRailEmptyState } from '../components/GeocacheRailEmptyState';
import { ContentRail } from '../components/ContentRail';
import { ExploreMiniMap } from '../components/ExploreMiniMap';
import CacheCard from '../components/ExploreCacheCard';
import { MerchantDetailSheet } from '../components/MerchantDetailSheet';
import { CacheDetailSheet } from '../components/CacheDetailSheet';
import LegendSheet from '../components/LegendSheet';
import { btcMapIconComponent } from '../utils/btcMapIcon';
import { orderFeaturedFirst } from '../utils/featuredPlaces';
import { perfPageReady } from '../utils/perfLog';
import { courses, type Course } from '../data/learnContent';
import MarketProductCard from '../components/MarketProductCard';
import { sellerOf, type MarketProduct } from '../data/marketProducts';
import { usePreferredMarketSample } from '../hooks/usePreferredMarketListings';
import {
  getProgress,
  LearnProgress,
  getCourseCompletedCount,
} from '../services/learnProgressService';
import {
  type BtcMapPlace,
  acceptsLightning,
  fetchNearestPlaces,
  formatAddress,
  isBoosted,
  lightningAddressOf,
  peekCachedPlacesSync,
  prefetchDataset,
  refreshDataset,
} from '../services/btcMapService';
import { useNearbyRadius } from '../hooks/useNearbyRadius';
import { BOOSTED_RADIUS_METRES } from '../services/nearbyRadiusService';
import { type ParsedCache, type ParsedEvent } from '../services/nostrPlacesService';

import { decodeGeohash, formatDistance, haversineMetres } from '../utils/geohash';
import { isFutureEvent } from '../utils/futureEvent';
import { isHiddenInProd } from '../utils/exploreContentFilter';
import { useExploreRelayContent } from '../hooks/useExploreRelayContent';
import { useThemeColors } from '../contexts/ThemeContext';
import { createExploreHomeScreenStyles } from '../styles/ExploreHomeScreen.styles';
import { createExploreHomeRailStyles } from '../styles/ExploreHomeRail.styles';
import type { Palette } from '../styles/palettes';
import { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

/**
 * Explore hub. Acts as a content surface, not a navigation menu — a
 * mini-map preview at the top renders local merchants + caches +
 * event venues over OSM tiles, and four content rails below preview
 * the same data the dedicated sub-screens display in full.
 *
 * Each rail subscribes to the same source its sub-screen uses
 * (BTC Map for places, NIP-GC kind 37516 for caches, NIP-52 kind
 * 31923 for events, local AsyncStorage for Lessons progress) so a
 * tap on a card opens the right detail directly. The header
 * "See all →" link routes to the full sub-screen and carries the
 * legacy `explore-card-{key}` testIDs so existing Maestro flows
 * keep navigating.
 */
const ExploreHomeScreen: React.FC<Props> = ({ navigation }) => {
  const { formatLocale } = useLocale();
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createExploreHomeScreenStyles(colors), [colors]);
  const localStyles = useMemo(() => createExploreHomeRailStyles(colors), [colors]);
  const { radius: maxDistanceMetres } = useNearbyRadius();

  // Perf marker — same hook scripts/perf-startup.sh consumes.
  const renderLoggedRef = useRef(false);
  useEffect(() => {
    if (renderLoggedRef.current) return;
    renderLoggedRef.current = true;
    console.log(`[Perf] ExploreHomeScreen first render`);
  }, []);

  // Warm the BTC Map cache off the JS thread's critical path. The bbox
  // fetch below is gated on a real GPS fix, but `prefetchDataset` only
  // touches AsyncStorage + the in-memory parse — so kicking it off here
  // runs the multi-MB JSON.parse in parallel with location resolution
  // instead of serially on the first `fetchPlacesInBbox`. Cold-launch
  // and Home-tab users pay nothing — the prefetch only fires when the
  // Explore tab is first visited.
  useEffect(() => {
    // Defer off the synchronous mount path. prefetchDataset reads a file
    // and parses 100s of KB of merchant JSON on the JS thread; calling it
    // inline meant cold-mount paid that cost before paint. setTimeout(0)
    // yields once so the first render lands first; the prefetch then runs
    // before any pos-gated fetch needs the cache, so the user still sees
    // the merchant rail seeded from memory.
    const handle = setTimeout(() => {
      const __t0 = performance.now();
      prefetchDataset();
      console.log(
        `[PerfBlock] ExploreHome prefetchDataset kicked: +${Math.round(performance.now() - __t0)}ms`,
      );
    }, 0);
    return () => clearTimeout(handle);
  }, []);

  // ----- location ---------------------------------------------------------

  // One-shot position for the rails, seeded from the cached anchor and
  // replaced by the first real fix (one-shot + first-fix watch racing —
  // see useExploreRailsPosition for the #1064 rationale). The live GPS
  // stream is deliberately NOT consumed here: its only consumer on this
  // screen is the mini-map's camera/user-dot, and ExploreMiniMap
  // subscribes to useUserLocation() itself — subscribing at the screen
  // root re-committed this whole tree (measured 240–280 ms) on every
  // watch fix, one JS-thread stall per 15 s at walking pace.
  const { pos, locationDenied } = useExploreRailsPosition();
  const posLat = pos?.lat;
  const posLon = pos?.lon;

  // ----- BTC Map merchants ------------------------------------------------

  // Seed from the in-memory mirror. The disk hydration that fills it is
  // kicked off the cold-start critical path (audit HIGH 1) — see
  // `kickPlacesHydration` in btcMapService, invoked from App.tsx after
  // first paint rather than at module import. The live fetch below
  // replaces this once `pos` lands.
  const [merchants, setMerchants] = useState<BtcMapPlace[]>(() => peekCachedPlacesSync());
  // If we already have cached merchants on first render there's no
  // skeleton to show — flip merchantsLoading false so the rail paints
  // them straight away instead of the loading shimmer.
  const [merchantsLoading, setMerchantsLoading] = useState(
    () => peekCachedPlacesSync().length === 0,
  );
  // Bumped by pull-to-refresh to invalidate the merchant + relay-sub
  // effects without disturbing `pos`. Lets us re-pull BTC Map + tear
  // down/re-open NIP-GC + NIP-52 subscriptions in one gesture.
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const {
    sortedCaches,
    events,
    cachesArr,
    cacheRailState,
    eventsArr,
    untrustedCacheCount,
    untrustedEventCount,
    setUntrustedCacheCount,
    setUntrustedEventCount,
  } = useExploreRelayContent(pos, refreshKey, maxDistanceMetres);
  // Mini-map pin-tap selections — open `MerchantDetailSheet` /
  // `CacheDetailSheet` (same components MapScreen uses) so the
  // interaction shape matches the full map. Events have no dedicated
  // sheet in MapScreen either, so they keep navigating directly to
  // EventDetail (consistent with MapScreen's behaviour). PR #630.
  const [selectedMerchant, setSelectedMerchant] = useState<BtcMapPlace | null>(null);
  const [selectedCache, setSelectedCache] = useState<ParsedCache | null>(null);
  // Map legend modal — same LegendSheet ExploreMiniMap renders inline,
  // but here it lives at the screen level so LibreMiniMap (which doesn't
  // own the sheet itself) can ask us to open it. Array memos for the
  // caches/events Maps live below their state declarations.
  const [legendVisible, setLegendVisible] = useState(false);
  const onTapMap = useCallback(() => navigation.navigate('Map'), [navigation]);
  const onOpenLegend = useCallback(() => setLegendVisible(true), []);
  // Stable handlers so a parent re-render (e.g. a DM-inbox flush bubbling
  // through useNostr()) doesn't hand ExploreMiniMap/ContentRail fresh function
  // identities each time — inline arrows defeat LibreMiniMap's arePropsEqual
  // memo (ExploreMiniMap renders LibreMiniMap when focused) and force a full
  // MapLibre marker reconciliation on every render (#798).
  const onSelectMerchant = useCallback((m: BtcMapPlace) => setSelectedMerchant(m), []);
  const onSelectCache = useCallback((c: ParsedCache) => setSelectedCache(c), []);
  const onSelectEvent = useCallback(
    (e: ParsedEvent) => navigation.navigate('EventDetail', { coord: e.coord }),
    [navigation],
  );
  const onSeeAllPlaces = useCallback(() => navigation.navigate('Places'), [navigation]);
  const onSeeAllHunt = useCallback(() => navigation.navigate('Hunt'), [navigation]);
  const onSeeAllEvents = useCallback(() => navigation.navigate('Events'), [navigation]);
  const onSeeAllMarket = useCallback(() => navigation.navigate('Market'), [navigation]);
  // Open the same in-app product detail as the full Market grid.
  const openMarketProduct = useCallback(
    (product: MarketProduct) => {
      navigation.navigate('MarketProductDetail', { productId: product.id, product });
    },
    [navigation],
  );
  const onSeeAllLessons = useCallback(() => navigation.navigate('Lessons'), [navigation]);
  const onCloseLegend = useCallback(() => setLegendVisible(false), []);
  // Stale-while-revalidate: `peekCachedPlacesSync()` already seeded
  // the initial `merchants` state above; the live fetch below replaces
  // it once `pos` lands. Previously this effect re-paint-from-cache via
  // the async `getCachedPlaces()` — that fired AFTER the first render,
  // so the rail flashed empty for the AsyncStorage round-trip on cold
  // launch even though the data was sitting on disk.
  //
  // The dep array uses `posBucket` instead of raw `pos` so GPS jitter
  // doesn't re-fire the effect. Raw `pos` updates on every Android
  // GPS sample (~1 Hz on a real device), each with a new object
  // identity even when the user is sitting still — that re-fired this
  // effect and stacked overlapping fetches on the JS thread. Bucketing
  // to ~3 decimals of lat/lon (~100 m ground resolution) means we only
  // refetch when the user has genuinely moved enough to matter.
  // setPos firing twice on mount (last-known then current position)
  // also gets coalesced when both samples round to the same bucket.
  const posBucket = useMemo(() => {
    if (!pos) return null;
    return `${pos.lat.toFixed(3)},${pos.lon.toFixed(3)}`;
  }, [pos]);
  useEffect(() => {
    if (!pos) return;
    let cancelled = false;
    (async () => {
      // Only show the loading shimmer when there's literally nothing to
      // paint. On cold start we already seed `merchants` from the
      // in-memory mirror; flipping to loading anyway means the user
      // stares at a shimmer for up to FETCH_TIMEOUT_MS even though the
      // rail could be showing the previous result. SWR painting beats
      // a perfect refresh every time on a slow network (#566).
      if (merchants.length === 0) setMerchantsLoading(true);
      try {
        const __t0 = performance.now();
        // Tiered nearest-N fetch — walks 25 → 100 → 500 km until ≥10
        // merchants come back. Bounded payload (~10-100 KB depending
        // on density) replaces the previous ±2° / ~220 km bbox call,
        // which pulled hundreds of merchants the hub never showed and
        // blocked the JS thread for seconds at a time (#31). The hub
        // mini-map intentionally diverges from PlacesScreen / MapScreen
        // here — both of those have a map the user actively pans, so
        // they keep the viewport-driven `fetchPlacesInBbox` path.
        // `force: refreshKey > 0` is belt-and-suspenders alongside
        // `refreshDataset()` wiping the cache before this effect re-runs
        // — explicit beats relying on side-effect ordering, so a future
        // refactor of refreshDataset can't silently regress pull-to-
        // refresh into a cache hit. (PR #628 Stev.ie audit.)
        const places = await fetchNearestPlaces(pos.lat, pos.lon, 10, {
          force: refreshKey > 0,
        });
        const __ms = Math.round(performance.now() - __t0);
        if (__ms > 200) {
          console.log(
            `[PerfBlock] ExploreHome fetchNearestPlaces: ${__ms}ms places=${places.length}`,
          );
        }
        if (!cancelled) setMerchants(places);
      } catch {
        // BTC Map outage shouldn't break the whole hub — empty rail.
      } finally {
        if (!cancelled) setMerchantsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // posBucket — not pos — is the trigger; see comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posBucket, refreshKey]);

  // Page-ready marker. Fires the first time the rail has content AND
  // we have a real-or-anchored position fix, which together is what
  // the user perceives as "Explore is loaded". perfPageReady itself
  // dedupes per tap so re-renders here don't re-emit.
  useEffect(() => {
    if (pos && merchants.length > 0) {
      perfPageReady('Explore', `${merchants.length} merchants`);
    }
  }, [pos, merchants.length]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    // Do NOT wipe the caches/events Maps — replaceable-event semantics
    // mean re-arrivals dedupe via createdAt, so an additive refresh is
    // strictly safer. Pre-fix the wipe killed the user's own listings
    // (added by the one-shot by-author fetch) every time they pulled
    // to refresh, because the nearby `#g` sub doesn't re-echo caches
    // outside the current geohash prefix on resubscribe.
    setUntrustedCacheCount(0);
    setUntrustedEventCount(0);
    try {
      // Force a network re-pull of the BTC Map dataset — recent boosts
      // / verifications won't show up until the 7-day TTL otherwise.
      await refreshDataset();
    } catch {
      // Refresh is best-effort; keep the existing rails on failure.
    }
    // Bumping refreshKey also re-runs the by-author fetch effect (see
    // its dep array below) so a freshly-edited / freshly-published
    // Piglet by the user surfaces even when it sits outside the nearby
    // geohash prefix.
    setRefreshKey((n) => n + 1);
    // Two-second floor on the spinner — relay subs trickle in
    // continuously, so there's no clean "done" signal. Long enough to
    // feel like work happened, short enough not to feel stuck.
    setTimeout(() => setRefreshing(false), 2000);
  }, [setUntrustedCacheCount, setUntrustedEventCount]);

  // ----- lessons progress (local) -----------------------------------------

  const [progress, setProgress] = useState<LearnProgress>({ completedMissions: [] });
  useFocusEffect(
    useCallback(() => {
      getProgress().then(setProgress);
    }, []),
  );

  // ----- derived rail data ------------------------------------------------
  //
  // Every rail is sorted by haversine distance from the user so the
  // nearest row sits leftmost. Items without a usable location land
  // at the end. We tag each entry with a `distance` number so the
  // card variants can render an "X km" badge without recomputing.

  // Sort memos depend on `posLat` / `posLon` rather than raw `pos` so a
  // fresh `{lat, lon, accuracy}` object with identical primitives no
  // longer re-runs the haversine sweep on every GPS sample (PR #628
  // Stev.ie audit). The early-return path uses both being numbers as
  // the truthiness check.
  const sortedMerchants = useMemo(() => {
    if (typeof posLat !== 'number' || typeof posLon !== 'number')
      return [] as { place: BtcMapPlace; distance: number }[];
    let items = merchants.map((place) => ({
      place,
      distance: haversineMetres({ lat: posLat, lon: posLon }, { lat: place.lat, lon: place.lon }),
    }));
    if (maxDistanceMetres !== null) {
      // Boosted/"Featured" merchants get a wider per-row cap so the user
      // sees paid placements even when their general radius is tight.
      // Max-wins: a user who's set the slider above 200 km keeps that.
      items = items.filter((m) => {
        const cap = isBoosted(m.place)
          ? Math.max(maxDistanceMetres, BOOSTED_RADIUS_METRES)
          : maxDistanceMetres;
        return m.distance <= cap;
      });
    }
    const byDistance = items.sort((a, b) => a.distance - b.distance);
    // Pin up to 3 boosted ("Featured") merchants to the front of the rail
    // even if a non-featured place is closer (BTC Map's paid-feature
    // mechanism); the rest follow in distance order. Each pinned card gets
    // a "Featured" badge so the user knows why it's prominent. Shared with
    // the full Places list via `orderFeaturedFirst` so the 3-featured cap
    // lives in one place.
    return orderFeaturedFirst(byDistance, (item) => isBoosted(item.place)).slice(0, 12);
  }, [merchants, posLat, posLon, maxDistanceMetres]);

  // Distinct merchant categories for the legend. Memoised so the
  // flatMap + Set + spread over all merchants doesn't run on every render
  // (and so LegendSheet gets a stable array reference) (#798).
  const availableCategories = useMemo(
    () => [...new Set(merchants.flatMap((m) => m.categories ?? []).filter(Boolean))],
    [merchants],
  );

  const sortedEvents = useMemo(() => {
    const haveFix = typeof posLat === 'number' && typeof posLon === 'number';
    // Re-apply future-only + prod test-account filters at render — a cached
    // PAST event hydrated from AsyncStorage bypasses the ingestion callback.
    const nowSec = Math.floor(Date.now() / 1000);
    let items = [...events.values()]
      .filter((event) => isFutureEvent(event, nowSec) && !isHiddenInProd(event.organiserPubkey))
      .map((event) => {
        const center = event.geohash ? decodeGeohash(event.geohash) : null;
        const distance =
          haveFix && center
            ? haversineMetres({ lat: posLat, lon: posLon }, { lat: center.lat, lon: center.lng })
            : Number.POSITIVE_INFINITY;
        return { event, distance };
      });
    // Keep events with no `g` tag (distance = ∞) — most NIP-52 publishers
    // (OrangePillApp etc.) don't include one, so dropping them would leave
    // the rail mostly empty even when legitimate Bitcoin meetups exist.
    // The sort below puts geohash-ed events first, then unlocated ones
    // tail-end. A future PR can split these into a separate "Events with
    // no location" rail (task #51); for now lumping them in is the right
    // trade-off.
    if (maxDistanceMetres !== null) {
      items = items.filter((e) => !Number.isFinite(e.distance) || e.distance <= maxDistanceMetres);
    }
    items.sort((a, b) => {
      const af = Number.isFinite(a.distance);
      const bf = Number.isFinite(b.distance);
      if (af !== bf) return af ? -1 : 1;
      return a.distance - b.distance;
    });
    return items.slice(0, 50);
  }, [events, posLat, posLon, maxDistanceMetres]);

  const marketProducts = usePreferredMarketSample();

  return (
    <View style={styles.container}>
      <View style={styles.headerBackground}>
        <BrandPatternBackground variant="explore-compass" />
        <TabHeader title="Explore" icon={<Compass size={20} color={colors.brandPink} />} />
        <View style={styles.headerExtras}>
          <Text style={styles.tagline}>Find your way around Bitcoin</Text>
        </View>
      </View>

      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={localStyles.scrollContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<BrandedRefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <ExploreMiniMap
          locationDenied={locationDenied}
          // One-shot cached anchor — the mini-map reads the LIVE position via
          // its own useUserLocation() subscription and uses this only until
          // the first live fix lands (see the perf note on ExploreMiniMap).
          fallbackAnchor={pos}
          merchants={merchants}
          caches={cachesArr}
          events={eventsArr}
          onTapMap={onTapMap}
          onOpenLegend={onOpenLegend}
          onSelectMerchant={onSelectMerchant}
          onSelectCache={onSelectCache}
          onSelectEvent={onSelectEvent}
        />

        <ContentRail<{ place: BtcMapPlace; distance: number }>
          title="Places near you"
          caption="Bitcoin-accepting merchants from BTC Map"
          items={sortedMerchants}
          loading={merchantsLoading && sortedMerchants.length === 0 && !!pos}
          // "See all" lands on the Places list (with map button in
          // its header); the dedicated Map view is one tap away.
          onSeeAll={onSeeAllPlaces}
          seeAllTestId="explore-card-map"
          keyExtractor={(p) => String(p.place.id)}
          emptyState={
            <Text style={localStyles.emptyText}>
              {pos
                ? 'No merchants in your immediate area — try the full Map for a wider view.'
                : 'Grant location to discover Bitcoin-accepting shops near you.'}
            </Text>
          }
          renderItem={({ place, distance }) => (
            <PlaceCard
              place={place}
              distance={distance}
              onPress={() => navigation.navigate('PlaceDetail', { placeId: place.id })}
              colors={colors}
              styles={localStyles}
            />
          )}
        />

        <ContentRail<{ cache: ParsedCache; distance: number }>
          title={t('geocacheRail.nearest')}
          titleTestId="explore-geocache-nearest-label"
          caption={
            untrustedCacheCount > 0
              ? `Piglets + classic NIP-GC caches · ${untrustedCacheCount} hidden from outside your trust graph`
              : 'Piglets + classic NIP-GC caches'
          }
          items={sortedCaches}
          loading={cacheRailState === 'loading'}
          // "See all" lands on the merged Geo-caches page (map + list
          // + [+] in header for the hider flow). Was a two-screen
          // Hunt/Discover split before the May 2026 UX merge.
          onSeeAll={onSeeAllHunt}
          seeAllTestId="explore-card-hunt"
          keyExtractor={(c) => c.cache.coord}
          emptyState={
            <GeocacheRailEmptyState
              state={cacheRailState}
              hiddenCount={untrustedCacheCount}
              onHide={() => navigation.navigate('HuntCreate')}
              onRetry={() => setRefreshKey((n) => n + 1)}
            />
          }
          renderItem={({ cache, distance }) => (
            <CacheCard
              cache={cache}
              distance={distance}
              onPress={() => navigation.navigate('HuntPiggyDetail', { coord: cache.coord })}
              colors={colors}
              styles={localStyles}
            />
          )}
        />

        <ContentRail<MarketProduct>
          title="Market"
          caption={t('market.screen.tagline')}
          items={marketProducts}
          onSeeAll={onSeeAllMarket}
          seeAllTestId="explore-card-market"
          keyExtractor={(p) => p.id}
          renderItem={(product) => {
            // Resolve the vendor once — `sellerOf` linearly scans
            // MARKET_VENDORS, so reuse it for both props (Copilot review on
            // #948).
            const vendor = sellerOf(product);
            return (
              <MarketProductCard
                product={product}
                sellerName={vendor?.name ?? product.sellerName}
                vendor={vendor}
                variant="rail"
                onPress={openMarketProduct}
                testID={`market-product-card-${product.id}`}
              />
            );
          }}
        />

        <ContentRail<{ event: ParsedEvent; distance: number }>
          title="Events near you"
          caption={
            // Subtitle drops the "within ~150 km" claim — we surface
            // events without `#g` geohash tags too (most NIP-52 publishers
            // don't include one), so we can't enforce that distance.
            // Each card shows the event's location string so the user
            // can read the city / venue and decide.
            untrustedEventCount > 0
              ? `Bitcoin meetups (NIP-52) · ${untrustedEventCount} hidden from outside your trust graph`
              : 'Bitcoin meetups (NIP-52)'
          }
          items={sortedEvents}
          loading={!!pos && events.size === 0 && false}
          onSeeAll={onSeeAllEvents}
          seeAllTestId="explore-card-events"
          keyExtractor={(e) => e.event.coord}
          emptyState={
            <Text style={localStyles.emptyText}>
              No upcoming meetups in your area on the NIP-52 feed right now.
            </Text>
          }
          renderItem={({ event, distance }) => (
            <ExploreEventCard
              locale={formatLocale}
              event={event}
              distance={distance}
              onPress={() => navigation.navigate('EventDetail', { coord: event.coord })}
              colors={colors}
              styles={localStyles}
            />
          )}
        />

        <ContentRail<Course>
          title="Lessons in progress"
          caption={`${progress.completedMissions.length} / ${courses.reduce((a, c) => a + c.missions.length, 0)} missions done`}
          items={courses}
          onSeeAll={onSeeAllLessons}
          seeAllTestId="explore-card-lessons"
          keyExtractor={(c) => c.id}
          renderItem={(course) => (
            <LessonCard
              course={course}
              progress={progress}
              onPress={() => navigation.navigate('CourseDetail', { courseId: course.id })}
              colors={colors}
              styles={localStyles}
            />
          )}
        />
      </ScrollView>
      {/* Map legend bottom sheet — shared by LibreMiniMap (no inline
          sheet) and used here so the (i) button has somewhere to go. The
          inline ExploreMiniMap path owns its own LegendSheet, so this
          one is harmless in both branches; opens only when the legend
          tap actually triggers setLegendVisible. */}
      <LegendSheet
        visible={legendVisible}
        onClose={onCloseLegend}
        placesVisible
        availableCategories={availableCategories}
      />
      {/* Mini-map pin-tap sheets — share the components with MapScreen
          so the interaction shape (drag-to-dismiss, tap-away, View
          details action) is identical across surfaces. PR #630. */}
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
      {selectedCache && (
        <CacheDetailSheet
          cache={selectedCache}
          colors={colors}
          onClose={() => setSelectedCache(null)}
          onViewDetails={() => {
            const coord = selectedCache.coord;
            setSelectedCache(null);
            navigation.navigate('HuntPiggyDetail', { coord });
          }}
        />
      )}
    </View>
  );
};

// -----------------------------------------------------------------------------
// rail card variants
// -----------------------------------------------------------------------------

const PlaceCard: React.FC<{
  place: BtcMapPlace;
  distance: number;
  onPress: () => void;
  colors: Palette;
  styles: ReturnType<typeof createExploreHomeRailStyles>;
}> = ({ place, distance, onPress, colors, styles }) => {
  const lightning = acceptsLightning(place);
  const lud16 = lightningAddressOf(place);
  const boosted = isBoosted(place);
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} testID={`place-card-${place.id}`}>
      {boosted ? (
        <View style={styles.cardFeaturedBadge} testID={`place-card-${place.id}-featured`}>
          <Sparkles size={10} color={colors.textHeader} strokeWidth={2.5} />
          <Text style={styles.cardFeaturedText}>Featured</Text>
        </View>
      ) : null}
      <View
        style={[styles.cardIcon, lightning ? styles.cardIconLightning : styles.cardIconOnchain]}
      >
        {/* Category icon (Coffee / UtensilsCrossed / Hotel / …) gives
            the user a what-is-this read at a glance. Pink (Lightning)
            / orange (on-chain) background carries the payment-type
            signal, matching how MerchantDetailSheet + PlacesScreen
            row already render. */}
        {(() => {
          const CategoryIcon = btcMapIconComponent(place.icon);
          return <CategoryIcon size={20} color={colors.white} strokeWidth={2.5} />;
        })()}
      </View>
      <Text style={styles.cardTitle} numberOfLines={2}>
        {place.tags.name ?? 'Unnamed merchant'}
      </Text>
      <Text style={styles.cardSub} numberOfLines={1}>
        {lightning ? '⚡ Lightning' : 'On-chain'}
        {Number.isFinite(distance) ? ` · ${formatDistance(distance)}` : ''}
      </Text>
      <Text style={styles.cardSubSmall} numberOfLines={1}>
        {lud16 ?? formatAddress(place)}
      </Text>
    </TouchableOpacity>
  );
};

const LessonCard: React.FC<{
  course: Course;
  progress: LearnProgress;
  onPress: () => void;
  colors: Palette;
  styles: ReturnType<typeof createExploreHomeRailStyles>;
}> = ({ course, progress, onPress, colors, styles }) => {
  const completed = getCourseCompletedCount(
    progress,
    course.missions.map((m) => m.id),
  );
  const total = course.missions.length;
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} testID={`lesson-card-${course.id}`}>
      <Image source={course.image} style={styles.cardThumb} resizeMode="cover" />
      <Text style={styles.cardTitle} numberOfLines={2}>
        {course.title}
      </Text>
      <Text style={styles.cardSub} numberOfLines={1}>
        {completed}/{total} missions
      </Text>
      {completed === total ? (
        <Text style={[styles.cardSubSmall, { color: colors.green }]} numberOfLines={1}>
          ✓ Complete
        </Text>
      ) : (
        <Text style={styles.cardSubSmall} numberOfLines={1}>
          <ChevronRight size={11} color={colors.brandPink} /> Continue
        </Text>
      )}
    </TouchableOpacity>
  );
};

// React.Profiler wrapper — see HomeScreen for the rationale (#560).
// Explore is the screen Ben saw the 24-57 s freezes on; this surfaces
// the render-commit cost so we can finally see whether the freezes are
// React work (Profiler fires) or something else (silent).
const ProfiledExploreHomeScreen: React.FC<Props> = (props) => (
  <React.Profiler
    id="ExploreHomeScreen"
    onRender={(id, phase, actualDuration) => {
      if (actualDuration > 100) {
        console.log(`[PerfBlock] render:${id} ${phase}=${Math.round(actualDuration)}ms`);
      }
    }}
  >
    <ExploreHomeScreen {...props} />
  </React.Profiler>
);

export default ProfiledExploreHomeScreen;
