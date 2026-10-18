import { useAppRelayPrefs } from '../hooks/useAppRelayPrefs';
import { createHuntScreenStyles as createStyles } from '../styles/HuntScreen.styles';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { ChevronLeft, PiggyBank } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useTrustGraph } from '../contexts/TrustGraphContext';
import HuntFilterSheet, { countActiveFilters } from '../components/HuntFilterSheet';
import { ExploreNavigation } from '../navigation/types';
import BrandPatternBackground from '../components/BrandPatternBackground';
import { LibreMiniMap } from '../components/LibreMiniMap';
import { CacheDetailSheet } from '../components/CacheDetailSheet';
import HuntCommunitySections from '../components/HuntCommunitySections';
import HuntNearbySection from '../components/HuntNearbySection';
import { useUserLocation } from '../contexts/UserLocationContext';
import LegendSheet from '../components/LegendSheet';
import { type ParsedCache } from '../services/nostrPlacesService';
import { fetchCachesByAuthor, subscribeNearbyCaches } from '../services/nostrPlacesPublisher';
import { useNostr } from '../contexts/NostrContext';
import { loadCachedCaches, peekCachedCachesSync, saveCaches } from '../services/nostrPlacesStorage';
import { decodeGeohash, encodeGeohash, geohashNeighbours, haversineMetres } from '../utils/geohash';
import { useCoalescedMap } from '../utils/useCoalescedMap';
import { isHiddenInProd, stripHiddenForPersist } from '../utils/exploreContentFilter';

interface Props {
  navigation: ExploreNavigation;
}

// Stable empty-array reference for the outer FlatList's `data` — every row
// this screen renders (map, Nearby rail, community rails) lives in
// `ListHeaderComponent` instead, so there's nothing to virtualize at the
// list-item level. A module-level constant (vs. an inline `[]` literal)
// avoids handing FlatList a new array identity every render.
const EMPTY_DATA: never[] = [];

/**
 * **Geo-caches** sub-screen — single-purpose discovery + creation
 * page for NIP-GC caches (Piglets + standard NIP-GC). Per UX
 * feedback (May 2026), the prior "Hunt hub" + "Discover" two-screen
 * split was collapsed into this one: a mini-map at the top, a `+`
 * button in the header that opens the create flow, and a list of
 * nearby caches below sorted by distance with a search field.
 *
 * Most users find caches; a small fraction create them. Putting
 * "Hide a Piglet" behind the `+` icon (instead of a full secondary
 * card) keeps the page focused on the common case.
 */
const HuntScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const relayScope = useAppRelayPrefs();
  const { pubkey, relays, profile } = useNostr();
  const [pos, setPos] = useState<{ lat: number; lon: number; accuracy: number | null } | null>(
    null,
  );
  // Live position for the user dot — refreshes as the user walks
  // around without re-firing the nearby-cache subscription (which is
  // keyed on the initial `pos`).
  const { pos: livePos, denied: locationDenied } = useUserLocation();
  // Coalesce per-event setState bursts during the nearby-cache relay
  // backfill into one commit per ~100 ms window (audit MED 4) — the
  // naive `new Map(prev)` clone per event was O(N²) over a 50+ event
  // cold-start burst. `shouldReplace` keeps the newest revision of a
  // replaceable cache (and is re-applied in the flush against committed
  // state, so a stale wrap can't clobber a fresher one). `enqueue` feeds
  // the relay sub; `setCaches` covers the hydrate / refresh / by-author
  // paths that aren't hot.
  const {
    map: caches,
    setMap: setCaches,
    enqueue: enqueueCache,
    flush: flushCaches,
  } = useCoalescedMap<ParsedCache>({
    initial: () => new Map(peekCachedCachesSync().map((c) => [c.coord, c])),
    shouldReplace: (existing, incoming) => incoming.createdAt > existing.createdAt,
  });
  // Pull-to-refresh: re-load the on-disk cache AND query relays for
  // every kind 37516 listing by the signed-in user, so the rail
  // includes the user's own historical Piggies even if the nearby
  // subscription never echoed them back (same gap MyPiglets covers).
  const [refreshing, setRefreshing] = useState(false);
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // Hard 8 s ceiling — even if fetchCachesByAuthor / loadCachedCaches
    // hang somehow, the spinner clears so the user isn't blocked from
    // tapping elsewhere on the page. fetchCachesByAuthor already has a
    // 5 s maxWait but disk IO / device sleep can still stretch the
    // wall-clock. Pre-fix Ben hit a state where pull-to-refresh
    // appeared to block navigation entirely.
    const safetyTimer = setTimeout(() => setRefreshing(false), 8000);
    try {
      const readRelays = relays.filter((r) => r.read).map((r) => r.url);
      const [cached, mine] = await Promise.all([
        loadCachedCaches(),
        pubkey
          ? fetchCachesByAuthor(pubkey, readRelays.length > 0 ? readRelays : undefined).catch(
              () => [] as ParsedCache[],
            )
          : Promise.resolve([] as ParsedCache[]),
      ]);
      setCaches((prev) => {
        const next = new Map(prev);
        for (const c of cached) {
          const existing = next.get(c.coord);
          if (!existing || c.createdAt > existing.createdAt) next.set(c.coord, c);
        }
        for (const c of mine) {
          const existing = next.get(c.coord);
          if (!existing || c.createdAt > existing.createdAt) next.set(c.coord, c);
        }
        return next;
      });
    } finally {
      clearTimeout(safetyTimer);
      setRefreshing(false);
    }
  }, [pubkey, relays, setCaches]);

  // Hydrate from AsyncStorage so the list paints instantly on cold
  // start while the live relay sub backfills.
  useEffect(() => {
    let cancelled = false;
    loadCachedCaches().then((cs) => {
      if (cancelled || cs.length === 0) return;
      setCaches((prev) => {
        if (prev.size > 0) return prev;
        const m = new Map<string, ParsedCache>();
        for (const c of cs) m.set(c.coord, c);
        return m;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [setCaches]);
  // Write-through (debounced) so the next cold start has fresh data.
  useEffect(() => {
    if (caches.size === 0) return;
    const persistTimer = setTimeout(
      // Strip prod-hidden (test-account) Piglets before persisting so prod
      // caches self-heal — stale Piggy entries age out of storage instead
      // of being re-saved forever (matches ExploreHomeScreen) (#917).
      () => saveCaches(stripHiddenForPersist([...caches.values()], (c) => c.hiderPubkey)),
      1500,
    );
    return () => clearTimeout(persistTimer);
  }, [caches]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);

  // Web-of-trust filter. `isTrusted` is tier-aware (short-circuits to
  // true for the 'all' tier) and is applied at render time in
  // `sortedCaches`, so flipping the tier re-filters instantly.
  const { isTrusted, wotTier } = useTrustGraph();
  // NIP-GC difficulty / terrain are integer 1-5 scales (geocaching
  // convention). Multi-select Sets so a user can pick e.g. D1 + D3
  // (skip the cunning level in the middle). Empty Set = no filter.
  const [selectedDifficulties, setSelectedDifficulties] = useState<Set<number>>(new Set());
  const [selectedTerrains, setSelectedTerrains] = useState<Set<number>>(new Set());
  // Whether the bottom-sheet filter UI is open.
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const [legendVisible, setLegendVisible] = useState(false);
  // Mini-map pin-tap → opens the shared `CacheDetailSheet`, same UX
  // as the Explore mini-map + the full MapScreen. PR #630 follow-up.
  const [selectedCache, setSelectedCache] = useState<ParsedCache | null>(null);
  // Map-touch tracking removed when the map moved out of the
  // FlatList header (commit eedd82e follow-up). Map and list are now
  // siblings, so touches on the map don't reach the FlatList at all.
  // Cache type filter — empty set = show every type (default). Built
  // dynamically from whatever types are present in the current caches
  // dataset; selected entries OR together so the list doesn't filter
  // to zero when a hider uses an unusual cache type.
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());

  // Seed the subscription anchor from the first live fix. `pos` is a
  // capture-once anchor — deliberately NOT updated as the user walks —
  // so `subscribeNearbyCaches` queries a stable set of geohash tiles
  // instead of re-subscribing on every GPS step. `useUserLocation`
  // already runs the foreground-permission check and delivers a fix
  // (warm, via `getLastKnownPositionAsync`) carrying the same
  // `accuracy` field, so deriving the anchor from `livePos` here avoids
  // a second, redundant high-accuracy `getCurrentPositionAsync` native
  // call on every HuntScreen mount (perf audit: duplicate GPS bridge
  // call during the cold-start window). A precision-5 geohash tile + 8
  // neighbours (~15 km of coverage) easily absorbs the small staleness
  // of a last-known anchor.
  useEffect(() => {
    if (pos || !livePos) return;
    setPos({ lat: livePos.lat, lon: livePos.lon, accuracy: livePos.accuracy });
  }, [livePos, pos]);

  // Drop the spinner when location permission is denied. Without a fix
  // we never seed `pos`, so the subscribe-settle timer below never arms
  // — the spinner would otherwise hang forever on a denied device.
  useEffect(() => {
    if (locationDenied) setLoading(false);
  }, [locationDenied]);

  // Backstop: `useLiveUserLocation` swallows GPS errors WITHOUT flipping
  // `denied` (e.g. permission granted but no last-known fix and both
  // getCurrentPositionAsync/watchPositionAsync reject). In that case
  // `pos` is never seeded and the subscribe-settle timer never arms, so
  // the spinner would hang on "Looking for geo-caches near you…"
  // forever. Mirror the resilience of the old getCurrentPositionAsync
  // catch path: after a few seconds without a fix, drop the spinner so
  // the empty state shows. Cleared early on the happy path (pos seeded →
  // settle timer fires at ~1.5 s) — this only ever fires on the failure
  // path.
  useEffect(() => {
    if (pos) return;
    const settleTimer = setTimeout(() => setLoading(false), 10_000);
    return () => clearTimeout(settleTimer);
  }, [pos]);

  // Cache subscription — kicks off once we have a fix, but only while
  // the screen is focused (audit MED 3). With `freezeOnBlur: true` on
  // the tab navigator the Explore stack screens never unmount, so a
  // bare `useEffect` left this relay sub streaming forever after the
  // first visit. `useFocusEffect` opens it on focus and closes it on
  // blur; the next focus re-opens (cheap — the SimplePool reuses the
  // socket). `pos` is read inside via a ref-free closure because the
  // focus callback re-runs whenever `pos` changes anyway (it's in deps).
  useFocusEffect(
    useCallback(() => {
      if (!pos) return;
      // 9 prefixes (user's precision-5 tile + 8 neighbours) so caches
      // hidden in adjacent ~5 km tiles surface too. The Explore mini-map
      // got the same treatment earlier in this branch. Pre-#631 the
      // previous `geohashPrefixes(...).filter((p) => p.length === 5)`
      // returned only the user's own truncation, so a cache 500 m across
      // a tile boundary stayed invisible.
      const prefixes = geohashNeighbours(encodeGeohash(pos.lat, pos.lon, 5));
      // Load every nearby cache regardless of trust — the WoT filter is
      // applied at render time (sortedCaches), so flipping the tier
      // re-filters instantly with no re-subscribe or relay round-trip.
      // Per-event work is just the coalescing enqueue (staleness drop +
      // newest-wins live in the hook's `shouldReplace`).
      const closer = subscribeNearbyCaches(prefixes, (c) => {
        // Drop test-account Piglets in production at ingestion so they never
        // enter the Map (and so can't reach the rail, mini-map, or persist).
        // No-op in dev/preview. Mirrors ExploreHomeScreen's discover guard (#917).
        if (isHiddenInProd(c.hiderPubkey)) return;
        enqueueCache(c.coord, c);
      });
      // Drop the spinner after a beat — relays stream continuously, no EOSE wait.
      const settleTimer = setTimeout(() => setLoading(false), 1500);
      return () => {
        closer();
        clearTimeout(settleTimer);
        // Drain the tail of the burst so events that arrived just before
        // blur aren't stranded in the pending buffer until next focus.
        flushCaches();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- The subscription reads app relay preferences.
    }, [pos, enqueueCache, flushCaches, relayScope]),
  );

  const sortedCaches = useMemo(() => {
    let items = [...caches.values()].map((cache) => {
      const center = cache.geohash ? decodeGeohash(cache.geohash) : null;
      const distance =
        pos && center
          ? haversineMetres({ lat: pos.lat, lon: pos.lon }, { lat: center.lat, lon: center.lng })
          : Number.POSITIVE_INFINITY;
      return { cache, distance };
    });
    items.sort((a, b) => a.distance - b.distance);
    // Drop NIP-40-expired caches — relays that don't honour expiration
    // keep serving them, so the client filters them out here.
    const nowSec = Date.now() / 1000;
    items = items.filter(({ cache }) => cache.expiresAt === null || cache.expiresAt > nowSec);
    if (selectedDifficulties.size > 0) {
      // A cache with no difficulty tag is treated as "1" — typical
      // hider convention for a trivial walk-up; otherwise filtering
      // would silently drop legitimate easy caches.
      items = items.filter(({ cache }) => selectedDifficulties.has(cache.difficulty ?? 1));
    }
    if (selectedTerrains.size > 0) {
      items = items.filter(({ cache }) => selectedTerrains.has(cache.terrain ?? 1));
    }
    if (selectedTypes.size > 0) {
      items = items.filter(({ cache }) =>
        cache.cacheType ? selectedTypes.has(cache.cacheType) : false,
      );
    }
    // Web-of-trust filter — drop caches from hiders outside the active
    // tier's trust graph. `isTrusted` short-circuits to true for 'all'.
    items = items.filter(({ cache }) => isTrusted(cache.hiderPubkey));
    // Re-apply the prod test-account hide at render — cold-start caches
    // hydrated from AsyncStorage bypass the ingestion guard above, so a
    // stale Piggy entry could otherwise still paint here. No-op in
    // dev/preview (mirrors ExploreHomeScreen's sortedCaches) (#917).
    items = items.filter(({ cache }) => !isHiddenInProd(cache.hiderPubkey));
    return items;
  }, [caches, pos, selectedDifficulties, selectedTerrains, selectedTypes, isTrusted]);

  const activeFilterCount = useMemo(
    () =>
      countActiveFilters({
        selectedDifficulties,
        selectedTerrains,
        selectedTypes,
        wotTier,
      }),
    [selectedDifficulties, selectedTerrains, selectedTypes, wotTier],
  );

  const availableTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const c of caches.values()) if (c.cacheType) seen.add(c.cacheType);
    return [...seen].sort();
  }, [caches]);

  // Count of loaded caches the WoT filter is hiding — 0 for the 'all'
  // tier. Recomputes on tier change so the "n hidden" line stays
  // accurate without a re-subscribe.
  const wotHiddenCount = useMemo(
    () => [...caches.values()].filter((c) => !isTrusted(c.hiderPubkey)).length,
    [caches, isTrusted],
  );

  // Anchor for the "Recently added" rail's distance labels — prefer the
  // live fix, fall back to the capture-once subscription anchor.
  const communityPos = useMemo(() => {
    if (livePos) return { lat: livePos.lat, lon: livePos.lon };
    if (pos) return { lat: pos.lat, lon: pos.lon };
    return null;
  }, [livePos, pos]);

  const filteredCaches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return sortedCaches;
    return sortedCaches.filter(({ cache }) => {
      const hay = [cache.name, cache.description, cache.cacheType ?? '', cache.size ?? '']
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }, [sortedCaches, searchQuery]);

  return (
    <View style={styles.container} testID="geocaches-screen">
      <View style={styles.header}>
        <BrandPatternBackground variant="explore-compass" />
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            accessibilityLabel={t('huntScreen.backToExplore')}
            testID="hunt-back-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('huntScreen.geocaches')}</Text>
          <TouchableOpacity
            onPress={() => navigation.navigate('MyPiglets')}
            accessibilityLabel={t('huntScreen.myPiglets')}
            testID="hunt-my-piglets-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <PiggyBank size={22} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTagline}>{t('huntScreen.tagline')}</Text>
      </View>

      {/* Outer container is a FlatList (not a ScrollView) with no row data of
          its own — everything lives in ListHeaderComponent below — so the
          horizontal rails inside HuntNearbySection / HuntCommunitySections
          stay virtualized. Nesting those FlatLists inside a plain ScrollView
          would trip RN's "VirtualizedLists should never be nested inside
          plain ScrollViews" warning and disable their windowing; a FlatList
          parent with ListHeaderComponent is the same pattern PlacesScreen
          and the map-scrolls-with-content commit (#1044) already use.
          `data={EMPTY_DATA}` + `renderItem={null}` is the "single dummy
          item" shape Copilot's review suggested, minus the dummy item —
          ListHeaderComponent renders regardless of `data.length`, so an
          empty array is enough. */}
      <FlatList
        data={EMPTY_DATA}
        renderItem={null}
        contentContainerStyle={styles.scrollContent}
        testID="hunt-screen-scroll"
        keyboardShouldPersistTaps="handled"
        refreshControl={<BrandedRefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        ListHeaderComponent={
          <>
            {/* Mini-map scrolls with the content — same pattern as
                PlacesScreen. MapLibre is native so vertical pans on the map are
                consumed by the map's gesture recogniser before they reach the
                FlatList's RefreshControl, meaning the old pull-to-refresh race
                (issue #570, WebView era) no longer applies. LibreMiniMap carries
                its own marginHorizontal: 16 so the map lands at a 16 dp inset
                without any additional offset here. Passes `filteredCaches` so the
                map pins match the rail visually (#19). */}
            <View style={styles.miniMapContainer}>
              <LibreMiniMap
                // Mini-map follows GPS — camera anchor should track live
                // position, not the stale one-shot fetch `pos`.
                lat={livePos?.lat ?? pos?.lat ?? null}
                lon={livePos?.lon ?? pos?.lon ?? null}
                userLat={livePos?.lat ?? null}
                userLon={livePos?.lon ?? null}
                userAvatarUri={profile?.picture ?? null}
                // Only fall back to the initial-fetch accuracy when there's
                // no live fix yet; once livePos exists, trust its accuracy
                // (including null) so we never render a halo around live
                // coords with stale accuracy.
                userAccuracyMetres={livePos ? livePos.accuracy : (pos?.accuracy ?? null)}
                merchants={[]}
                caches={filteredCaches.map((c) => c.cache)}
                events={[]}
                onTapMap={() => navigation.navigate('Map')}
                onSelectCache={(c) => setSelectedCache(c)}
                onOpenLegend={() => setLegendVisible(true)}
                // One zoom level wider than the default 13 so the Geo-caches
                // hub map shows a bigger catchment without the user having to
                // pinch-zoom out.
                defaultZoom={12}
              />
            </View>
            {/* Nearby rail directly under the map — what's around you is the
                page's primary question, and the map pins + rail cards answer it
                as one unit (the search field scopes both). */}
            <HuntNearbySection
              items={filteredCaches}
              loading={loading}
              pos={communityPos}
              searchQuery={searchQuery}
              onChangeSearch={setSearchQuery}
              activeFilterCount={activeFilterCount}
              onOpenFilters={() => setFilterSheetOpen(true)}
              onPressCache={(coord) => navigation.navigate('HuntPiggyDetail', { coord })}
            />
            {/* Community engagement rails + leaderboard link — below the nearby
                rail so discovery isn't limited to whatever happens to be within
                ~5 km. */}
            <HuntCommunitySections
              pos={communityPos}
              onPressCache={(coord) => navigation.navigate('HuntPiggyDetail', { coord })}
              navigation={navigation}
            />
          </>
        }
      />
      <HuntFilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        selectedDifficulties={selectedDifficulties}
        onChangeDifficulties={setSelectedDifficulties}
        selectedTerrains={selectedTerrains}
        onChangeTerrains={setSelectedTerrains}
        availableTypes={availableTypes}
        selectedTypes={selectedTypes}
        onChangeTypes={setSelectedTypes}
        wotUntrustedHidden={wotHiddenCount}
        onClearAll={() => {
          setSelectedDifficulties(new Set());
          setSelectedTerrains(new Set());
          setSelectedTypes(new Set());
          // WoT tier reset is intentionally not bundled here — the user
          // controls it via the bottom-sheet picker so "Clear all" stays
          // a filter-only action, not a safety-affecting one.
        }}
      />
      {/* Map-legend sheet — no merchants on the Geo-caches surface, so
          the categories section is suppressed and the sheet just lists
          the Piglet / NIP-GC cache / user pin types. */}
      <LegendSheet
        visible={legendVisible}
        onClose={() => setLegendVisible(false)}
        placesVisible={false}
        availableCategories={[]}
      />
      {/* Mini-map pin-tap sheet — same component MapScreen +
          ExploreHomeScreen use so the interaction shape is identical
          across every map surface. PR #630 follow-up. */}
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

export default HuntScreen;
