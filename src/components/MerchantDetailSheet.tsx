// Bottom-sheet preview of a BTC Map merchant. Shows curated name +
// address, payment chips, opening hours, contact links, and a Pay /
// View details action row. Used by both:
//   - MapScreen (full map) — pin tap on a merchant
//   - ExploreHomeScreen (mini-map) — pin tap on a merchant (#627 / PR #630)
//
// Self-contained: takes only the `place`, dismiss/details callbacks,
// and a `Palette`. Builds its own dismissible-sheet behaviour via
// `useDismissibleSheet` and its own sheet styles via `createSheetStyles`.

import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, Animated, Linking } from 'react-native';
import { Clock, Globe, Mail, Phone, ShieldCheck, Sparkles, Zap } from 'lucide-react-native';
import {
  acceptsLightning,
  acceptsOnchain,
  btcMapMerchantUrl,
  btcMapVerifyUrl,
  daysSinceVerified,
  formatAddress,
  isBoosted,
  lightningAddressOf,
  type BtcMapPlace,
} from '../services/btcMapService';
import { useDismissibleSheet } from '../hooks/useDismissibleSheet';
import { useTranslation } from '../contexts/LocaleContext';
import { createSheetStyles } from '../styles/sheetStyles';
import { btcMapIconComponent } from '../utils/btcMapIcon';
import { normaliseSocialUrl, placeContactLinks } from '../utils/placeContactLinks';
import SocialIcon from './SocialIcon';
import type { Palette } from '../styles/palettes';

interface Props {
  place: BtcMapPlace;
  colors: Palette;
  onClose: () => void;
  onViewDetails: () => void;
}

export const MerchantDetailSheet: React.FC<Props> = ({ place, colors, onClose, onViewDetails }) => {
  const styles = useMemo(() => createSheetStyles(colors), [colors]);
  const t = useTranslation();
  const { translateY, panHandlers } = useDismissibleSheet(onClose);
  const days = daysSinceVerified(place);
  const lud16 = lightningAddressOf(place);
  const verifyText =
    days === null
      ? null
      : days === 0
        ? t('merchantDetailSheet.verifiedToday')
        : days === 1
          ? t('merchantDetailSheet.verifiedOneDayAgo')
          : t('merchantDetailSheet.verifiedDaysAgo', { days });
  const CategoryIcon = btcMapIconComponent(place.icon);
  // Crowd-sourced OSM values never reach Linking raw: the app builds every
  // href (http(s) / tel: / mailto:) from validated values (#1785).
  const contacts = placeContactLinks(place);
  const openLink = (href: string) => Linking.openURL(href).catch(() => {});

  return (
    <View style={styles.sheetBackdrop} testID="merchant-detail-screen">
      <TouchableOpacity
        style={styles.sheetTapAway}
        onPress={onClose}
        activeOpacity={1}
        accessibilityRole="button"
        accessibilityLabel={t('merchantDetailSheet.closeMerchantDetails')}
        testID="merchant-detail-tap-away"
      />
      <Animated.View style={[styles.sheet, { transform: [{ translateY }] }]}>
        <View {...panHandlers} style={styles.sheetHandleGrabber} testID="merchant-detail-grabber">
          <View style={styles.sheetHandle} />
        </View>
        <View style={styles.sheetTitleRow}>
          <View style={styles.sheetIconWrap}>
            <CategoryIcon size={18} color={colors.brandPink} strokeWidth={2.5} />
          </View>
          <Text style={styles.sheetTitle} testID="merchant-detail-name">
            {place.tags.name ?? t('merchantDetailSheet.unnamedMerchant')}
          </Text>
        </View>
        <Text style={styles.sheetSubtitle}>{formatAddress(place)}</Text>
        <View style={styles.sheetChipRow}>
          {isBoosted(place) && (
            <View style={styles.sheetChipFeatured} testID="merchant-detail-featured">
              <Sparkles size={12} color={colors.textHeader} strokeWidth={2.5} />
              <Text style={styles.sheetChipFeaturedText}>{t('merchantDetailSheet.featured')}</Text>
            </View>
          )}
          {acceptsLightning(place) && (
            <View style={styles.sheetChipPink}>
              <Zap size={12} color={colors.white} strokeWidth={2.5} />
              <Text style={styles.sheetChipPinkText}>{t('merchantDetailSheet.lightning')}</Text>
            </View>
          )}
          {acceptsOnchain(place) && (
            <View style={styles.sheetChipOrange}>
              <Text style={styles.sheetChipOrangeText}>{t('merchantDetailSheet.onchain')}</Text>
            </View>
          )}
        </View>
        {place.description ? (
          <Text style={styles.sheetDescription} numberOfLines={4}>
            {place.description}
          </Text>
        ) : null}
        {place.opening_hours ? (
          <View style={styles.sheetMetaRow}>
            <Clock size={13} color={colors.textSupplementary} strokeWidth={2.5} />
            <Text style={styles.sheetMetaText} numberOfLines={2}>
              {place.opening_hours}
            </Text>
          </View>
        ) : null}
        {verifyText && <Text style={styles.sheetVerify}>{verifyText}</Text>}
        {(contacts.website ||
          contacts.phone ||
          contacts.email ||
          place.facebookUrl ||
          place.twitterUrl ||
          place.instagramUrl) && (
          <View style={styles.sheetContactRow}>
            {contacts.website ? (
              <TouchableOpacity
                style={styles.sheetContactChip}
                onPress={() => openLink(contacts.website!.href)}
                testID="merchant-detail-website"
                accessibilityLabel={t('merchantDetailSheet.openWebsite')}
              >
                <Globe size={13} color={colors.brandPink} strokeWidth={2.5} />
                <Text style={styles.sheetContactText} numberOfLines={1}>
                  {t('merchantDetailSheet.website')}
                </Text>
              </TouchableOpacity>
            ) : null}
            {contacts.phone ? (
              <TouchableOpacity
                style={styles.sheetContactChip}
                onPress={() => openLink(contacts.phone!.href)}
                testID="merchant-detail-phone"
                accessibilityLabel={t('merchantDetailSheet.callPhone', {
                  phone: contacts.phone.value,
                })}
              >
                <Phone size={13} color={colors.brandPink} strokeWidth={2.5} />
                <Text style={styles.sheetContactText} numberOfLines={1}>
                  {contacts.phone.value}
                </Text>
              </TouchableOpacity>
            ) : null}
            {contacts.email ? (
              <TouchableOpacity
                style={styles.sheetContactChip}
                onPress={() => openLink(contacts.email!.href)}
                testID="merchant-detail-email"
                accessibilityLabel={t('merchantDetailSheet.emailContact', {
                  email: contacts.email.value,
                })}
              >
                <Mail size={13} color={colors.brandPink} strokeWidth={2.5} />
                <Text style={styles.sheetContactText} numberOfLines={1}>
                  {t('merchantDetailSheet.email')}
                </Text>
              </TouchableOpacity>
            ) : null}
            {place.facebookUrl ? (
              <TouchableOpacity
                style={styles.sheetContactChip}
                onPress={() => openLink(normaliseSocialUrl('facebook', place.facebookUrl!).href)}
                testID="merchant-detail-facebook"
                accessibilityLabel={t('merchantDetailSheet.openFacebook')}
              >
                <SocialIcon network="facebook" size={14} />
                <Text style={styles.sheetContactText} numberOfLines={1}>
                  Facebook
                </Text>
              </TouchableOpacity>
            ) : null}
            {place.twitterUrl ? (
              <TouchableOpacity
                style={styles.sheetContactChip}
                onPress={() => openLink(normaliseSocialUrl('x', place.twitterUrl!).href)}
                testID="merchant-detail-x"
                accessibilityLabel={t('merchantDetailSheet.openX')}
              >
                <SocialIcon network="x" size={14} />
                <Text style={styles.sheetContactText} numberOfLines={1}>
                  X
                </Text>
              </TouchableOpacity>
            ) : null}
            {place.instagramUrl ? (
              <TouchableOpacity
                style={styles.sheetContactChip}
                onPress={() => openLink(normaliseSocialUrl('instagram', place.instagramUrl!).href)}
                testID="merchant-detail-instagram"
                accessibilityLabel={t('merchantDetailSheet.openInstagram')}
              >
                <SocialIcon network="instagram" size={14} />
                <Text style={styles.sheetContactText} numberOfLines={1}>
                  Instagram
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
        <View style={styles.sheetActions}>
          <TouchableOpacity
            style={[styles.sheetButton, !lud16 && styles.sheetButtonDisabled]}
            disabled={!lud16}
            onPress={() => {
              if (!lud16) return;
              onClose();
              // SendSheet pre-fill is handled in milestone 4 alongside the
              // payment plumbing; for now we close the sheet so the user
              // sees the address. TODO(#467): wire to SendSheet when M4
              // adds the lud16 entry-path on the Home tab.
            }}
            testID="merchant-detail-pay-button"
            accessibilityLabel={
              lud16
                ? t('merchantDetailSheet.payAddress', { address: lud16 })
                : t('merchantDetailSheet.noLightningAddress')
            }
          >
            <Zap size={16} color={colors.white} strokeWidth={2.5} />
            <Text style={styles.sheetButtonText}>{t('merchantDetailSheet.pay')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.sheetButtonSecondary}
            onPress={onViewDetails}
            testID="merchant-detail-view-button"
            accessibilityLabel={t('merchantDetailSheet.openPlaceDetail')}
          >
            <Text style={styles.sheetButtonSecondaryText}>
              {t('merchantDetailSheet.viewDetails')}
            </Text>
          </TouchableOpacity>
        </View>
        {btcMapVerifyUrl(place) || btcMapMerchantUrl(place) ? (
          <View style={styles.sheetBtcMapActionsRow}>
            {btcMapVerifyUrl(place) ? (
              <TouchableOpacity
                style={styles.sheetBtcMapActionButton}
                onPress={() => Linking.openURL(btcMapVerifyUrl(place)!)}
                testID="merchant-detail-verify"
                accessibilityLabel={t('merchantDetailSheet.verifyOnBtcMap')}
              >
                <ShieldCheck size={13} color={colors.brandPink} strokeWidth={2.5} />
                <Text style={styles.sheetBtcMapActionText}>{t('merchantDetailSheet.verify')}</Text>
              </TouchableOpacity>
            ) : null}
            {btcMapMerchantUrl(place) ? (
              <TouchableOpacity
                style={styles.sheetBtcMapActionButton}
                onPress={() => Linking.openURL(btcMapMerchantUrl(place)!)}
                testID="merchant-detail-suggest-edit"
                accessibilityLabel={t('merchantDetailSheet.suggestEditOnBtcMap')}
              >
                <Text style={styles.sheetBtcMapActionText}>
                  {t('merchantDetailSheet.suggestEdit')}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}
      </Animated.View>
    </View>
  );
};
