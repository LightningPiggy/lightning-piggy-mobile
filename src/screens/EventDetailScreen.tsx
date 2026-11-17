import BrandedSpinner from '../components/BrandedSpinner';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Image, Linking, Share } from 'react-native';
import * as Calendar from 'expo-calendar/legacy';
import {
  CalendarPlus,
  ChevronLeft,
  Clock,
  MapPin,
  Navigation as NavigationIcon,
  Share2,
  Sparkles,
  Tag,
  User,
} from 'lucide-react-native';
import type { RouteProp } from '@react-navigation/native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { ExploreNavigation, ExploreStackParamList } from '../navigation/types';
import type { ParsedEvent } from '../services/nostrPlacesService';
import { loadCachedEvents, peekCachedEventsSync } from '../services/nostrPlacesStorage';
import { fetchEvent } from '../services/nostrPlacesPublisher';
import { useNostr } from '../contexts/NostrContext';
import { LibreMiniMap } from '../components/LibreMiniMap';
import { useUserLocation } from '../contexts/UserLocationContext';
import { usePubkeyProfile } from '../hooks/usePubkeyProfile';
import ContactProfileSheet from '../components/ContactProfileSheet';
import Toast from '../components/BrandedToast';
import BrandPatternBackground from '../components/BrandPatternBackground';
import { createEventDetailScreenStyles } from '../styles/EventDetailScreen.styles';

interface Props {
  navigation: ExploreNavigation;
  route: RouteProp<ExploreStackParamList, 'EventDetail'>;
}

const formatDate = (
  ts: number | null,
  t: ReturnType<typeof useLocale>['t'],
  locale: string,
): string => {
  if (ts === null) return t('eventDetailScreen.dateTbc');
  const d = new Date(ts * 1000);
  return d.toLocaleString(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// Inline geohash decoder — same algorithm used elsewhere; kept duplicated
// so the screen has zero coupling to nostrPlacesService internals.
const GEOHASH_BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
const decodeGeohash = (gh: string): { lat: number; lng: number } => {
  let latLo = -90;
  let latHi = 90;
  let lonLo = -180;
  let lonHi = 180;
  let evenBit = true;
  for (let i = 0; i < gh.length; i += 1) {
    const idx = GEOHASH_BASE32.indexOf(gh[i].toLowerCase());
    if (idx < 0) continue;
    for (let bit = 4; bit >= 0; bit -= 1) {
      const set = (idx >> bit) & 1;
      if (evenBit) {
        const mid = (lonLo + lonHi) / 2;
        if (set) lonLo = mid;
        else lonHi = mid;
      } else {
        const mid = (latLo + latHi) / 2;
        if (set) latLo = mid;
        else latHi = mid;
      }
      evenBit = !evenBit;
    }
  }
  return { lat: (latLo + latHi) / 2, lng: (lonLo + lonHi) / 2 };
};

const EventDetailScreen: React.FC<Props> = ({ navigation, route }) => {
  const { t, formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createEventDetailScreenStyles(colors), [colors]);
  const { coord } = route.params;
  // Live user position for the dot on the event venue mini-map —
  // map stays centred on the venue, user dot follows the attendee.
  const { pos: livePos } = useUserLocation();

  const [event, setEvent] = useState<ParsedEvent | null>(() => {
    // Fast path: in-memory mirror already has the event.
    const cached = peekCachedEventsSync().find((e) => e.coord === coord);
    return cached ?? null;
  });
  const [loading, setLoading] = useState(event === null);
  const [profileSheetOpen, setProfileSheetOpen] = useState(false);

  const { relays, profile } = useNostr();
  useEffect(() => {
    if (event !== null) return;
    let cancelled = false;
    (async () => {
      const cached = await loadCachedEvents();
      if (cancelled) return;
      const fromDisk = cached.find((e) => e.coord === coord);
      if (fromDisk) {
        setEvent(fromDisk);
        setLoading(false);
        return;
      }
      // Cache miss — fall through to a relay round-trip. Covers
      // deep-link / share opens where the event was never streamed
      // into the local NIP-52 mirror. Per the Copilot review on
      // PR #488: without this branch the screen settles permanently
      // on "This event isn't in our local feed".
      const parts = coord.split(':');
      if (parts.length >= 3) {
        const organiserPubkey = parts[1];
        const d = parts.slice(2).join(':');
        const readRelays = relays.filter((r) => r.read).map((r) => r.url);
        const fromRelays = await fetchEvent(organiserPubkey, d, readRelays).catch(() => null);
        if (cancelled) return;
        if (fromRelays) setEvent(fromRelays);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [coord, event, relays]);

  const organiser = usePubkeyProfile(event?.organiserPubkey ?? null);
  const organiserName =
    organiser.name ??
    (event ? `${event.organiserPubkey.slice(0, 8)}…${event.organiserPubkey.slice(-4)}` : '');

  const venueCoord = useMemo(() => {
    if (!event?.geohash) return null;
    return decodeGeohash(event.geohash);
  }, [event?.geohash]);

  const onOpenInMaps = useCallback(() => {
    if (!event) return;
    const q = event.location ?? event.geohash ?? event.title;
    Linking.openURL(`geo:0,0?q=${encodeURIComponent(q)}`).catch(() => {
      Linking.openURL(`https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}`).catch(
        () => {},
      );
    });
  }, [event]);

  const onAddToCalendar = useCallback(async () => {
    if (!event) return;
    try {
      const startMs = event.startsAt ? event.startsAt * 1000 : Date.now();
      const endMs = event.endsAt
        ? event.endsAt * 1000
        : // Default to a 2-hour event when the publisher omitted the end
          // tag (NIP-52 makes `end` optional).
          startMs + 2 * 60 * 60 * 1000;
      // `createEventInCalendarAsync` opens the OS calendar create-event
      // sheet with our fields pre-filled — works on iOS + Android and
      // doesn't require WRITE_CALENDAR. The user confirms in the OS UI
      // before the event is actually written.
      await Calendar.createEventInCalendarAsync({
        title: event.title,
        startDate: new Date(startMs),
        endDate: new Date(endMs),
        notes: event.description,
        location: event.location ?? undefined,
      });
    } catch (e) {
      Toast.show({
        type: 'info',
        text1: t('eventDetailScreen.couldntOpenCalendar'),
        text2: (e as Error).message,
      });
    }
  }, [event, t]);

  const onShare = useCallback(() => {
    if (!event) return;
    const when = formatDate(event.startsAt, t, formatLocale);
    Share.share({
      message: `${event.title} — ${when}${event.location ? ` · ${event.location}` : ''}`,
      title: event.title,
    }).catch(() => {});
  }, [event, t, formatLocale]);

  return (
    <View style={styles.container} testID="event-detail-screen">
      <View style={styles.header}>
        <BrandPatternBackground variant="explore-compass" />
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          accessibilityLabel={t('eventDetailScreen.backToEvents')}
          testID="event-detail-back-button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {event?.title ?? t('eventDetailScreen.event')}
        </Text>
        <TouchableOpacity
          onPress={onShare}
          accessibilityLabel={t('eventDetailScreen.shareThisEvent')}
          testID="event-detail-share"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Share2 size={22} color={colors.white} strokeWidth={2.5} />
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {loading ? (
          <BrandedSpinner style={{ marginTop: 40 }} />
        ) : !event ? (
          <Text style={styles.errorText}>{t('eventDetailScreen.notInFeed')}</Text>
        ) : (
          <>
            {event.imageUrl ? (
              <Image source={{ uri: event.imageUrl }} style={styles.hero} resizeMode="cover" />
            ) : null}

            <Text style={styles.title}>{event.title}</Text>

            <View style={styles.metaRow}>
              <Clock size={14} color={colors.brandPink} strokeWidth={2.5} />
              <Text style={styles.metaText}>{formatDate(event.startsAt, t, formatLocale)}</Text>
            </View>
            {event.location ? (
              <View style={styles.metaRow}>
                <MapPin size={14} color={colors.brandPink} strokeWidth={2.5} />
                <Text style={styles.metaText}>{event.location}</Text>
              </View>
            ) : null}

            {/* Organiser — tappable, opens the reusable profile sheet. */}
            <TouchableOpacity
              style={styles.organiserRow}
              onPress={() => setProfileSheetOpen(true)}
              testID="event-detail-organiser"
              accessibilityLabel={t('eventDetailScreen.openProfile', { name: organiserName })}
            >
              {organiser.picture ? (
                <Image source={{ uri: organiser.picture }} style={styles.organiserAvatar} />
              ) : (
                <View style={[styles.organiserAvatar, styles.organiserAvatarFallback]}>
                  <User size={18} color={colors.brandPink} strokeWidth={2.5} />
                </View>
              )}
              <View style={{ flex: 1 }}>
                <Text style={styles.organiserLabel}>{t('eventDetailScreen.organisedBy')}</Text>
                <Text style={styles.organiserName} numberOfLines={1}>
                  {organiserName}
                </Text>
              </View>
            </TouchableOpacity>

            {/* Mini-map centred on the event geohash. Shares the same
                component as PlaceDetail; tap → full Map. */}
            {venueCoord ? (
              <View style={styles.mapWrap}>
                <LibreMiniMap
                  lat={venueCoord.lat}
                  lon={venueCoord.lng}
                  userLat={livePos?.lat ?? null}
                  userLon={livePos?.lon ?? null}
                  userAvatarUri={profile?.picture ?? null}
                  userAccuracyMetres={livePos?.accuracy ?? null}
                  merchants={[]}
                  caches={[]}
                  events={[event]}
                  onTapMap={() => navigation.navigate('Map')}
                />
              </View>
            ) : null}

            {event.description ? <Text style={styles.description}>{event.description}</Text> : null}

            {event.hashtags.length > 0 ? (
              <View style={styles.hashtagRow}>
                <Tag size={12} color={colors.textSupplementary} strokeWidth={2.5} />
                <Text style={styles.hashtagText}>
                  {event.hashtags.map((h) => `#${h}`).join(' · ')}
                </Text>
              </View>
            ) : null}

            <View style={styles.actionsRow}>
              <TouchableOpacity
                style={[styles.actionButton, styles.actionButtonPrimary]}
                onPress={onAddToCalendar}
                testID="event-detail-add-to-calendar"
                accessibilityLabel={t('eventDetailScreen.addToCalendar')}
              >
                <CalendarPlus size={16} color={colors.white} strokeWidth={2.5} />
                <Text style={[styles.actionText, styles.actionTextPrimary]}>
                  {t('eventDetailScreen.addToCalendar')}
                </Text>
              </TouchableOpacity>
              {event.location || event.geohash ? (
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={onOpenInMaps}
                  testID="event-detail-open-in-maps"
                  accessibilityLabel={t('eventDetailScreen.openInMaps')}
                >
                  <NavigationIcon size={16} color={colors.brandPink} strokeWidth={2.5} />
                  <Text style={styles.actionText}>{t('eventDetailScreen.openInMaps')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            <View style={styles.attribution}>
              <Sparkles size={11} color={colors.textSupplementary} strokeWidth={2} />
              <Text style={styles.attributionText}>{t('eventDetailScreen.nip52Attribution')}</Text>
            </View>
          </>
        )}
      </ScrollView>

      <ContactProfileSheet
        visible={profileSheetOpen}
        onClose={() => setProfileSheetOpen(false)}
        contact={
          event
            ? {
                pubkey: event.organiserPubkey,
                name: organiserName,
                picture: organiser.picture,
                lightningAddress: organiser.lud16,
                source: 'nostr',
              }
            : null
        }
        onZap={
          organiser.lud16
            ? () => {
                const lud16 = organiser.lud16!;
                setProfileSheetOpen(false);
                Linking.openURL(`lightning:${lud16}`).catch(() => {});
              }
            : undefined
        }
      />
    </View>
  );
};

export default EventDetailScreen;
