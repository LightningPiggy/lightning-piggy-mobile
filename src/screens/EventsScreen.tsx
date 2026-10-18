import { useAppRelayPrefs } from '../hooks/useAppRelayPrefs';
import BrandedSpinner from '../components/BrandedSpinner';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { View, Text, TextInput, TouchableOpacity, FlatList, Image, Linking } from 'react-native';
import * as Location from 'expo-location';
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  MapPinned,
  Plus,
  Search,
  SlidersHorizontal,
} from 'lucide-react-native';
import Toast from '../components/BrandedToast';
import BrandPatternBackground from '../components/BrandPatternBackground';
import EventsFilterSheet, {
  countActiveFilters,
  type EventsSortKey,
} from '../components/EventsFilterSheet';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { t as translate } from '../i18n';
import type { Palette } from '../styles/palettes';
import { ExploreNavigation } from '../navigation/types';
import {
  decodeGeohash,
  encodeGeohash,
  formatDistance,
  geohashPrefixes,
  haversineMetres,
} from '../utils/geohash';
import { useTrustGraph } from '../contexts/TrustGraphContext';
import { type ParsedEvent } from '../services/nostrPlacesService';
import { subscribeNearbyEvents } from '../services/nostrPlacesPublisher';
import { loadCachedEvents, peekCachedEventsSync, saveEvents } from '../services/nostrPlacesStorage';
import { useCoalescedMap } from '../utils/useCoalescedMap';
import { isFutureEvent } from '../utils/futureEvent';
import { isHiddenInProd, stripHiddenForPersist } from '../utils/exploreContentFilter';
import { createEventsScreenStyles, type EventsScreenStyles } from '../styles/EventsScreen.styles';

interface Props {
  navigation: ExploreNavigation;
}

/**
 * Events sub-screen — read-only feed of NIP-52 kind 31923 calendar
 * events with a `g` tag inside the user's coarse geohash neighbourhood
 * (5-char prefix ≈ 5 km). Bitcoin meetups, conferences, etc. that
 * organisers publish via Flockstr / Coracle / similar clients show up
 * here. Tap a row to expand the inline detail; tap the location to
 * open in OS maps.
 *
 * Replaces the M1 "Coming soon" stub. Closes M7 of the Explore plan.
 */
const EventsScreen: React.FC<Props> = ({ navigation }) => {
  const { t } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createEventsScreenStyles(colors), [colors]);
  const relayScope = useAppRelayPrefs();
  // Coalesce per-event setState bursts during the nearby-event relay
  // backfill into one commit per ~100 ms window (audit MED 4) — the
  // naive `new Map(prev)` clone per event was O(N²) over a cold-start
  // burst. `shouldReplace` keeps the newest revision of a replaceable
  // event. `enqueue` feeds the relay sub; `setEvents` covers the
  // hydrate / clear-on-reload paths.
  const {
    map: events,
    setMap: setEvents,
    enqueue: enqueueEvent,
    flush: flushEvents,
    reset: resetEvents,
  } = useCoalescedMap<ParsedEvent>({
    initial: () => new Map(peekCachedEventsSync().map((e) => [e.coord, e])),
    shouldReplace: (existing, incoming) => existing.startsAt !== incoming.startsAt,
  });

  // Hydrate from AsyncStorage so the list paints instantly on cold
  // start while the live relay sub backfills.
  useEffect(() => {
    let cancelled = false;
    loadCachedEvents().then((es) => {
      if (cancelled || es.length === 0) return;
      setEvents((prev) => {
        if (prev.size > 0) return prev;
        const m = new Map<string, ParsedEvent>();
        for (const e of es) m.set(e.coord, e);
        return m;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [setEvents]);
  useEffect(() => {
    if (events.size === 0) return;
    const t = setTimeout(() => {
      // Shed prod-hidden (test-account) AND past events before persisting so
      // prod caches self-heal — stale Piggy/past entries seeded from earlier
      // versions age out of storage instead of being re-saved forever and
      // consuming MAX_ENTRIES slots. `stripHiddenForPersist` is a no-op in
      // dev/preview; the future-only pass always applies (a past event is
      // useless to re-show on any build). Mirrors ExploreHomeScreen (#917).
      const nowSec = Math.floor(Date.now() / 1000);
      const persistable = stripHiddenForPersist(
        [...events.values()],
        (e) => e.organiserPubkey,
      ).filter((e) => isFutureEvent(e, nowSec));
      saveEvents(persistable);
    }, 1500);
    return () => clearTimeout(t);
  }, [events]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [untrustedHidden, setUntrustedHidden] = useState(0);
  // User position is captured so each row can compute "X away" via
  // haversine + the list sort prefers proximity (with start-time as
  // tiebreaker for events at the same geohash).
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  // Free-text search over title / description / location / hashtags.
  // Pure client-side filter against the already-trust-filtered list;
  // no extra relay queries.
  const [searchQuery, setSearchQuery] = useState('');
  // Optional distance ceiling. `null` = no filter (default — show all
  // events in the user's web of trust regardless of distance).
  // Numeric value = haversine cap in metres.
  const [maxDistanceMetres, setMaxDistanceMetres] = useState<number | null>(null);
  // Date-range ceiling expressed as seconds-from-now. `null` = no filter
  // (default). Picked from a chip row so users can narrow the feed to
  // "this week" / "this month" without committing to a calendar picker.
  const [maxFromNowSec, setMaxFromNowSec] = useState<number | null>(null);
  // Sort key — 'date' (chronological, default) or 'distance' (nearest
  // first). Persisted via the filter sheet so users keep their pick.
  const [sortBy, setSortBy] = useState<EventsSortKey>('date');
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  const closerRef = useRef<(() => void) | null>(null);
  // True only while the screen is focused — lets a manual reload (Retry /
  // pull-to-refresh, which pass no explicit guard) abort if its async location
  // resolve outlives the focus window, so it can't install a sub after blur.
  const isFocusedRef = useRef(false);
  // The "drop the spinner" settle timer, tracked so a reload / blur can cancel
  // it — otherwise a stale timer from a prior subscription fires during the
  // next reload and clears loading for the wrong sub.
  const loadingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Post-#535: `wotTier` replaces the legacy `filterEnabled` boolean.
  // `isTrusted` is tier-aware (returns true for 'all') so callers no
  // longer need to gate on a separate "enabled" flag.
  const { isTrusted, wotTier } = useTrustGraph();
  const isTrustedRef = useRef(isTrusted);
  useEffect(() => {
    isTrustedRef.current = isTrusted;
  }, [isTrusted]);

  // `isCancelled` lets the focus effect abort a reload whose async location
  // resolve outlived the focus window (blur-before-subscribe). Without it a
  // reload kicked on focus could install a live relay sub AFTER blur — leaking
  // exactly the stream this screen now scopes to focus. Button-triggered
  // reloads pass nothing, so the guard is a no-op there.
  const reload = useCallback(
    async (isCancelled?: () => boolean) => {
      // Manual reloads (Retry / pull-to-refresh) pass no guard — default to a
      // focus check so a reload whose async location resolve outlives the focus
      // window can't install a live relay sub after blur (Copilot review).
      const cancelled = isCancelled ?? (() => !isFocusedRef.current);
      // Cancel any in-flight settle timer from the previous sub so it can't fire
      // mid-reload and clear the spinner for the sub we're about to replace.
      if (loadingTimerRef.current) {
        clearTimeout(loadingTimerRef.current);
        loadingTimerRef.current = null;
      }
      // Tear down the previous sub WITHOUT draining its buffer: `resetEvents`
      // discards the staged tail (and clears the committed list) so a
      // pull-to-refresh can't briefly repopulate the cleared list with the old
      // subscription's buffered events (Copilot review).
      closerRef.current?.();
      closerRef.current = null;
      resetEvents();
      setLoading(true);
      setError(null);
      setUntrustedHidden(0);
      try {
        const perm = await Location.requestForegroundPermissionsAsync();
        if (cancelled()) return;
        if (perm.status !== 'granted') {
          setError(t('eventsScreen.locationPermissionRequired'));
          setLoading(false);
          return;
        }
        const liveFix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });
        // Focus was lost while we awaited location — bail before opening a
        // sub the cleanup already ran past.
        if (cancelled()) return;
        const lat = liveFix.coords.latitude;
        const lon = liveFix.coords.longitude;
        setPos({ lat, lon });
        const myGh = encodeGeohash(lat, lon, 7);
        // Precision 3 (~150 km neighbourhood) — Bitcoin meetups cluster
        // in cities; rural users would otherwise see an empty feed.
        // NIP-52 publishers conventionally emit g tags at every
        // precision 3..9, so 3-char prefix is enough to catch them.
        const prefixes = geohashPrefixes(myGh, 3).filter((p) => p.length === 3);
        const closer = subscribeNearbyEvents(prefixes, (e) => {
          // Hide the project's own test-account ("Piggy") events in the
          // production app; dev/preview keep them for Maestro.
          if (isHiddenInProd(e.organiserPubkey)) return;
          // Skip events that have already finished (end, or start when no
          // end / all-day). De-dupe by coord — replaceable events; only
          // keep the newest revision.
          if (!isFutureEvent(e, Math.floor(Date.now() / 1000))) return;
          // WoT filter — see `trustGraphService` for the threat model.
          // `isTrusted` is tier-aware post-#535 (returns true for 'all').
          if (!isTrustedRef.current(e.organiserPubkey)) {
            setUntrustedHidden((n) => n + 1);
            return;
          }
          // Coalesced into one setState per flush window; the newest-wins
          // replace rule (startsAt changed) lives in the hook's
          // `shouldReplace`, re-applied against committed state on flush.
          enqueueEvent(e.coord, e);
        });
        // If focus was lost in the same tick the sub opened, close it now
        // rather than stranding it until the next blur. The focus cleanup
        // owns draining the tail (flushEvents); a reload discards it.
        if (cancelled()) {
          closer();
          return;
        }
        closerRef.current = closer;
        loadingTimerRef.current = setTimeout(() => {
          loadingTimerRef.current = null;
          if (!cancelled()) setLoading(false);
        }, 1500);
      } catch (e) {
        if (cancelled()) return;
        setError((e as Error).message);
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- The subscription reads app relay preferences.
    [resetEvents, enqueueEvent, t, relayScope],
  );

  // Open the relay subscription only while the screen is focused (audit
  // MED 3). With `freezeOnBlur: true` the Explore stack screens never
  // unmount, so the previous bare `useEffect(reload)` left the NIP-52
  // sub streaming forever after the first visit. `useFocusEffect` opens
  // it on focus and closes (+ drains) it on blur; the next focus
  // re-runs `reload`, which re-subscribes (cheap — SimplePool reuses the
  // socket). Manual pull-to-refresh / retry still call `reload` directly
  // while focused, swapping the closer in place.
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      let active = true;
      reload(() => !active);
      return () => {
        active = false;
        isFocusedRef.current = false;
        if (loadingTimerRef.current) {
          clearTimeout(loadingTimerRef.current);
          loadingTimerRef.current = null;
        }
        // Drain the tail of the burst into the visible list, THEN close the
        // relay sub — so events that arrived just before blur aren't stranded
        // in the staged buffer until next focus. (A reload, by contrast,
        // discards the buffer via resetEvents.)
        flushEvents();
        closerRef.current?.();
        closerRef.current = null;
      };
    }, [reload, flushEvents]),
  );

  const sortedEvents = useMemo(() => {
    // Each row carries its precomputed distance so the badge text
    // doesn't re-haversine on every paint. Primary sort key is chosen
    // by the user (sortBy = 'date' | 'distance'); the other key is the
    // tiebreaker so a 0-distance pair never randomly flips order between
    // renders.
    // Re-apply the future-only filter at render time, not just at
    // ingestion: events hydrated from the AsyncStorage mirror on cold
    // start bypass the subscription callback, so a cached past event
    // (e.g. last month's meetup) would otherwise paint until the live
    // sub refreshes. `nowSec` is captured once per memo pass.
    const nowSec = Math.floor(Date.now() / 1000);
    const items = [...events.values()]
      .filter((event) => isFutureEvent(event, nowSec) && !isHiddenInProd(event.organiserPubkey))
      .map((event) => {
        const center = event.geohash ? decodeGeohash(event.geohash) : null;
        const distance =
          pos && center
            ? haversineMetres({ lat: pos.lat, lon: pos.lon }, { lat: center.lat, lon: center.lng })
            : Number.POSITIVE_INFINITY;
        return { event, distance };
      });
    items.sort((a, b) => {
      const startA = a.event.startsAt ?? Number.MAX_SAFE_INTEGER;
      const startB = b.event.startsAt ?? Number.MAX_SAFE_INTEGER;
      if (sortBy === 'distance') {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return startA - startB;
      }
      // sortBy === 'date'
      if (startA !== startB) return startA - startB;
      return a.distance - b.distance;
    });
    return items;
  }, [events, pos, sortBy]);

  // Filtered slice — search query (substring match) AND optional
  // distance ceiling. Both default to "no filter" so a fresh user
  // sees every WoT-trusted event regardless of how far away it is.
  const filteredEvents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    let items = sortedEvents;
    if (maxDistanceMetres !== null) {
      items = items.filter(({ distance }) => distance <= maxDistanceMetres);
    }
    if (maxFromNowSec !== null) {
      const nowSec = Math.floor(Date.now() / 1000);
      const ceiling = nowSec + maxFromNowSec;
      items = items.filter(({ event }) => event.startsAt !== null && event.startsAt <= ceiling);
    }
    if (q) {
      items = items.filter(({ event }) => {
        const hay = [event.title, event.description, event.location ?? '', event.hashtags.join(' ')]
          .join(' ')
          .toLowerCase();
        return hay.includes(q);
      });
    }
    return items;
  }, [sortedEvents, searchQuery, maxDistanceMetres, maxFromNowSec]);

  const activeFilterCount = useMemo(
    () =>
      countActiveFilters({
        maxDistanceMetres,
        maxFromNowSec,
        wotTier,
      }),
    [maxDistanceMetres, maxFromNowSec, wotTier],
  );

  const onCreateEvent = useCallback(() => {
    // Full create flow lives behind a Nostr signer + venue picker we
    // haven't built yet. Surface a friendly placeholder so the
    // affordance is discoverable and the door is propped open.
    Toast.show({
      type: 'info',
      text1: t('eventsScreen.creatingEventsSoonTitle'),
      text2: t('eventsScreen.creatingEventsSoonBody'),
      visibilityTime: 5000,
    });
  }, [t]);

  const openInMaps = useCallback((event: ParsedEvent) => {
    const q = event.location ?? (event.geohash ? event.geohash : event.title);
    const encoded = encodeURIComponent(q);
    // Geo URI is honoured by Android's intent system + iOS Maps.
    Linking.openURL(`geo:0,0?q=${encoded}`).catch(() => {
      Linking.openURL(`https://www.openstreetmap.org/search?query=${encoded}`).catch(() => {});
    });
  }, []);

  return (
    <View style={styles.container} testID="events-screen">
      <View style={styles.header}>
        <BrandPatternBackground variant="explore-compass" />
        <View style={styles.headerRow}>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            accessibilityLabel={t('eventsScreen.backToExplore')}
            testID="events-back-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{t('eventsScreen.events')}</Text>
          <TouchableOpacity
            onPress={onCreateEvent}
            accessibilityLabel={t('eventsScreen.createEvent')}
            testID="events-create-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Plus size={20} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>
        <Text style={styles.headerTagline}>{t('eventsScreen.headerTagline')}</Text>
      </View>

      {/* Search bar — filters the loaded events client-side. Cheap, no
          extra relay queries. Distance / Date / WoT live in the filter
          sheet behind the slider icon. */}
      <View style={styles.searchRow}>
        <Search size={16} color={colors.textSupplementary} strokeWidth={2.5} />
        <TextInput
          style={styles.searchInput}
          placeholder={t('eventsScreen.searchPlaceholder')}
          placeholderTextColor={colors.textSupplementary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
          testID="events-search-input"
        />
        <TouchableOpacity
          style={styles.filterIconButton}
          onPress={() => setFilterSheetOpen(true)}
          testID="events-filter-button"
          accessibilityLabel={
            activeFilterCount > 0
              ? t('eventsScreen.filtersActive', { count: activeFilterCount })
              : t('eventsScreen.filters')
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

      {loading && events.size === 0 ? (
        <View style={styles.center}>
          <BrandedSpinner />
          <Text style={styles.subtle}>{t('eventsScreen.lookingForEvents')}</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryButton} onPress={() => reload()}>
            <Text style={styles.retryButtonText}>{t('eventsScreen.retry')}</Text>
          </TouchableOpacity>
        </View>
      ) : sortedEvents.length === 0 ? (
        <View style={styles.center} testID="events-empty-state">
          <CalendarDays size={56} color={colors.textSupplementary} strokeWidth={1.5} />
          <Text style={styles.emptyTitle}>{t('eventsScreen.noUpcomingEvents')}</Text>
          <Text style={styles.subtle}>{t('eventsScreen.emptyStateBody')}</Text>
        </View>
      ) : (
        <>
          <FlatList
            refreshControl={
              <BrandedRefreshControl
                refreshing={loading && events.size > 0}
                onRefresh={() => reload()}
              />
            }
            // Hero card lives in the list header so it scrolls with the
            // rest. Showing a large image + description for the very
            // next event helps users orient at a glance; hidden when the
            // user is searching (the hero would look stale).
            data={
              searchQuery.trim() === '' && filteredEvents.length > 0
                ? filteredEvents.slice(1)
                : filteredEvents
            }
            ListHeaderComponent={
              searchQuery.trim() === '' && filteredEvents.length > 0 ? (
                <EventHero
                  event={filteredEvents[0].event}
                  distance={filteredEvents[0].distance}
                  onPress={() =>
                    navigation.navigate('EventDetail', {
                      coord: filteredEvents[0].event.coord,
                    })
                  }
                  expanded={false}
                  onOpenInMaps={() => openInMaps(filteredEvents[0].event)}
                  colors={colors}
                  styles={styles}
                />
              ) : null
            }
            keyExtractor={({ event }) => event.coord}
            contentContainerStyle={styles.listContent}
            renderItem={({ item, index }) => (
              <EventRow
                event={item.event}
                distance={item.distance}
                // Highlight the first two unsearched rows as "Up next"
                // (hero already pulls the very-next one out). When the
                // user is searching the highlight makes no sense.
                upNext={searchQuery.trim() === '' && index < 2}
                expanded={false}
                onToggle={() => navigation.navigate('EventDetail', { coord: item.event.coord })}
                onOpenInMaps={() => openInMaps(item.event)}
                colors={colors}
                styles={styles}
              />
            )}
            ListEmptyComponent={
              searchQuery.trim() !== '' ? (
                <Text style={styles.emptySearchText}>
                  {t('eventsScreen.noSearchMatches', { query: searchQuery.trim() })}
                </Text>
              ) : null
            }
          />
        </>
      )}
      <EventsFilterSheet
        visible={filterSheetOpen}
        onClose={() => setFilterSheetOpen(false)}
        maxDistanceMetres={maxDistanceMetres}
        onChangeMaxDistance={setMaxDistanceMetres}
        maxFromNowSec={maxFromNowSec}
        onChangeMaxFromNow={setMaxFromNowSec}
        wotUntrustedHidden={untrustedHidden}
        sortBy={sortBy}
        onChangeSortBy={setSortBy}
        onClearAll={() => {
          setMaxDistanceMetres(null);
          setMaxFromNowSec(null);
          setSortBy('date');
          // WoT tier reset is intentionally not bundled here — the user
          // controls it via the bottom-sheet picker.
        }}
      />
    </View>
  );
};

const formatDate = (ts: number | null, locale: string): string => {
  if (!ts) return translate('eventsScreen.timeTba');
  const d = new Date(ts * 1000);
  return d.toLocaleString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const dayLabel = (ts: number | null, locale: string): { day: string; month: string } => {
  if (!ts) return { day: '?', month: '—' };
  const d = new Date(ts * 1000);
  return {
    day: String(d.getDate()),
    month: d.toLocaleString(locale, { month: 'short' }).toUpperCase(),
  };
};

const EventHero: React.FC<{
  event: ParsedEvent;
  distance: number;
  expanded: boolean;
  onPress: () => void;
  onOpenInMaps: () => void;
  colors: Palette;
  styles: EventsScreenStyles;
}> = ({ event, distance, expanded, onPress, onOpenInMaps, colors, styles }) => {
  const { t, formatLocale } = useLocale();
  return (
    <TouchableOpacity
      style={styles.heroCard}
      onPress={onPress}
      activeOpacity={0.85}
      testID={`event-hero-${event.d}`}
      accessibilityLabel={t('eventsScreen.nextEvent', { title: event.title })}
    >
      {event.imageUrl ? (
        <Image source={{ uri: event.imageUrl }} style={styles.heroImage} resizeMode="cover" />
      ) : (
        <View style={[styles.heroImage, styles.heroImageFallback]}>
          <CalendarDays size={48} color={colors.brandPink} strokeWidth={1.5} />
        </View>
      )}
      <View style={styles.heroBody}>
        <Text style={styles.heroUpNext}>{t('eventsScreen.upNext')}</Text>
        <Text style={styles.heroTitle} numberOfLines={2}>
          {event.title}
        </Text>
        <Text style={styles.heroMeta} numberOfLines={2}>
          {formatDate(event.startsAt, formatLocale)}
          {Number.isFinite(distance) ? ` · ${formatDistance(distance)}` : ''}
          {event.location ? ` · ${event.location}` : ''}
        </Text>
        {event.description ? (
          <Text style={styles.heroDescription} numberOfLines={expanded ? 0 : 3}>
            {event.description}
          </Text>
        ) : null}
        {expanded && (event.location || event.geohash) ? (
          <TouchableOpacity
            style={styles.locationButton}
            onPress={onOpenInMaps}
            testID={`event-hero-${event.d}-open-in-maps`}
          >
            <MapPinned size={14} color={colors.brandPink} strokeWidth={2.5} />
            <Text style={styles.locationButtonText}>{t('eventsScreen.openInMaps')}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    </TouchableOpacity>
  );
};

const EventRow: React.FC<{
  event: ParsedEvent;
  distance: number;
  upNext: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpenInMaps: () => void;
  colors: Palette;
  styles: EventsScreenStyles;
}> = ({ event, distance, upNext, expanded, onToggle, colors, styles }) => {
  const { t, formatLocale } = useLocale();
  const { day, month } = dayLabel(event.startsAt, formatLocale);
  return (
    <TouchableOpacity
      style={[styles.row, upNext ? styles.rowUpNext : null]}
      onPress={onToggle}
      testID={`event-row-${event.d}`}
      accessibilityLabel={event.title}
    >
      {upNext ? <Text style={styles.upNextChip}>{t('eventsScreen.upNext')}</Text> : null}
      <View style={styles.dateBlock}>
        <Text style={styles.dateMonth}>{month}</Text>
        <Text style={styles.dateDay}>{day}</Text>
      </View>
      {/* Thumbnail in the collapsed row so the user can recognise the
          event at a glance. Falls back to nothing (date block + meta
          carry the row on their own) when the publisher didn't supply
          an image. The expanded view renders a wider hero image too. */}
      {event.imageUrl ? (
        <Image source={{ uri: event.imageUrl }} style={styles.thumb} resizeMode="cover" />
      ) : null}
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={expanded ? 0 : 1}>
          {event.title}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {formatDate(event.startsAt, formatLocale)}
          {event.location ? ` · ${event.location}` : ''}
        </Text>
        {/* Distance gets its own line so it's never truncated by a long
            venue address; events without a geohash render an em-dash so
            the layout stays consistent row-to-row. */}
        <Text style={styles.rowDistance} numberOfLines={1}>
          {Number.isFinite(distance) ? formatDistance(distance) : t('eventsScreen.distanceUnknown')}
        </Text>
      </View>
      <ChevronRight size={20} color={colors.textSupplementary} strokeWidth={2.5} />
    </TouchableOpacity>
  );
};

export default EventsScreen;
