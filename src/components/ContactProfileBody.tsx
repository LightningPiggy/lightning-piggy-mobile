import ProfileErrorBoundary from './ProfileErrorBoundary';
import { sanitizeDisplayText } from '../utils/sanitizeDisplayText';
import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, Share } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Path } from 'react-native-svg';
import MuteNotificationsButton from './MuteNotificationsButton';
import FullscreenImageModal from './FullscreenImageModal';
import { Zap, UserRound, ChevronRight, Share2 } from 'lucide-react-native';
import { npubEncode } from '../services/nostrService';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createContactProfileBodyStyles } from '../styles/ContactProfileBody.styles';
import BrandGradientBackground from './BrandGradientBackground';

export interface ContactProfileBodyData {
  pubkey: string | null;
  name: string;
  picture: string | null;
  banner?: string | null;
  nip05?: string | null;
  // Free-form bio from the friend's kind-0 (NIP-01 `about` field).
  // Optional because legacy callers + phone-only contacts won't have it.
  about?: string | null;
  lightningAddress: string | null;
  source: 'nostr' | 'contacts';
}

interface Props {
  contact: ContactProfileBodyData;
  onZap?: () => void;
  onMessage?: () => void;
  onFollow?: () => void;
  following?: boolean;
  followingBusy?: boolean;
  /** Truthy when we can actually send a zap. Requires the user to have
   * a wallet AND the contact to have a Lightning address. Caller passes
   * the boolean and the human-readable reason for the disabled-state
   * accessibility label. See ContactListItem for the row-level mirror. */
  canZap?: boolean;
  zapDisabledReason?: string;
  // Fires when the user taps "View profile" — host should dismiss the
  // sheet and navigate to the full ContactProfile route.
  onViewFullProfile?: () => void;
}

// Body of ContactProfileSheet — the bottom-sheet preview rendered when
// the user taps a contact row from Friends / Messages / Conversation /
// Group / TransactionList. The full-page ContactProfileScreen built its
// own UI (see #439), so this component is intentionally narrow: avatar,
// name, npub/Lightning toggle QR, and three action affordances —
// Message, Zap, "View profile →". Share / Open-in / NFC-write / Follow
// all live on the full-page route now.
const ContactProfileBody: React.FC<Props> = ({
  contact,
  onZap,
  onMessage,
  onFollow,
  following = false,
  followingBusy = false,
  canZap = false,
  zapDisabledReason,
  onViewFullProfile,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createContactProfileBodyStyles(colors), [colors]);
  const npub = useMemo(
    () => (contact.pubkey ? npubEncode(contact.pubkey) : null),
    [contact.pubkey],
  );
  const [avatarError, setAvatarError] = useState(false);
  // A banner URL that fails to load (404 / offline) falls back to the gradient.
  const [bannerError, setBannerError] = useState(false);
  // Tap the avatar → view the picture full screen (#661).
  const [fullscreenUrl, setFullscreenUrl] = useState<string | null>(null);

  // Share the contact via the OS share sheet — njump.me web link + a plain
  // name line. Replaces the QR box that used to live in this sheet (#666/#18).
  const handleShare = async () => {
    if (!npub) return;
    const webUrl = `https://njump.me/${npub}`;
    try {
      await Share.share({
        message: `${contact.name || t('contactProfileBody.aContact')}\n${webUrl}`,
        url: webUrl,
      });
    } catch {
      // User dismissed / platform rejected — nothing to surface.
    }
  };

  // Reset the error flag when the picture URL changes so a previously-failed
  // avatar gets a fresh chance. No load timeout: expo-image shows the image
  // when ready and fires onError on a genuine failure — the old 8s timeout
  // misfired (flipped to the default icon even while the image was displayed,
  // because onLoad doesn't reliably fire for cached images). Matches
  // ContactListItem's avatar handling.
  useEffect(() => {
    setAvatarError(false);
  }, [contact.picture]);
  useEffect(() => {
    setBannerError(false);
  }, [contact.banner]);

  return (
    <View style={styles.sheetContent}>
      <View style={styles.bannerContainer}>
        {/* No kind-0 banner: a plain brand gradient (not a picture), so it reads
            as "no banner set" rather than something the person chose (#18). */}
        {contact.banner && !bannerError ? (
          <Image
            source={{ uri: contact.banner }}
            style={styles.bannerImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={contact.banner}
            autoplay={false}
            onError={() => setBannerError(true)}
          />
        ) : (
          <BrandGradientBackground />
        )}
        <View style={styles.handleOverlay}>
          <View style={styles.handleBar} />
        </View>
      </View>

      <View style={styles.avatarContainer}>
        {contact.picture && !avatarError ? (
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => setFullscreenUrl(contact.picture)}
            accessibilityRole="imagebutton"
            accessibilityLabel={t('contactProfileBody.viewPictureFullscreen')}
            testID="profile-avatar-fullscreen"
          >
            <Image
              source={{ uri: contact.picture }}
              style={styles.avatar}
              cachePolicy="memory-disk"
              recyclingKey={contact.picture}
              autoplay={false}
              transition={200}
              onError={() => setAvatarError(true)}
            />
          </TouchableOpacity>
        ) : (
          <View style={styles.avatarDefault}>
            <UserRound size={40} color={colors.textBody} strokeWidth={1.5} />
          </View>
        )}
      </View>

      <FullscreenImageModal url={fullscreenUrl} onClose={() => setFullscreenUrl(null)} />

      <Text style={styles.name} numberOfLines={1}>
        {contact.name}
      </Text>

      {contact.nip05 ? (
        <View style={styles.nip05Row}>
          <Text style={styles.nip05} numberOfLines={1}>
            {contact.nip05}
          </Text>
          <Text style={styles.nip05Badge} testID="contact-nip05-unverified">
            {t('profileSafety.unverified')}
          </Text>
        </View>
      ) : null}

      {contact.about && contact.about.trim().length > 0 ? (
        <Text style={styles.about} numberOfLines={3} testID="contact-profile-about">
          {contact.about.trim()}
        </Text>
      ) : null}

      {/* The npub/Lightning QR box was dropped from this quick sheet to keep it
          compact — sharing now lives in the action row's Share button, and the
          full QR is still on the "View profile" page (#666/#18). */}

      {/* Action buttons — always rendered; disabled state when the
          per-button precondition isn't met. The accessibility labels
          disclose *why* a button is disabled (no Nostr key / no
          Lightning address) so power and screen-reader users get the
          full context instead of a silently inert circle. */}
      {contact.pubkey && (
        <MuteNotificationsButton pubkey={contact.pubkey} testID="profile-mute-notifications" />
      )}
      {onFollow && (
        <TouchableOpacity
          onPress={onFollow}
          disabled={followingBusy}
          style={[styles.viewProfileButton, followingBusy && styles.iconCircleButtonDisabled]}
          testID="profile-follow"
          accessibilityRole="button"
          accessibilityState={{ disabled: followingBusy, busy: followingBusy }}
          accessibilityLabel={t(
            following ? 'contactProfileScreen.unfollow' : 'contactProfileScreen.follow',
          )}
        >
          <Text style={styles.viewProfileButtonText}>
            {t(following ? 'contactProfileScreen.unfollow' : 'contactProfileScreen.follow')}
          </Text>
        </TouchableOpacity>
      )}
      <View style={styles.actionRowSheet}>
        {/* Compose the same boolean for `disabled` and `accessibilityState`
            so a button that's inert because the host didn't wire a
            handler is announced as disabled to screen readers (instead
            of being read out as a tappable button that silently does
            nothing on press). Same alignment applied to the zap button. */}
        {(() => {
          const messageDisabled = !contact.pubkey || !onMessage;
          return (
            <TouchableOpacity
              style={[styles.iconCircleButton, messageDisabled && styles.iconCircleButtonDisabled]}
              onPress={messageDisabled ? undefined : onMessage}
              disabled={messageDisabled}
              accessibilityRole="button"
              accessibilityState={{ disabled: messageDisabled }}
              accessibilityLabel={
                messageDisabled
                  ? t('contactProfileBody.messageWithReason', {
                      reason: !contact.pubkey
                        ? t('contactProfileBody.noNostrKey')
                        : t('contactProfileBody.unavailable'),
                    })
                  : t('contactProfileBody.message')
              }
              testID="contact-message-button"
            >
              <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
                <Path
                  d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
                  stroke={messageDisabled ? colors.textSupplementary : colors.white}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </Svg>
            </TouchableOpacity>
          );
        })()}
        {(() => {
          const zapDisabled = !canZap || !onZap;
          // Dimmed-but-tappable when a handler is wired: tapping a greyed zap
          // explains *why* (no wallet / no Lightning address) via the host
          // rather than doing nothing. Only inert when no handler at all.
          return (
            <TouchableOpacity
              style={[
                styles.iconCircleButton,
                styles.iconCircleButtonYellow,
                zapDisabled && styles.iconCircleButtonDisabled,
              ]}
              onPress={onZap}
              disabled={!onZap}
              accessibilityRole="button"
              accessibilityState={{ disabled: !onZap }}
              accessibilityLabel={
                zapDisabled
                  ? t('contactProfileBody.zapWithReason', {
                      reason: zapDisabledReason ?? t('contactProfileBody.unavailable'),
                    })
                  : t('contactProfileBody.zap')
              }
              testID="profile-sheet-zap-button"
            >
              <Zap
                size={20}
                color={zapDisabled ? colors.textSupplementary : colors.white}
                fill={zapDisabled ? 'none' : colors.white}
              />
            </TouchableOpacity>
          );
        })()}
        <TouchableOpacity
          style={[styles.iconCircleButton, !npub && styles.iconCircleButtonDisabled]}
          onPress={npub ? handleShare : undefined}
          disabled={!npub}
          accessibilityRole="button"
          accessibilityState={{ disabled: !npub }}
          accessibilityLabel={
            npub ? t('contactProfileBody.shareContact') : t('contactProfileBody.shareNoNostrKey')
          }
          testID="contact-share-button"
        >
          <Share2
            size={20}
            color={npub ? colors.white : colors.textSupplementary}
            strokeWidth={2}
          />
        </TouchableOpacity>
        {onViewFullProfile ? (
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.viewProfileButton}
            onPress={onViewFullProfile}
            accessibilityLabel={t('contactProfileBody.viewFullProfileA11y')}
            testID="contact-view-full-profile"
          >
            <Text style={styles.viewProfileButtonText}>{t('contactProfileBody.viewProfile')}</Text>
            <ChevronRight size={16} color={colors.white} strokeWidth={2.5} />
          </TouchableOpacity>
        ) : null}
      </View>
    </View>
  );
};

export default React.memo(function GuardedContactProfileBody(props: Props) {
  const contact = {
    ...props.contact,
    name: sanitizeDisplayText(props.contact.name, { maxLen: 64 }),
    nip05: sanitizeDisplayText(props.contact.nip05, { maxLen: 320 }),
    about: sanitizeDisplayText(props.contact.about, { maxLen: 2000, allowNewlines: true }),
  };
  return (
    <ProfileErrorBoundary key={contact.pubkey}>
      <ContactProfileBody {...props} contact={contact} />
    </ProfileErrorBoundary>
  );
});
