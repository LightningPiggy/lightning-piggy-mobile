import { useAppRelayPrefs } from '../../hooks/useAppRelayPrefs';
import { enabledAppRelays } from '../../services/appRelayPrefs';
import BrandedSpinner from '../../components/BrandedSpinner';
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, Image, Linking } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nip19 from 'nostr-tools/nip19';
import {
  Globe,
  LifeBuoy,
  MessageCircle,
  Scale,
  ScrollText,
  Tag,
  UserRound,
  Zap,
} from 'lucide-react-native';
import AccountScreenLayout from './AccountScreenLayout';
import SettingsRow from '../../components/SettingsRow';
import SettingsSection from '../../components/SettingsSection';
import NostrLoginSheet from '../../components/NostrLoginSheet';
import SendSheet from '../../components/SendSheet';
import FeedbackSheet from '../../components/FeedbackSheet';
import { createDmSender } from '../../utils/nostrDm';
import { fetchProfile, DEFAULT_RELAYS } from '../../services/nostrService';
import { useNostr } from '../../contexts/NostrContext';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import { createAboutScreenStyles } from '../../styles/AboutScreen.styles';
import type { NostrProfile } from '../../types/nostr';
import { LIGHTNING_PIGGY_TEAM_NPUB, dmRecipient } from '../../constants/npubs';
import { appVersionLabel } from '../../utils/appVersion';

// Bumped key (#346) to evict pre-avatar caches that pinned an empty avatar circle.
const TEAM_PROFILE_CACHE_KEY = 'team_profile_cache_v2';
const LEGACY_TEAM_PROFILE_CACHE_KEY = 'team_profile_cache';

const AboutScreen: React.FC = () => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createAboutScreenStyles(colors), [colors]);
  const { isLoggedIn, signerType, sendDirectMessage } = useNostr();

  const relayScope = useAppRelayPrefs();
  const [teamProfile, setTeamProfile] = useState<NostrProfile | null>(null);
  const [teamProfileLoading, setTeamProfileLoading] = useState(true);
  const [teamPictureError, setTeamPictureError] = useState(false);
  const [zapSheetOpen, setZapSheetOpen] = useState(false);
  const [feedbackSheetOpen, setFeedbackSheetOpen] = useState(false);
  const [loginSheetOpen, setLoginSheetOpen] = useState(false);

  // Clear the load-failure flag whenever the picture URL changes so a refreshed kind-0 retries.
  useEffect(() => {
    setTeamPictureError(false);
  }, [teamProfile?.picture]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const decoded = nip19.decode(LIGHTNING_PIGGY_TEAM_NPUB);
        if (decoded.type !== 'npub') return;
        // Read v2 first, then fall back to the pre-#346 unversioned key so an offline upgrade keeps a cached profile.
        let cached = await AsyncStorage.getItem(TEAM_PROFILE_CACHE_KEY);
        let cameFromLegacy = false;
        if (!cached) {
          cached = await AsyncStorage.getItem(LEGACY_TEAM_PROFILE_CACHE_KEY);
          cameFromLegacy = cached != null;
        }
        if (cached) {
          const parsed = JSON.parse(cached) as NostrProfile;
          if (!cancelled) {
            setTeamProfile(parsed);
            setTeamProfileLoading(false);
          }
          // Migrate the legacy cache forward so subsequent mounts hit v2 directly.
          if (cameFromLegacy) {
            await AsyncStorage.setItem(TEAM_PROFILE_CACHE_KEY, cached);
          }
        }
        const fetched = await fetchProfile(
          decoded.data,
          enabledAppRelays('default', DEFAULT_RELAYS),
        );
        if (!cancelled && fetched) {
          setTeamProfile(fetched);
          await AsyncStorage.setItem(TEAM_PROFILE_CACHE_KEY, JSON.stringify(fetched));
        }
        // Only evict the legacy key after v2 is populated, so an offline upgrade never strands the user with no cache.
        if (await AsyncStorage.getItem(TEAM_PROFILE_CACHE_KEY)) {
          AsyncStorage.removeItem(LEGACY_TEAM_PROFILE_CACHE_KEY).catch(() => {});
        }
      } catch (error) {
        console.warn('Failed to fetch team profile:', error);
      } finally {
        if (!cancelled) setTeamProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [relayScope]);

  return (
    <AccountScreenLayout title={t('aboutScreen.title')}>
      <View style={styles.teamCard}>
        {teamProfileLoading ? (
          <BrandedSpinner size="small" style={styles.loading} />
        ) : teamProfile ? (
          <>
            {teamProfile.banner && (
              <Image
                source={{ uri: teamProfile.banner }}
                style={styles.teamBanner}
                resizeMode="cover"
              />
            )}
            <View style={styles.teamRow}>
              {teamProfile.picture && !teamPictureError ? (
                <ExpoImage
                  source={{ uri: teamProfile.picture }}
                  style={styles.teamPicture}
                  cachePolicy="memory-disk"
                  recyclingKey={teamProfile.picture}
                  autoplay={false}
                  onError={() => setTeamPictureError(true)}
                />
              ) : (
                <View style={styles.teamPicturePlaceholder}>
                  <UserRound size={28} color={colors.textBody} strokeWidth={1.75} />
                </View>
              )}
              <View style={styles.teamInfo}>
                <Text style={styles.teamName}>
                  {teamProfile.displayName || teamProfile.name || t('settingsPages.brand')}
                </Text>
              </View>
            </View>
          </>
        ) : (
          <Text style={styles.teamFallbackText}>{t('aboutScreen.couldNotLoadTeamProfile')}</Text>
        )}
      </View>
      <SettingsSection scope="phone" showHeading={false} testID="about-links-section">
        <SettingsRow
          kind="value"
          icon={Tag}
          title={t('settingsPages.version')}
          value={appVersionLabel}
          subtitleTestID="version-text"
          testID="about-version-row"
          accessibilityLabel={t('aboutScreen.appVersion', { version: appVersionLabel })}
          details={[t('aboutScreen.aboutBody'), teamProfile?.about].filter(Boolean).join('\n\n')}
        />
        <SettingsRow
          kind="external"
          icon={Globe}
          title={t('settingsPages.website')}
          value={t('settingsPages.websiteHost')}
          onPress={() => Linking.openURL('https://www.lightningpiggy.com')}
          accessibilityLabel={t('aboutScreen.openWebsite')}
          testID="about-website-link"
        />
        {teamProfile && (
          <SettingsRow
            kind="navigate"
            icon={MessageCircle}
            title={t('aboutScreen.sendFeedback')}
            onPress={() => setFeedbackSheetOpen(true)}
            testID="feedback-button"
          />
        )}
        <SettingsRow
          kind="external"
          icon={LifeBuoy}
          title={t('settingsPages.support')}
          onPress={() =>
            Linking.openURL('https://github.com/LightningPiggy/lightning-piggy-mobile/issues')
          }
          testID="about-support-link"
        />
        <SettingsRow
          kind="external"
          icon={ScrollText}
          title={t('settingsPages.releaseNotes')}
          onPress={() =>
            Linking.openURL('https://github.com/LightningPiggy/lightning-piggy-mobile/releases')
          }
          testID="about-release-notes-link"
        />
        <SettingsRow
          kind="external"
          icon={Scale}
          title={t('settingsPages.licences')}
          value={t('settingsPages.licenceType')}
          onPress={() =>
            Linking.openURL(
              'https://github.com/LightningPiggy/lightning-piggy-mobile/blob/main/LICENSE',
            )
          }
          testID="about-licences-link"
        />
        {teamProfile?.lud16 && (
          <SettingsRow
            kind="navigate"
            icon={Zap}
            title={t('aboutScreen.zapTheTeam')}
            onPress={() => setZapSheetOpen(true)}
            accessibilityLabel={t('aboutScreen.zapLightningPiggy')}
            testID="zap-team-button"
          />
        )}
      </SettingsSection>

      {teamProfile?.lud16 && (
        <SendSheet
          visible={zapSheetOpen}
          onClose={() => setZapSheetOpen(false)}
          initialAddress={teamProfile.lud16}
          initialPicture={teamProfile.picture || undefined}
          recipientPubkey={teamProfile.pubkey}
        />
      )}
      <FeedbackSheet
        visible={feedbackSheetOpen}
        onClose={() => setFeedbackSheetOpen(false)}
        onSend={createDmSender(dmRecipient(LIGHTNING_PIGGY_TEAM_NPUB), sendDirectMessage)}
        isLoggedIn={isLoggedIn}
        signerType={signerType}
        onLoginPress={() => setLoginSheetOpen(true)}
      />
      <NostrLoginSheet visible={loginSheetOpen} onClose={() => setLoginSheetOpen(false)} />
    </AccountScreenLayout>
  );
};

export default AboutScreen;
