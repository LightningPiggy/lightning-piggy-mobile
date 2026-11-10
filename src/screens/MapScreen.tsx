import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  Animated,
  PanResponder,
  Dimensions,
  InteractionManager,
} from 'react-native';
import * as Location from 'expo-location';
import { ChevronLeft, MapPin, PiggyBank, SlidersHorizontal } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTrustGraph } from '../contexts/TrustGraphContext';
import type { Palette } from '../styles/palettes';
import { createMapScreenStyles, type MapScreenStyles } from '../styles/MapScreen.styles';
import { ExploreNavigation, RootNavigation, ExploreStackParamList } from '../navigation/types';
import type { CompositeNavigationProp, RouteProp } from '@react-navigation/native';
import {
  Bbox,
  BtcMapPlace,
  fetchPlacesInBbox,
  peekCachedPlacesSync,
} from '../services/btcMapService';
import type { ParsedCache } from '../services/nostrPlacesService';
import { useCoalescedMap } from '../utils/useCoalescedMap';
import { useMapAuthorCaches } from '../hooks/useMapAuthorCaches';
import { useMapPins } from '../hooks/useMapPins';
import { useDebouncedMapBounds } from '../hooks/useDebouncedMapBounds';
import { useNearbyCacheSubscription } from '../hooks/useNearbyCacheSubscription';
import { bboxCentre } from '../utils/mapPins';
import { useNostr } from '../contexts/NostrContext';
import { encodeGeohash, geohashNeighbours, geohashPrefixesForBbox } from '../utils/geohash';
import { MerchantDetailSheet } from '../components/MerchantDetailSheet';
import WebOfTrustChip from '../components/WebOfTrustChip';
import WebOfTrustBottomSheet from '../components/WebOfTrustBottomSheet';
import LegendSheet from '../components/LegendSheet';
import { LibreMiniMap } from '../components/LibreMiniMap';
import { useUserLocation } from '../contexts/UserLocationContext';
import { useFriendsLiveLocations } from '../hooks/useFriendsLiveLocations';
import { useIsFocused } from '@react-navigation/native';
import { useTranslation } from '../contexts/LocaleContext';
import { t } from '../i18n';

interface Props {
  // Composite so the back handler can return to the DM (`Conversation` is a
  // RootStack screen) when the Map is opened from a live-location card.
  navigation: CompositeNavigationProp<ExploreNavigation, RootNavigation>;
  route: RouteProp<ExploreStackParamList, 'Map'>;
}

type PermissionState = 'unknown' | 'granted' | 'denied';

/**
 * Map sub-screen — discovers Bitcoin-accepting merchants near the user via
 * the BTC Map API (OSM-backed). Closes the foreground-browse part of #467;
 * the background-geofence + notifications part lands in milestone 3.
 *
 * Renderer is native MapLibre via the shared LibreMiniMap component (no
 * Google Maps, no API key, OSM tiles streamed from openstreetmap.org).
 */
const MapScreen: React.FC<Props> = ({ navigation, route }) => {
  const t = useTranslation();
  const colors = useThemeColors();
  // Tier-aware predicate from the Web-of-Trust context. `isTrusted`
  // already encodes the current wotTier (Friends / FoF / All), so
  // flipping the tier in the filter sheet re-runs the effect that
  // pushes cache pins to the WebView and the unwanted authors drop
  // off the map immediately. Mirrors the same fix HuntScreen got in
  // 306270c — the full map was the last surface still showing every
  // cache regardless of trust.
  const { isTrusted, wotTier } = useTrustGraph();
  const { pubkey: signedInPubkey, relays: userRelays, profile } = useNostr();
  // Friends currently sharing their live location with me — plotted as
  // circular avatar chips. Gated on screen focus so the underlying
  // kind-20069 ping subscriptions go quiet when a detail sheet/screen
  // covers the map or we navigate away (no background battery cost).
  const isFocused = useIsFocused();
  // Defer enabling the live-location subscription until the tab transition
  // settles (#824) — its backlog replay otherwise lands as a second setState
  // burst that competes with the navigation animation. Disables on blur.
  const [friendsEnabled, setFriendsEnabled] = useState(false);
  useEffect(() => {
    if (!isFocused) {
      setFriendsEnabled(false);
      return;
    }
    const task = InteractionManager.runAfterInteractions(() => setFriendsEnabled(true));
    return () => task.cancel();
  }, [isFocused]);
  const friends = useFriendsLiveLocations({ enabled: friendsEnabled });
  const friendMarkers = useMemo(
    () => friends.map((f) => ({ key: f.pubkey, lat: f.lat, lon: f.lon, avatarUri: f.avatarUri })),
    [friends],
  );
  // WoT bottom-sheet visibility — opened from the chip inside the
  // FilterSheet so the user can change tier without leaving the map.
  const [wotSheetVisible, setWotSheetVisible] = useState(false);
  // Legend bottom-sheet — opened from the new Legend button next to
  // Recenter at the map's bottom-left. Replaces the inline legend
  // strip that used to sit under the map and ate vertical space.
  const [legendVisible, setLegendVisible] = useState(false);
  const styles = useMemo(() => createMapScreenStyles(colors), [colors]);

  // The full-screen map looks cramped under the bottom tab bar, and the
  // tabs steal vertical space from the WebView. Hide them while we're
  // on this screen and restore on unmount. Per react-navigation v6 docs:
  // walk up to the parent Tab.Navigator and set tabBarStyle dynamically.
  useLayoutEffect(() => {
    const parent = navigation.getParent();
    parent?.setOptions({ tabBarStyle: { display: 'none' } });
    return () => {
      parent?.setOptions({ tabBarStyle: undefined });
    };
  }, [navigation]);

  const [permission, setPermission] = useState<PermissionState>('unknown');
  // User position state — kept here so LibreMiniMap (interactive full-
  // screen variant) can render the GPS dot + accuracy halo. The WebView
  // path reads via injectJavaScript on resolve; the LibreMiniMap path
  // reads declaratively from this state.
  const [pos, setPos] = useState<{ lat: number; lon: number; accuracy: number | null } | null>(
    null,
  );
  // Live position for the user dot — refreshes as the user walks
  // around without re-centring the map (the camera stays anchored to
  // the user's initial pos so panning behaviour isn't fighting GPS).
  const { pos: livePos } = useUserLocation();
  // Seed synchronously from the warm BTC Map cache (#823) so the map paints
  // pins on the first frame instead of a blank map until the viewport fetch
  // returns — matches ExploreHomeScreen/PlacesScreen. The bbox fetch below
  // then refreshes them (stale-while-revalidate).
  const [places, setPlaces] = useState<BtcMapPlace[]>(() => peekCachedPlacesSync());
  // Coalesced (#824): a relay backlog flushed on (re)focus commits as ONE
  // setState per flush window instead of one Map-clone + render per event —
  // the per-event burst that froze the tab transition. `shouldReplace` keeps
  // the newest entry per coord (same rule the inline merges used).
  const caches = useCoalescedMap<ParsedCache>({
    shouldReplace: (existing, incoming) => incoming.createdAt > existing.createdAt,
  });
  const [selected, setSelected] = useState<BtcMapPlace | null>(null);
  const [selectedCache, setSelectedCache] = useState<ParsedCache | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Default: every pin type visible. The filter sheet flips these
  // independently so users can isolate (say) just Piglets near them.
  const [filters, setFilters] = useState({
    lightning: true,
    onchain: true,
    piglet: true,
    nipgcCache: true,
  });
  // BTC Map category filter — empty set means "show every category"
  // (default). Adding a category to the set narrows to just those.
  // Multiple categories OR together (intersection semantics would
  // filter most merchants out since each has 0-2 categories).
  const [categoryFilter, setCategoryFilter] = useState<Set<string>>(new Set());
  // Viewport-keyed nearby-caches subscription (#1065; closed on unmount).
  const { resubscribeForPrefixes } = useNearbyCacheSubscription({
    enqueue: caches.enqueue,
    flush: caches.flush,
  });
  const [error, setError] = useState<string | null>(null);

  // ------- permissions + initial position --------------------------------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== 'granted') {
        setPermission('denied');
        return;
      }
      setPermission('granted');
      let lat: number;
      let lon: number;
      let accuracy: number | null = null;
      // Prefer the cached position from UserLocationContext when it's
      // already populated (the user just came from Explore / Hunt etc.,
      // so the shared watch has a recent fix). Running a second
      // independent getCurrentPositionAsync here used to race the
      // shared watch and snap the camera to a different, sometimes
      // less-accurate point. The dot stays live via `livePos` below.
      if (livePos !== null) {
        lat = livePos.lat;
        lon = livePos.lon;
        accuracy = livePos.accuracy;
      } else {
        try {
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
          });
          if (cancelled) return;
          lat = pos.coords.latitude;
          lon = pos.coords.longitude;
          accuracy = typeof pos.coords.accuracy === 'number' ? pos.coords.accuracy : null;
        } catch (e) {
          if (!cancelled) setError((e as Error).message);
          return;
        }
      }
      try {
        if (cancelled) return;
        // Mirror lat/lon/accuracy into state so the LibreMiniMap path
        // can render the GPS dot + accuracy halo. WebView path keeps
        // using its injectJavaScript flow below.
        setPos({ lat, lon, accuracy });
        // Wider initial bbox + lower default zoom so rural users (no
        // Bitcoin merchants within walking distance) see at least a
        // few drive-away pins on first paint. They can zoom in from
        // here; Leaflet refetches on `moveend`/`zoomend` via the
        // bounds bridge.
        // Queue the viewport BEFORE awaiting BTC Map — the WebView
        // bridge fires `ready` in parallel with the (potentially slow)
        // merchant fetch, and we want the map centred on the user
        // regardless of whether the BTC-merchant query has come back.
        //
        // If we already hydrated a saved viewport, prefer it over the
        // fresh GPS centre — the user explicitly chose that pan/zoom
        // last session and snapping them back to "where you are" feels
        // hostile. We still drop a `me` marker at GPS so they know
        // where they are; the recentre button + recenterOnUser puts
        // them back on themselves on demand.
        // LibreMiniMap fires onRegionDidChange shortly after mount with
        // its actual viewport — that bounds-driven fetch is now the
        // single source of truth for the visible-merchants set. (The
        // previous WebView path used to fetch the wider init bbox here
        // because Leaflet's first `bounds` message coincided with
        // `ready`; with native MapLibre the bounds event fires
        // separately so we just let it lead.)

        // Subscribe to NIP-GC kind 37516 caches in the user's coarse
        // geohash neighbourhood. Renders Lightning Piggies (com.lightningpiggy.app
        // label) AND standard NIP-GC caches (treasures.to /
        // TapTheSatsMap / etc.) as a different pin glyph alongside
        // BTC Map merchants. See project memory `treasures.to interop`.
        // 9-tile neighbourhood at precision 5 so boundary-adjacent caches
        // still match (#631); re-keyed per viewport by onLibreBounds (#1065).
        resubscribeForPrefixes(geohashNeighbours(encodeGeohash(lat, lon, 5)));
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch our own listings on return from Edit, including Piglets moved
  // outside the viewport's geohash subscription (#625).
  useMapAuthorCaches({
    pubkey: signedInPubkey,
    relays: userRelays,
    enqueue: caches.enqueue,
    flush: caches.flush,
  });

  // Distinct categories across the currently-loaded places — fed into
  // the FilterSheet so the available chips reflect what's actually on
  // the map right now (rather than BTC Map's whole taxonomy).
  const availableCategories = useMemo(() => {
    const seen = new Set<string>();
    for (const p of places) for (const c of p.categories ?? []) seen.add(c);
    return [...seen].sort();
  }, [places]);

  // Cap viewport as state, not a ref — see the viewportCentre note in
  // useMapPins. Until the first bounds event the centre is seeded from the
  // GPS fix so the cache-seeded `places` cap keeps the nearest, not an
  // arbitrary slice (#1068 review).
  const [viewportBbox, setViewportBbox] = useState<Bbox | null>(null);
  const viewportCentre = useMemo(
    () => (viewportBbox ? bboxCentre(viewportBbox) : pos ? { lat: pos.lat, lon: pos.lon } : null),
    [viewportBbox, pos],
  );
  const { visibleMerchants, visibleCaches, cacheCounts } = useMapPins({
    places,
    cachesMap: caches.map,
    filters,
    categoryFilter,
    isTrusted,
    viewportCentre,
    viewportBbox,
  });

  const refreshPlaces = useCallback(async (bbox: Bbox) => {
    try {
      const list = await fetchPlacesInBbox(bbox);
      setPlaces(list);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const onLibreBounds = useDebouncedMapBounds((next) => {
    setViewportBbox(next);
    void refreshPlaces(next);
    resubscribeForPrefixes(geohashPrefixesForBbox(next));
  });

  // Back target: when opened from a DM live-location card the route carries
  // `returnTo`, so return to that conversation; otherwise pop the stack —
  // preserving back for the Explore / Places / Events / Hunt entry points.
  const handleBack = useCallback(() => {
    const returnTo = route.params?.returnTo;
    if (returnTo?.screen === 'Conversation') {
      // Pop this Map off the Explore stack first, otherwise it stays mounted
      // (with its returnTo param) underneath the DM and re-appears next time
      // the user visits the Explore tab.
      navigation.popToTop();
      navigation.navigate('Conversation', returnTo.params);
      return;
    }
    navigation.goBack();
  }, [navigation, route.params]);

  // The header + permission-screen back button can now return to a DM, so the
  // "Back to Explore" wording only fits the in-stack entry points.
  const backLabel = route.params?.returnTo ? t('mapScreen.back') : t('mapScreen.backToExplore');

  // ------- render --------------------------------------------------------

  if (permission === 'denied') {
    return (
      <View style={styles.container} testID="map-screen">
        <Header
          onBack={handleBack}
          onOpenFilters={() => setFiltersOpen(true)}
          colors={colors}
          backLabel={backLabel}
        />
        <View style={styles.deniedBody}>
          <MapPin size={64} color={colors.textSupplementary} strokeWidth={1.5} />
          <Text style={styles.deniedTitle}>{t('mapScreen.locationRequiredTitle')}</Text>
          <Text style={styles.deniedSubtitle}>{t('mapScreen.locationRequiredSubtitle')}</Text>
          <TouchableOpacity
            style={styles.deniedButton}
            onPress={handleBack}
            testID="map-permission-back-button"
          >
            <Text style={styles.deniedButtonText}>{backLabel}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="map-screen">
      <Header
        onBack={handleBack}
        onOpenFilters={() => setFiltersOpen(true)}
        colors={colors}
        backLabel={backLabel}
      />
      <View style={styles.webviewWrapper}>
        <LibreMiniMap
          lat={pos?.lat ?? null}
          lon={pos?.lon ?? null}
          userLat={livePos?.lat ?? null}
          userLon={livePos?.lon ?? null}
          // Fall back to the initial fix's accuracy ONLY when there's
          // no live fix yet. If livePos exists but its accuracy is
          // null (platform didn't report it), pass null to suppress
          // the halo — using `pos.accuracy` here would draw a halo
          // around live coords using accuracy from a different fix.
          userAccuracyMetres={livePos ? livePos.accuracy : (pos?.accuracy ?? null)}
          userAvatarUri={profile?.picture ?? null}
          profileMarkers={friendMarkers}
          uniformMarkerSize={32}
          merchants={visibleMerchants}
          caches={visibleCaches}
          events={[]}
          interactive
          fill
          onBoundsChange={onLibreBounds}
          onSelectMerchant={(m) => setSelected(m)}
          onSelectCache={(c) => setSelectedCache(c)}
          onOpenLegend={() => setLegendVisible(true)}
        />
      </View>

      <View style={styles.footer}>
        {error ? (
          <Text style={styles.footerError}>{error}</Text>
        ) : (
          <Text style={styles.footerText}>
            {t('mapScreen.merchantsCount', { count: places.length })}
            {caches.map.size > 0
              ? t('mapScreen.cachesSuffix', {
                  piglets: cacheCounts.piglets,
                  caches: cacheCounts.others,
                })
              : ''}
          </Text>
        )}
      </View>

      {selected && (
        <MerchantDetailSheet
          place={selected}
          onClose={() => setSelected(null)}
          onViewDetails={() => {
            const placeId = selected.id;
            setSelected(null);
            navigation.navigate('PlaceDetail', { placeId });
          }}
          colors={colors}
        />
      )}

      {selectedCache && (
        <CacheDetailSheet
          cache={selectedCache}
          onClose={() => setSelectedCache(null)}
          onViewDetails={() => {
            const coord = selectedCache.coord;
            setSelectedCache(null);
            navigation.navigate('HuntPiggyDetail', { coord });
          }}
          colors={colors}
          styles={styles}
        />
      )}

      {filtersOpen && (
        <FilterSheet
          filters={filters}
          onChange={setFilters}
          availableCategories={availableCategories}
          categoryFilter={categoryFilter}
          onChangeCategoryFilter={setCategoryFilter}
          onClose={() => setFiltersOpen(false)}
          wotTier={wotTier}
          untrustedCacheCount={
            // Caches that would render if the WoT filter were "All".
            // Computed each render; cheap because `caches` is small.
            [...caches.map.values()].filter(
              (c) =>
                (c.isLpPiggy ? filters.piglet : filters.nipgcCache) && !isTrusted(c.hiderPubkey),
            ).length
          }
          onOpenWotPicker={() => setWotSheetVisible(true)}
          colors={colors}
          styles={styles}
        />
      )}

      <WebOfTrustBottomSheet visible={wotSheetVisible} onClose={() => setWotSheetVisible(false)} />

      <LegendSheet
        visible={legendVisible}
        onClose={() => setLegendVisible(false)}
        placesVisible={filters.lightning || filters.onchain}
        availableCategories={availableCategories}
      />
    </View>
  );
};

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

const Header: React.FC<{
  onBack: () => void;
  onOpenFilters: () => void;
  colors: Palette;
  backLabel: string;
}> = ({ onBack, onOpenFilters, colors, backLabel }) => {
  const t = useTranslation();
  const styles = useMemo(() => createMapScreenStyles(colors), [colors]);
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        accessibilityLabel={backLabel}
        testID="map-back-button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
      </TouchableOpacity>
      <Text style={styles.headerTitle}>{t('mapScreen.title')}</Text>
      <TouchableOpacity
        onPress={onOpenFilters}
        accessibilityLabel={t('mapScreen.filterPins')}
        testID="map-filter-button"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <SlidersHorizontal size={22} color={colors.white} strokeWidth={2.5} />
      </TouchableOpacity>
    </View>
  );
};

// Swipe-down dismiss for the three custom bottom-sheets on this screen
// (Merchant / Cache / Filter). They use a hand-rolled sheet pattern
// rather than Gorhom's BottomSheetModal — so we wire a PanResponder
// here rather than getting it for free. Same gesture rules across all
// three so they behave consistently:
//   • Drag down past 100 px OR release with vy > 0.5 → dismiss
//   • Otherwise spring back to 0
//   • Upward drag clamped so the sheet doesn't fly up past its anchor
// Returns the translateY value + PanResponder handlers; callers wrap
// the sheet body in Animated.View and spread the handlers on the
// drag-affordance (the handle bar).
function useDismissibleSheet(onClose: () => void): {
  translateY: Animated.Value;
  panHandlers: ReturnType<typeof PanResponder.create>['panHandlers'];
} {
  const translateY = useRef(new Animated.Value(0)).current;
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_e, g) => {
        // Clamp upward drag — the sheet shouldn't rise past its
        // anchor since there's nowhere meaningful for it to go.
        translateY.setValue(Math.max(0, g.dy));
      },
      onPanResponderRelease: (_e, g) => {
        const dismiss = g.dy > 100 || g.vy > 0.5;
        if (dismiss) {
          // Animate fully off-screen, not the old hard-coded 600 px.
          // The sheet has `maxHeight: '80%'`, so on a tall device
          // (Pixel 8 ≈ 2400 px) 80% is ~1920 px — translateY=600
          // left ~1320 px still visible at the moment we unmounted,
          // which the user saw as the sheet flashing back to full
          // size right before disappearing. Using the actual screen
          // height as the off-screen target makes the animation end
          // truly invisible before unmount.
          const screenHeight = Dimensions.get('window').height;
          Animated.timing(translateY, {
            toValue: screenHeight,
            duration: 180,
            useNativeDriver: true,
          }).start(() => {
            // No translateY reset — the sheet unmounts on `onClose`
            // and the next mount creates a fresh translateY at 0
            // via useDismissibleSheet's useRef.
            onClose();
          });
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            friction: 8,
            tension: 80,
          }).start();
        }
      },
    }),
  ).current;
  return { translateY, panHandlers: responder.panHandlers };
}

const CacheDetailSheet: React.FC<{
  cache: ParsedCache;
  onClose: () => void;
  onViewDetails: () => void;
  colors: Palette;
  styles: MapScreenStyles;
}> = ({ cache, onClose, onViewDetails, colors, styles }) => {
  const t = useTranslation();
  const { translateY, panHandlers } = useDismissibleSheet(onClose);
  const kindLabel = cache.isLpPiggy ? t('mapScreen.piglet') : t('mapScreen.nipgcCache');
  const specBits = [
    cache.cacheType,
    cache.size,
    cache.difficulty != null ? `D${cache.difficulty}` : null,
    cache.terrain != null ? `T${cache.terrain}` : null,
  ].filter(Boolean) as string[];
  return (
    <View style={styles.sheetBackdrop} testID="cache-detail-sheet">
      <TouchableOpacity style={styles.sheetTapAway} onPress={onClose} activeOpacity={1} />
      <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
        <View {...panHandlers} style={styles.sheetHandleGrabber} testID="cache-detail-grabber">
          <View style={styles.sheetHandle} />
        </View>
        <View style={styles.sheetTitleRow}>
          <View
            style={[
              styles.sheetIconWrap,
              {
                backgroundColor: cache.isLpPiggy ? colors.brandPink : colors.surface,
              },
            ]}
          >
            <PiggyBank
              size={18}
              color={cache.isLpPiggy ? colors.white : colors.brandPink}
              strokeWidth={2.5}
            />
          </View>
          <Text style={styles.sheetTitle} testID="cache-detail-name">
            {cache.name}
          </Text>
        </View>
        <View style={styles.sheetChipRow}>
          <View style={cache.isLpPiggy ? styles.sheetChipPink : styles.sheetChipGrey}>
            <Text style={cache.isLpPiggy ? styles.sheetChipPinkText : styles.sheetChipGreyText}>
              {kindLabel}
            </Text>
          </View>
          {specBits.length > 0 ? (
            <View style={styles.sheetChipGrey}>
              <Text style={styles.sheetChipGreyText}>{specBits.join(' · ')}</Text>
            </View>
          ) : null}
        </View>
        {cache.description ? (
          <Text style={styles.sheetDescription} numberOfLines={4}>
            {cache.description}
          </Text>
        ) : null}
        <View style={styles.sheetActions}>
          <TouchableOpacity
            style={styles.sheetButton}
            onPress={onViewDetails}
            testID="cache-detail-view-button"
            accessibilityLabel={t('mapScreen.openKindDetail', { kind: kindLabel })}
          >
            <Text style={styles.sheetButtonText}>{t('mapScreen.viewDetails')}</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </View>
  );
};

type PinFilters = {
  lightning: boolean;
  onchain: boolean;
  piglet: boolean;
  nipgcCache: boolean;
};

interface FilterOption {
  key: keyof PinFilters;
  label: string;
  hint: string;
  swatch: string;
  diamond?: boolean;
}

// Filter rows grouped by intent so the user can scan "places" vs
// "geo-caches" without parsing the colour-swatch idiom. Each row is
// still an independent toggle — there's no master "Show all places"
// switch (unticking the two beneath it gives the same result).
const PLACES_FILTERS: ReadonlyArray<FilterOption> = [
  {
    key: 'lightning',
    label: t('mapScreen.lightning'),
    hint: t('mapScreen.lightningHint'),
    swatch: '#EC008C',
  },
  {
    key: 'onchain',
    label: t('mapScreen.onchain'),
    hint: t('mapScreen.onchainHint'),
    swatch: '#F7931A',
  },
];

const CACHE_FILTERS: ReadonlyArray<FilterOption> = [
  {
    key: 'piglet',
    label: t('mapScreen.piglet'),
    hint: t('mapScreen.pigletHint'),
    swatch: '#EC008C',
    diamond: true,
  },
  {
    key: 'nipgcCache',
    label: t('mapScreen.nipgcCache'),
    hint: t('mapScreen.nipgcCacheHint'),
    swatch: '#7A5CFF',
    diamond: true,
  },
];

const FilterSheet: React.FC<{
  filters: PinFilters;
  onChange: (next: PinFilters) => void;
  availableCategories: string[];
  categoryFilter: Set<string>;
  onChangeCategoryFilter: (next: Set<string>) => void;
  onClose: () => void;
  wotTier: 'friends' | 'fof' | 'all';
  untrustedCacheCount: number;
  onOpenWotPicker: () => void;
  colors: Palette;
  styles: MapScreenStyles;
}> = ({
  filters,
  onChange,
  availableCategories,
  categoryFilter,
  onChangeCategoryFilter,
  onClose,
  wotTier,
  untrustedCacheCount,
  onOpenWotPicker,
  colors,
  styles,
}) => {
  const t = useTranslation();
  const toggle = (k: keyof PinFilters) => onChange({ ...filters, [k]: !filters[k] });
  // Render one filter row — extracted so the Places and Geo-caches
  // sections can share the same swatch + toggle layout without
  // duplicating ~20 lines of JSX. Closes over `filters` + `styles` +
  // `toggle` from the FilterSheet scope.
  const renderFilterRow = (opt: FilterOption) => {
    const on = filters[opt.key];
    return (
      <TouchableOpacity
        key={opt.key}
        style={styles.filterRow}
        onPress={() => toggle(opt.key)}
        testID={`map-filter-${opt.key}`}
        accessibilityLabel={t('mapScreen.pinsToggle', {
          label: opt.label,
          state: on ? t('mapScreen.on') : t('mapScreen.off'),
        })}
      >
        <View
          style={[
            opt.diamond ? styles.filterSwatchDiamond : styles.filterSwatchDot,
            { backgroundColor: opt.swatch },
          ]}
        />
        <View style={styles.filterTextWrap}>
          <Text style={styles.filterLabel}>{opt.label}</Text>
          <Text style={styles.filterHint}>{opt.hint}</Text>
        </View>
        <View style={[styles.filterToggle, on && styles.filterToggleOn]}>
          <View style={[styles.filterToggleThumb, on && styles.filterToggleThumbOn]} />
        </View>
      </TouchableOpacity>
    );
  };
  const toggleCategory = (cat: string) => {
    const next = new Set(categoryFilter);
    if (next.has(cat)) next.delete(cat);
    else next.add(cat);
    onChangeCategoryFilter(next);
  };
  const clearCategories = () => onChangeCategoryFilter(new Set());
  const { translateY, panHandlers } = useDismissibleSheet(onClose);
  return (
    <View style={styles.sheetBackdrop} testID="map-filter-sheet">
      <TouchableOpacity style={styles.sheetTapAway} onPress={onClose} activeOpacity={1} />
      <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
        <View {...panHandlers} style={styles.sheetHandleGrabber} testID="map-filter-grabber">
          <View style={styles.sheetHandle} />
        </View>
        <ScrollView showsVerticalScrollIndicator={false}>
          {/* Web-of-Trust — chip + tap-to-open-sheet. Mirrors the same
              affordance on the Hunt filter so the user can change tier
              without leaving the map. The "N hidden" caption explains
              when the current tier is hiding pins they might expect to
              see (the cause of the "where did all the geo-caches go?"
              moment that prompted #19 to grow this filter UI). */}
          <Text style={styles.sheetTitle}>{t('mapScreen.webOfTrust')}</Text>
          <View style={styles.wotRow}>
            <WebOfTrustChip
              currentTier={wotTier}
              onPress={onOpenWotPicker}
              testID="map-filter-wot-chip"
            />
            {untrustedCacheCount > 0 ? (
              <Text style={styles.wotHiddenCount}>
                {t('mapScreen.hiddenCount', { count: untrustedCacheCount })}
              </Text>
            ) : null}
          </View>
          <Text style={[styles.sheetSubtitle, { marginBottom: 16 }]}>
            {t('mapScreen.trustExplain')}
          </Text>

          <Text style={styles.sheetTitle}>{t('mapScreen.places')}</Text>
          <Text style={styles.sheetSubtitle}>{t('mapScreen.placesSubtitle')}</Text>
          <View style={{ marginTop: 8 }}>{PLACES_FILTERS.map(renderFilterRow)}</View>

          <Text style={[styles.sheetTitle, { marginTop: 20 }]}>{t('mapScreen.geocaches')}</Text>
          <Text style={styles.sheetSubtitle}>{t('mapScreen.geocachesSubtitle')}</Text>
          <View style={{ marginTop: 8 }}>{CACHE_FILTERS.map(renderFilterRow)}</View>

          {availableCategories.length > 0 ? (
            <View style={{ marginTop: 16, paddingBottom: 24 }}>
              <View style={styles.categoryHeaderRow}>
                <Text style={styles.sheetTitle}>{t('mapScreen.categories')}</Text>
                {categoryFilter.size > 0 ? (
                  <TouchableOpacity
                    onPress={clearCategories}
                    testID="map-filter-categories-clear"
                    accessibilityLabel={t('mapScreen.clearCategoryFilter')}
                  >
                    <Text style={styles.categoryClearText}>{t('mapScreen.clear')}</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
              <Text style={styles.sheetSubtitle}>
                {categoryFilter.size === 0
                  ? t('mapScreen.categoriesHint')
                  : t('mapScreen.categoriesSelected', { count: categoryFilter.size })}
              </Text>
              <View style={styles.categoryChipsWrap}>
                {availableCategories.map((cat) => {
                  const on = categoryFilter.has(cat);
                  return (
                    <TouchableOpacity
                      key={cat}
                      onPress={() => toggleCategory(cat)}
                      style={[
                        styles.categoryChip,
                        on ? styles.categoryChipOn : styles.categoryChipOff,
                      ]}
                      testID={`map-filter-category-${cat}`}
                      accessibilityLabel={t('mapScreen.categoryToggle', {
                        category: cat,
                        state: on ? t('mapScreen.on') : t('mapScreen.off'),
                      })}
                    >
                      <Text
                        style={[styles.categoryChipText, on ? styles.categoryChipTextOn : null]}
                      >
                        {cat.replace(/_/g, ' ')}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          ) : null}
        </ScrollView>
      </Animated.View>
    </View>
  );
};

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// styles
// -----------------------------------------------------------------------------

export default MapScreen;
