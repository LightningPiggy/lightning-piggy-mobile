import ProfileErrorBoundary from '../ProfileErrorBoundary';
import { sanitizeDisplayText } from '../../utils/sanitizeDisplayText';
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { QrCode, Zap, MessageCircle, UserRound, Copy } from 'lucide-react-native';
import Toast from '../BrandedToast';
import NostrContent from '../nostr/NostrContent';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import type { ContactProfileBodyData } from '../ContactProfileBody';
import type { ContactProfileScreenStyles } from '../../styles/ContactProfileScreen.styles';
import BrandGradientBackground from '../BrandGradientBackground';

interface Props {
  contact: ContactProfileBodyData;
  styles: ContactProfileScreenStyles;
  npub: string | null;
  hasWallets: boolean;
  following: boolean;
  loadingFollow: boolean;
  showFollowButton: boolean;
  /** Phone contacts can have a Lightning address typed in by hand. */
  canEditLnAddress: boolean;
  onOpenImage: (url: string) => void;
  onQr: () => void;
  onZap: () => void;
  onMessage: () => void;
  onFollowToggle: () => void;
  onCopyNpub: () => void;
  onCopyLnAddress: () => void;
  onSaveLightningAddress: (address: string) => Promise<void>;
}

/**
 * Identity block at the top of the profile page (#435 / #439 / #1332):
 * banner, the avatar overlapping it, the QR / zap / message buttons and the
 * Follow pill on one row, then name, NIP-05, npub, Lightning address and the
 * bio (rendered through NostrContent so `nostr:` mentions become chips).
 * Rendered as the profile list's header, above the tab bar.
 */
const ContactProfileHeader: React.FC<Props> = ({
  contact,
  styles,
  npub,
  hasWallets,
  following,
  loadingFollow,
  showFollowButton,
  canEditLnAddress,
  onOpenImage,
  onQr,
  onZap,
  onMessage,
  onFollowToggle,
  onCopyNpub,
  onCopyLnAddress,
  onSaveLightningAddress,
}) => {
  const t = useTranslation();
  const colors = useThemeColors();
  const [avatarError, setAvatarError] = useState(false);
  // A banner URL that fails to load (404 / offline) falls back to the gradient.
  const [bannerError, setBannerError] = useState(false);
  const [editingLnAddress, setEditingLnAddress] = useState(false);
  const [lnAddressDraft, setLnAddressDraft] = useState(contact.lightningAddress ?? '');
  const [savingLnAddress, setSavingLnAddress] = useState(false);
  const npubDisplay = npub ? `${npub.slice(0, 12)}...${npub.slice(-6)}` : null;

  // Reset the avatar error when the picture changes (no load timeout — rely
  // on onError, like ContactListItem).
  useEffect(() => {
    setAvatarError(false);
  }, [contact.picture]);
  useEffect(() => {
    setBannerError(false);
  }, [contact.banner]);

  useEffect(() => {
    setEditingLnAddress(false);
    setLnAddressDraft(contact.lightningAddress ?? '');
  }, [contact.name, contact.lightningAddress]);

  const saveLnAddress = async () => {
    const trimmed = lnAddressDraft.trim();
    if (!trimmed) {
      setEditingLnAddress(false);
      return;
    }
    setSavingLnAddress(true);
    try {
      await onSaveLightningAddress(trimmed);
      // Only leave edit mode after a successful save so a failed write can be
      // retried without retyping.
      setEditingLnAddress(false);
    } catch {
      Toast.show({
        type: 'error',
        text1: t('contactProfileScreen.failedToSaveLightningAddress'),
        position: 'top',
        visibilityTime: 3000,
      });
    } finally {
      setSavingLnAddress(false);
    }
  };

  const zapDisabled = !hasWallets || !contact.lightningAddress;

  return (
    <View>
      {/* Banner — the contact's own if set, else a plain brand gradient, so a
          missing banner never looks like a picture the person chose. */}
      <View style={styles.bannerContainer} testID="contact-profile-banner">
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
      </View>

      {/* Avatar left (overlapping the banner); buttons + Follow right, one row. */}
      <View style={styles.identityRow}>
        <View style={styles.avatarContainer}>
          {contact.picture && !avatarError ? (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => contact.picture && onOpenImage(contact.picture)}
              accessibilityRole="imagebutton"
              accessibilityLabel={t('contactProfileScreen.viewProfilePictureFullScreen')}
              testID="profile-screen-avatar-fullscreen"
            >
              <Image
                source={{ uri: contact.picture }}
                style={styles.avatar}
                cachePolicy="memory-disk"
                transition={200}
                recyclingKey={contact.picture}
                autoplay={false}
                onError={() => setAvatarError(true)}
              />
            </TouchableOpacity>
          ) : (
            <View style={styles.avatarDefault}>
              <UserRound size={44} color={colors.textBody} strokeWidth={1.5} />
            </View>
          )}
        </View>

        <View style={styles.identityActionsBlock} testID="contact-profile-actions-row">
          <View style={styles.actionIconGroup}>
            {npub && (
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.actionIconButton}
                onPress={onQr}
                accessibilityLabel={t('contactProfileScreen.showQrCode')}
                testID="contact-profile-qr-button"
              >
                <QrCode size={20} color={colors.white} />
              </TouchableOpacity>
            )}
            {/* Always shown; greyed when a zap can't go out (no wallet or no
                Lightning address). Tapping it then explains which is missing. */}
            <TouchableOpacity
              style={[styles.actionIconButton, zapDisabled && styles.actionIconButtonDisabled]}
              onPress={onZap}
              accessibilityRole="button"
              accessibilityLabel={
                !hasWallets
                  ? t('contactProfileScreen.zapNoWallet')
                  : contact.lightningAddress
                    ? t('contactProfileScreen.zap')
                    : t('contactProfileScreen.zapNoLightningAddress')
              }
              testID="contact-profile-zap-button"
            >
              <Zap size={20} color={colors.white} />
            </TouchableOpacity>
            {contact.pubkey && (
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.actionIconButton}
                onPress={onMessage}
                accessibilityLabel={t('contactProfileScreen.message')}
                testID="contact-profile-message-button"
              >
                <MessageCircle size={20} color={colors.white} />
              </TouchableOpacity>
            )}
          </View>

          {showFollowButton && (
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: loadingFollow, busy: loadingFollow }}
              style={[styles.followButton, following && styles.followingButton]}
              onPress={onFollowToggle}
              disabled={loadingFollow}
              accessibilityLabel={
                following ? t('contactProfileScreen.unfollow') : t('contactProfileScreen.follow')
              }
              testID="contact-profile-follow-button"
            >
              <Text
                style={[styles.followButtonText, following && styles.followingButtonText]}
                numberOfLines={1}
              >
                {loadingFollow
                  ? '...'
                  : following
                    ? t('contactProfileScreen.following')
                    : t('contactProfileScreen.follow')}
              </Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      <Text style={styles.name} numberOfLines={1}>
        {contact.name}
      </Text>

      {contact.nip05 && (
        <View style={styles.nip05Row}>
          <Text style={styles.nip05} numberOfLines={1}>
            {contact.nip05}
          </Text>
          <Text style={styles.nip05Badge} testID="contact-nip05-unverified">
            {t('profileSafety.unverified')}
          </Text>
        </View>
      )}

      {npubDisplay && (
        <TouchableOpacity
          accessibilityRole="button"
          style={styles.npubRow}
          onPress={onCopyNpub}
          accessibilityLabel={t('contactProfileScreen.copyNpub')}
          testID="contact-copy-npub-button"
        >
          <Text style={styles.npubText}>{npubDisplay}</Text>
          <Copy size={16} color={colors.brandPink} />
        </TouchableOpacity>
      )}

      {/* Editable (phone contact) or copyable lud16 row. */}
      {canEditLnAddress ? (
        editingLnAddress ? (
          <View style={styles.lnAddressEditRow}>
            <TextInput
              style={styles.lnAddressInput}
              placeholder={t('contactProfileScreen.lnAddressPlaceholder')}
              placeholderTextColor={colors.textSupplementary}
              value={lnAddressDraft}
              onChangeText={setLnAddressDraft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: savingLnAddress }}
              style={styles.lnAddressSaveButton}
              disabled={savingLnAddress}
              onPress={saveLnAddress}
            >
              <Text style={styles.lnAddressSaveText}>
                {lnAddressDraft.trim()
                  ? t('contactProfileScreen.save')
                  : t('contactProfileScreen.cancel')}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.lnAddressRow}
            onPress={() => {
              setLnAddressDraft(contact.lightningAddress ?? '');
              setEditingLnAddress(true);
            }}
          >
            <Text style={styles.lightningAddress} numberOfLines={1}>
              {contact.lightningAddress || t('contactProfileScreen.addLightningAddress')}
            </Text>
          </TouchableOpacity>
        )
      ) : contact.lightningAddress ? (
        <TouchableOpacity
          accessibilityRole="button"
          style={styles.lnAddressRow}
          onPress={onCopyLnAddress}
          accessibilityLabel={t('contactProfileScreen.copyLightningAddress')}
          testID="contact-copy-lud16-button"
        >
          <Text style={styles.lightningAddress} numberOfLines={1}>
            {contact.lightningAddress}
          </Text>
          <Copy size={14} color={colors.brandPink} />
        </TouchableOpacity>
      ) : null}

      {/* Bio — NIP-27 aware, so `nostr:nprofile…` renders as an @Name chip. */}
      {contact.about && contact.about.trim().length > 0 && (
        <View style={styles.aboutContainer}>
          <NostrContent
            content={contact.about.trim()}
            onImagePress={onOpenImage}
            authorPubkey={contact.pubkey}
            testID="contact-profile-about"
          />
        </View>
      )}
    </View>
  );
};

export default React.memo(function GuardedContactProfileHeader(props: Props) {
  const contact = {
    ...props.contact,
    name: sanitizeDisplayText(props.contact.name, { maxLen: 64 }),
    nip05: sanitizeDisplayText(props.contact.nip05, { maxLen: 320 }),
    about: sanitizeDisplayText(props.contact.about, { maxLen: 2000, allowNewlines: true }),
  };
  return (
    <ProfileErrorBoundary key={contact.pubkey}>
      <ContactProfileHeader {...props} contact={contact} />
    </ProfileErrorBoundary>
  );
});
