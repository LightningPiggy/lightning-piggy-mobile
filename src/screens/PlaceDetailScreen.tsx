import BrandedSpinner from '../components/BrandedSpinner';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Linking, Share } from 'react-native';
import * as Location from 'expo-location';
import {
  Accessibility,
  ChevronLeft,
  Clock,
  ExternalLink,
  Globe,
  Mail,
  MapPin,
  Navigation as NavigationIcon,
  Phone,
  Share2,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Trees,
  Truck,
  Zap,
} from 'lucide-react-native';
import type { RouteProp } from '@react-navigation/native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { createPlaceDetailScreenStyles } from '../styles/PlaceDetailScreen.styles';
import { normaliseSocialUrl, placeContactLinks } from '../utils/placeContactLinks';
import { ExploreNavigation, ExploreStackParamList } from '../navigation/types';
import {
  type BtcMapPlace,
  acceptsLightning,
  acceptsOnchain,
  btcMapMerchantUrl,
  btcMapVerifyUrl,
  daysSinceVerified,
  fetchPlaceById,
  fetchPlaceRich,
  formatAddress,
  isBoosted,
  lightningAddressOf,
} from '../services/btcMapService';
import { formatDistance, haversineMetres } from '../utils/geohash';
import { LibreMiniMap } from '../components/LibreMiniMap';
import { useUserLocation } from '../contexts/UserLocationContext';
import { btcMapIconComponent } from '../utils/btcMapIcon';
import SocialIcon, { socialLabel, type SocialNetwork } from '../components/SocialIcon';
import BrandPatternBackground from '../components/BrandPatternBackground';

interface Props {
  navigation: ExploreNavigation;
  route: RouteProp<ExploreStackParamList, 'PlaceDetail'>;
}

/**
 * Detail view for a single BTC Map / OSM merchant. Resolves the place
 * by `id` from a small bbox query (we don't have a "fetch one place
 * by id" endpoint, but the cached bbox the list view already ran
 * almost certainly contains this id, so the cache hit is essentially
 * free). Renders address, payment methods, contact info, a
 * single-pin map preview, and pay / directions actions.
 */
// Format BTC Map's ISO-ish timestamps (e.g. "2022-09-25T08:45:08Z") to
// a friendly YYYY-MM-DD for the lifecycle block. Invalid dates return
// the raw string so a malformed payload doesn't render "NaN-NaN-NaN".
const formatYMD = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
};

const SocialRow: React.FC<{
  network: SocialNetwork;
  url: string;
  styles: Record<string, ReturnType<typeof StyleSheet.create>[string]>;
}> = ({ network, url, styles }) => {
  const { display, href } = normaliseSocialUrl(network, url);
  return (
    <TouchableOpacity
      style={styles.contactRow}
      onPress={() => Linking.openURL(href).catch(() => {})}
      accessibilityLabel={`${socialLabel(network)}: ${display}`}
    >
      <SocialIcon network={network} size={18} />
      <Text style={styles.contactText} numberOfLines={1}>
        {display}
      </Text>
    </TouchableOpacity>
  );
};

const PlaceDetailScreen: React.FC<Props> = ({ navigation, route }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createPlaceDetailScreenStyles(colors), [colors]);
  const { placeId } = route.params;
  const [place, setPlace] = useState<BtcMapPlace | null>(null);
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  // Live position for the user dot on the merchant mini-map — the map
  // is centred on the merchant, but the user-dot follows the visitor
  // as they walk towards it.
  const { pos: livePos } = useUserLocation();
  const { profile } = useNostr();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Location is a *nice-to-have* on PlaceDetail — it powers the
        // "X km away" chip and the Directions button. Without it the
        // page still shows everything else about the merchant, so we
        // shouldn't block rendering on permission. Try silently and
        // fall through either way (Copilot review on PR #488 flagged
        // the previous flow as a UX blocker: tap merchant → "Location
        // permission required" instead of the merchant detail).
        try {
          const perm = await Location.requestForegroundPermissionsAsync();
          if (perm.status === 'granted') {
            const fix = await Location.getCurrentPositionAsync({
              accuracy: Location.Accuracy.High,
            });
            if (!cancelled) {
              setPos({ lat: fix.coords.latitude, lon: fix.coords.longitude });
            }
          }
        } catch {
          // Location lookup failed — keep going, `pos` stays null and the
          // distance chip + Directions row hide themselves.
        }
        if (cancelled) return;
        // Fast path: look up the single place by id from the in-memory
        // BTC Map dataset (or hydrate from AsyncStorage). Avoids the
        // 28k-row bbox filter we used to run just to .find() one item,
        // which made the tap → detail transition feel sluggish.
        const found = await fetchPlaceById(placeId);
        if (cancelled) return;
        if (!found) {
          setError(t('placeDetailScreen.notInCache'));
        } else {
          setPlace(found);
          // Bulk dataset only carries list-essential fields (id/lat/lon/
          // name/icon/lightning/etc). Detail screen renders the rich
          // shape (cuisine, contact links, opening_hours, …) so lazy-
          // fetch per-id and overlay. Failure is silent — the slim
          // record is still usable.
          fetchPlaceRich(placeId).then((rich) => {
            if (!cancelled && rich) setPlace((prev) => (prev ? { ...prev, ...rich } : rich));
          });
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [placeId, t]);

  const openDirections = useCallback(() => {
    if (!place) return;
    const label = encodeURIComponent(
      place.tags.name ?? t('placeDetailScreen.bitcoinPlaceFallback'),
    );
    const uri = `geo:${place.lat},${place.lon}?q=${place.lat},${place.lon}(${label})`;
    Linking.openURL(uri).catch(() => {
      Linking.openURL(
        `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=18/${place.lat}/${place.lon}`,
      ).catch(() => {});
    });
  }, [place, t]);

  const openContact = useCallback((scheme: 'tel' | 'mailto' | 'https', value: string) => {
    const uri = scheme === 'https' ? value : `${scheme}:${value}`;
    Linking.openURL(uri).catch(() => {});
  }, []);

  const contacts = place ? placeContactLinks(place) : null;

  return (
    <View style={styles.container} testID="place-detail-screen">
      <View style={styles.header}>
        <BrandPatternBackground variant="explore-compass" />
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          accessibilityLabel={t('placeDetailScreen.backToPlaces')}
          testID="place-detail-back-button"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ChevronLeft size={24} color={colors.white} strokeWidth={2.5} />
        </TouchableOpacity>
        <Text style={styles.headerTitle} numberOfLines={1}>
          {place?.tags.name ?? t('placeDetailScreen.placeFallback')}
        </Text>
        {place && btcMapMerchantUrl(place) ? (
          <TouchableOpacity
            onPress={() => {
              const url = btcMapMerchantUrl(place)!;
              const name = place.tags.name ?? t('placeDetailScreen.thisBitcoinMerchant');
              Share.share({
                message: t('placeDetailScreen.shareMessage', { name, url }),
                url,
                title: name,
              }).catch(() => {});
            }}
            accessibilityLabel={t('placeDetailScreen.shareThisMerchant')}
            testID="place-detail-share-header"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Share2 size={22} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
        ) : (
          <View style={styles.headerRightSpacer} />
        )}
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {loading ? (
          <BrandedSpinner style={{ marginTop: 40 }} />
        ) : error ? (
          <Text style={styles.errorText}>{error}</Text>
        ) : place ? (
          <>
            <View style={styles.titleRow}>
              {(() => {
                const CategoryIcon = btcMapIconComponent(place.icon);
                return (
                  <View style={styles.categoryIconWrap}>
                    <CategoryIcon size={20} color={colors.brandPink} strokeWidth={2.5} />
                  </View>
                );
              })()}
              <Text style={styles.title}>
                {place.tags.name ?? t('placeDetailScreen.unnamedMerchant')}
              </Text>
            </View>
            <View style={styles.chipRow}>
              {isBoosted(place) ? (
                <View style={styles.chipFeatured} testID="place-detail-featured-chip">
                  <Sparkles size={12} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.chipPinkText}>{t('placeDetailScreen.featured')}</Text>
                </View>
              ) : null}
              {acceptsLightning(place) ? (
                <View style={styles.chipPink}>
                  <Zap size={12} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.chipPinkText}>{t('placeDetailScreen.lightning')}</Text>
                </View>
              ) : null}
              {acceptsOnchain(place) ? (
                <View style={styles.chipOrange}>
                  <MapPin size={12} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.chipPinkText}>{t('placeDetailScreen.onChain')}</Text>
                </View>
              ) : null}
              {pos ? (
                <View style={styles.chipGrey}>
                  <Text style={styles.chipGreyText}>
                    {t('placeDetailScreen.distanceAway', {
                      distance: formatDistance(
                        haversineMetres(
                          { lat: pos.lat, lon: pos.lon },
                          { lat: place.lat, lon: place.lon },
                        ),
                      ),
                    })}
                  </Text>
                </View>
              ) : null}
              {/* Accessibility — OSM `wheelchair=yes/limited/no`. We only
                  surface yes/limited (a hard "no" feels stigmatising and
                  the data is too sparse to act on). */}
              {place.tags['wheelchair'] === 'yes' || place.tags['wheelchair'] === 'limited' ? (
                <View style={styles.chipFeature}>
                  <Accessibility size={12} color={colors.textHeader} strokeWidth={2.5} />
                  <Text style={styles.chipFeatureText}>
                    {place.tags['wheelchair'] === 'limited'
                      ? t('placeDetailScreen.wheelchairLimited')
                      : t('placeDetailScreen.wheelchairAccessible')}
                  </Text>
                </View>
              ) : null}
              {place.tags['takeaway'] === 'yes' ? (
                <View style={styles.chipFeature}>
                  <ShoppingBag size={12} color={colors.textHeader} strokeWidth={2.5} />
                  <Text style={styles.chipFeatureText}>{t('placeDetailScreen.takeaway')}</Text>
                </View>
              ) : null}
              {place.tags['delivery'] === 'yes' ? (
                <View style={styles.chipFeature}>
                  <Truck size={12} color={colors.textHeader} strokeWidth={2.5} />
                  <Text style={styles.chipFeatureText}>{t('placeDetailScreen.delivery')}</Text>
                </View>
              ) : null}
              {place.tags['outdoor_seating'] === 'yes' ? (
                <View style={styles.chipFeature}>
                  <Trees size={12} color={colors.textHeader} strokeWidth={2.5} />
                  <Text style={styles.chipFeatureText}>
                    {t('placeDetailScreen.outdoorSeating')}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text style={styles.address}>{formatAddress(place)}</Text>

            {place.tags['brand'] ? (
              <Text style={styles.metaLine}>
                {t('placeDetailScreen.partOf', { brand: place.tags['brand'] })}
              </Text>
            ) : null}
            {place.tags['cuisine'] ? (
              <Text style={styles.metaLine}>
                {t('placeDetailScreen.cuisine', {
                  value: place.tags['cuisine'].replace(/;/g, ', '),
                })}
              </Text>
            ) : null}
            {place.tags['level'] || place.tags['addr:floor'] ? (
              <Text style={styles.metaLine}>
                {t('placeDetailScreen.floor', {
                  value: place.tags['level'] ?? place.tags['addr:floor'],
                })}
              </Text>
            ) : null}
            {place.tags['wheelchair:description'] ? (
              <Text style={styles.metaLine}>{place.tags['wheelchair:description']}</Text>
            ) : null}

            {place.description ? <Text style={styles.description}>{place.description}</Text> : null}

            {/* Single-pin map preview — same component the Hub mini-map
                uses, centred on the merchant. Tap → full Map. */}
            <View style={styles.mapWrap}>
              <LibreMiniMap
                lat={place.lat}
                lon={place.lon}
                userLat={livePos?.lat ?? pos?.lat ?? null}
                userLon={livePos?.lon ?? pos?.lon ?? null}
                userAvatarUri={profile?.picture ?? null}
                userAccuracyMetres={livePos?.accuracy ?? null}
                merchants={[place]}
                caches={[]}
                events={[]}
                onTapMap={() => navigation.navigate('Map')}
              />
            </View>

            {lightningAddressOf(place) ? (
              <View style={styles.actionRow}>
                <TouchableOpacity
                  style={styles.primaryAction}
                  testID="place-detail-pay-button"
                  accessibilityLabel={t('placeDetailScreen.payThisMerchant')}
                  onPress={() => {
                    // TODO: route through SendSheet with the lud16 pre-filled.
                    // For now nudge into the user's flow via deep-link.
                    const lud16 = lightningAddressOf(place);
                    if (lud16) Linking.openURL(`lightning:${lud16}`).catch(() => {});
                  }}
                >
                  <Zap size={16} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.primaryActionText}>{t('placeDetailScreen.pay')}</Text>
                </TouchableOpacity>
              </View>
            ) : null}

            {place.opening_hours ? (
              <View style={styles.contactSection}>
                <Text style={styles.sectionLabel}>{t('placeDetailScreen.openingHours')}</Text>
                <View style={styles.contactRow}>
                  <Clock size={14} color={colors.brandPink} strokeWidth={2.5} />
                  <Text style={styles.contactText}>{place.opening_hours}</Text>
                </View>
              </View>
            ) : null}

            {contacts?.phone ||
            contacts?.website ||
            place.email ||
            place.facebookUrl ||
            place.twitterUrl ||
            place.instagramUrl ||
            place.telegramUrl ||
            place.whatsappUrl ? (
              <View style={styles.contactSection}>
                <Text style={styles.sectionLabel}>{t('placeDetailScreen.contact')}</Text>
                {contacts?.phone ? (
                  <TouchableOpacity
                    style={styles.contactRow}
                    testID="place-phone"
                    accessibilityLabel={t('placeDetailScreen.phone')}
                    onPress={() => openContact('tel', contacts.phone!.value)}
                  >
                    <Phone size={14} color={colors.brandPink} strokeWidth={2.5} />
                    <Text style={styles.contactText}>{contacts.phone.value}</Text>
                  </TouchableOpacity>
                ) : null}
                {contacts?.website ? (
                  <TouchableOpacity
                    style={styles.contactRow}
                    testID="place-website"
                    accessibilityLabel={t('placeDetailScreen.website')}
                    onPress={() => openContact('https', contacts.website!.href)}
                  >
                    <Globe size={14} color={colors.brandPink} strokeWidth={2.5} />
                    <Text style={styles.contactText} numberOfLines={1}>
                      {contacts.website.value}
                    </Text>
                    <ExternalLink size={12} color={colors.textSupplementary} />
                  </TouchableOpacity>
                ) : null}
                {place.email ? (
                  <TouchableOpacity
                    style={styles.contactRow}
                    onPress={() => openContact('mailto', place.email!)}
                  >
                    <Mail size={14} color={colors.brandPink} strokeWidth={2.5} />
                    <Text style={styles.contactText}>{place.email}</Text>
                  </TouchableOpacity>
                ) : null}
                {place.facebookUrl ? (
                  <SocialRow network="facebook" url={place.facebookUrl} styles={styles} />
                ) : null}
                {place.twitterUrl ? (
                  <SocialRow network="x" url={place.twitterUrl} styles={styles} />
                ) : null}
                {place.instagramUrl ? (
                  <SocialRow network="instagram" url={place.instagramUrl} styles={styles} />
                ) : null}
                {place.telegramUrl ? (
                  <SocialRow network="telegram" url={place.telegramUrl} styles={styles} />
                ) : null}
                {place.whatsappUrl ? (
                  <SocialRow network="whatsapp" url={place.whatsappUrl} styles={styles} />
                ) : null}
              </View>
            ) : null}

            {place.verified_at ||
            place.createdAt ||
            place.updatedAt ||
            place.tags['start_date'] ||
            place.tags['check_date:currency:XBT'] ||
            (place.commentsCount ?? 0) > 0 ? (
              <View style={styles.lifecycleBlock}>
                {place.tags['check_date:currency:XBT'] ? (
                  <Text style={styles.lifecycleText}>
                    {t('placeDetailScreen.acceptanceConfirmed', {
                      date: place.tags['check_date:currency:XBT'],
                    })}
                  </Text>
                ) : null}
                {place.verified_at ? (
                  <Text style={styles.lifecycleText}>
                    {t('placeDetailScreen.lastVerified', { days: daysSinceVerified(place) })}
                  </Text>
                ) : null}
                {place.updatedAt ? (
                  <Text style={styles.lifecycleText}>
                    {t('placeDetailScreen.lastUpdated', { date: formatYMD(place.updatedAt) })}
                  </Text>
                ) : null}
                {place.tags['start_date'] ? (
                  <Text style={styles.lifecycleText}>
                    {t('placeDetailScreen.openSince', { date: place.tags['start_date'] })}
                  </Text>
                ) : null}
                {place.createdAt ? (
                  <Text style={styles.lifecycleText}>
                    {t('placeDetailScreen.listedOnBtcMap', { date: formatYMD(place.createdAt) })}
                  </Text>
                ) : null}
                {(place.commentsCount ?? 0) > 0 && btcMapMerchantUrl(place) ? (
                  <TouchableOpacity
                    onPress={() => Linking.openURL(btcMapMerchantUrl(place)!)}
                    testID="place-detail-comments-link"
                  >
                    <Text style={[styles.lifecycleText, styles.commentsLink]}>
                      {place.commentsCount === 1
                        ? t('placeDetailScreen.communityNote', { count: place.commentsCount ?? 0 })
                        : t('placeDetailScreen.communityNotes', {
                            count: place.commentsCount ?? 0,
                          })}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}

            <View style={styles.btcMapActionsRow}>
              <TouchableOpacity
                // Same pill geometry as Verify / Suggest-an-edit, but
                // filled brand-pink so the primary "get me there" action
                // pops over the outline buttons next to it.
                style={[styles.btcMapActionButton, styles.btcMapActionButtonPrimary]}
                onPress={openDirections}
                testID="place-detail-directions-button"
                accessibilityLabel={t('placeDetailScreen.openDirections')}
              >
                <NavigationIcon size={14} color={colors.white} strokeWidth={2.5} />
                <Text style={[styles.btcMapActionText, styles.btcMapActionTextPrimary]}>
                  {t('placeDetailScreen.directions')}
                </Text>
              </TouchableOpacity>
              {btcMapMerchantUrl(place) ? (
                <TouchableOpacity
                  style={styles.btcMapActionButton}
                  onPress={() => Linking.openURL(btcMapMerchantUrl(place)!).catch(() => {})}
                  testID="place-view-on-btcmap"
                  accessibilityLabel={t('placeDetailScreen.viewOnBtcMap')}
                >
                  <ExternalLink size={14} color={colors.brandPink} strokeWidth={2.5} />
                  <Text style={styles.btcMapActionText}>{t('placeDetailScreen.viewOnBtcMap')}</Text>
                </TouchableOpacity>
              ) : null}
              {btcMapVerifyUrl(place) ? (
                <TouchableOpacity
                  style={styles.btcMapActionButton}
                  onPress={() => Linking.openURL(btcMapVerifyUrl(place)!)}
                  testID="place-detail-verify"
                  accessibilityLabel={t('placeDetailScreen.verifyListing')}
                >
                  <ShieldCheck size={14} color={colors.brandPink} strokeWidth={2.5} />
                  <Text style={styles.btcMapActionText}>
                    {t('placeDetailScreen.verifyOnBtcMap')}
                  </Text>
                </TouchableOpacity>
              ) : null}
              {btcMapMerchantUrl(place) ? (
                <TouchableOpacity
                  style={styles.btcMapActionButton}
                  onPress={() => Linking.openURL(btcMapMerchantUrl(place)!)}
                  testID="place-detail-suggest-edit"
                  accessibilityLabel={t('placeDetailScreen.suggestEditOnBtcMap')}
                >
                  <ExternalLink size={14} color={colors.brandPink} strokeWidth={2.5} />
                  <Text style={styles.btcMapActionText}>{t('placeDetailScreen.suggestEdit')}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
};

export default PlaceDetailScreen;
