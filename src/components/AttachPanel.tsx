import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import {
  MapPin,
  Zap,
  Receipt,
  UserRound,
  ImagePlus,
  Camera,
  Smile,
  BarChart3,
  Mic,
  FileText,
  Wallet,
} from 'lucide-react-native';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createAttachPanelStyles } from '../styles/AttachPanel.styles';

interface Props {
  onShareLocation: () => void;
  // `onSendZap` greys out (instead of vanishing) when `zapDisabled` is
  // set — used in two cases: (1) 1:1 chats where the peer has no
  // Lightning Address, and (2) group chats where there's no single
  // recipient to zap. In both, surfacing-but-disabled reads better than
  // a missing tile, since users expect parity across chat types (#237).
  // Callers that genuinely don't want the tile (no zap support at all)
  // can still omit `onSendZap` to make it disappear.
  onSendZap?: () => void;
  zapDisabled?: boolean;
  // Optional override for the disabled-zap a11y label. Lets call sites
  // explain *why* the tile is disabled (e.g. "peer has no Lightning
  // Address" in 1:1 vs. "no single recipient in groups") rather than the
  // generic fallback. Only consulted when `zapDisabled` is set.
  zapAccessibilityLabel?: string;
  onSendInvoice?: () => void;
  onShareContact?: () => void;
  onSendImage?: () => void;
  onSendFile?: () => void;
  onTakePhoto?: () => void;
  onSendGif?: () => void;
  // Optional: opens the PollComposerSheet. Omitted (= tile hidden) when
  // the host chat doesn't support polls — currently always available
  // when the rest of the composer is, so the tile is shown by default.
  onSharePoll?: () => void;
  /**
   * Opens the NWC wallet picker to share a connected wallet with the peer
   * (#431). Omitted in builds/contexts without wallet sharing.
   */
  onShareWallet?: () => void;
  // Greys the Wallet tile out (like `zapDisabled`). Groups set it: a wallet
  // connection is a bearer secret, so it's only shared 1:1, never with a group.
  walletDisabled?: boolean;
  // Explains why the Wallet tile is disabled. Only consulted with `walletDisabled`.
  walletAccessibilityLabel?: string;
  /**
   * Opens the voice-note recording sheet (#235). Same surface as
   * Image / Camera / GIF / Location — the sheet records a clip and
   * uploads it to Blossom; the resulting URL is sent as the message
   * body so other Nostr clients render an inline audio player from
   * the file extension.
   */
  onSendVoiceNote?: () => void;
}

interface Tile {
  key: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  testID: string;
  accessibilityLabel: string;
  disabled?: boolean;
}

/**
 * WhatsApp-style inline attachment panel — a flat 4-column grid sized
 * intrinsically by its content and rendered above the composer by the
 * parent (ConversationScreen). When opened, the parent dismisses the
 * IME rather than sizing this panel to match a cached keyboard height.
 * No sheet chrome, no backdrop, no rounded top corners — the effect
 * should still feel like the keyboard *morphed* into icons.
 */
const AttachPanel: React.FC<Props> = ({
  onShareLocation,
  onSendZap,
  zapDisabled,
  zapAccessibilityLabel,
  onSendInvoice,
  onShareContact,
  onSendImage,
  onSendFile,
  onTakePhoto,
  onSendGif,
  onSharePoll,
  onSendVoiceNote,
  onShareWallet,
  walletDisabled,
  walletAccessibilityLabel,
}) => {
  const { t } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createAttachPanelStyles(colors), [colors]);

  // Build the visible tile list in display order. Tiles whose callback
  // wasn't provided (because the feature is unavailable in this build)
  // are filtered out. Tiles whose feature is conditional on peer state
  // (currently: Zap requires a Lightning Address) always render but
  // grey out via the `disabled` flag so users can see the capability
  // exists.
  const tiles: Tile[] = (
    [
      onTakePhoto && {
        key: 'camera',
        label: 'Camera',
        icon: <Camera size={26} color={colors.white} />,
        onPress: onTakePhoto,
        testID: 'attach-take-photo',
        accessibilityLabel: 'Take a photo with the camera',
      },
      onSendImage && {
        key: 'gallery',
        label: 'Gallery',
        icon: <ImagePlus size={26} color={colors.white} />,
        onPress: onSendImage,
        testID: 'attach-send-image',
        accessibilityLabel: 'Send an image from the gallery',
      },
      onSendFile && {
        key: 'file',
        label: t('messageBubble.file'),
        icon: <FileText size={26} color={colors.white} />,
        onPress: onSendFile,
        testID: 'attach-send-file',
        accessibilityLabel: t('messageBubble.file'),
      },
      onSendGif && {
        key: 'gif',
        label: 'GIF',
        icon: <Smile size={26} color={colors.white} />,
        onPress: onSendGif,
        testID: 'attach-send-gif',
        accessibilityLabel: 'Send a GIF',
      },
      onSendVoiceNote && {
        key: 'voice',
        label: 'Voice',
        icon: <Mic size={26} color={colors.white} />,
        onPress: onSendVoiceNote,
        testID: 'attach-tile-voice',
        accessibilityLabel: 'Record and send a voice note',
      },
      {
        key: 'location',
        label: 'Location',
        icon: <MapPin size={26} color={colors.white} />,
        onPress: onShareLocation,
        testID: 'attach-share-location',
        accessibilityLabel: 'Share your current location',
      },
      onSendZap && {
        key: 'zap',
        label: 'Zap',
        icon: <Zap size={26} color={colors.white} fill={colors.white} />,
        onPress: onSendZap,
        testID: 'attach-send-zap',
        accessibilityLabel: zapDisabled
          ? (zapAccessibilityLabel ?? 'Send a zap (unavailable)')
          : 'Send a zap',
        disabled: zapDisabled,
      },
      onSendInvoice && {
        key: 'invoice',
        label: 'Invoice',
        icon: <Receipt size={26} color={colors.white} />,
        onPress: onSendInvoice,
        testID: 'attach-send-invoice',
        accessibilityLabel: 'Send an invoice',
      },
      onShareContact && {
        key: 'contact',
        label: 'Contact',
        icon: <UserRound size={26} color={colors.white} />,
        onPress: onShareContact,
        testID: 'attach-share-contact',
        accessibilityLabel: "Share a contact's profile",
      },
      onShareWallet && {
        key: 'wallet',
        label: 'Wallet',
        icon: <Wallet size={26} color={colors.white} />,
        onPress: onShareWallet,
        testID: 'attach-share-wallet',
        accessibilityLabel: walletDisabled
          ? (walletAccessibilityLabel ?? 'Share a wallet (unavailable)')
          : 'Share a connected NWC wallet',
        disabled: walletDisabled,
      },
      onSharePoll && {
        key: 'poll',
        label: 'Poll',
        icon: <BarChart3 size={26} color={colors.white} />,
        onPress: onSharePoll,
        testID: 'attach-share-poll',
        accessibilityLabel: 'Share a poll for the recipient to vote on',
      },
    ] as (Tile | false | undefined)[]
  ).filter((t): t is Tile => Boolean(t));

  return (
    <View style={styles.panel} testID="conversation-attach-panel">
      <View style={styles.grid}>
        {tiles.map((tile) => (
          <TouchableOpacity
            key={tile.key}
            style={[styles.tile, tile.disabled && styles.tileDisabled]}
            onPress={tile.onPress}
            disabled={tile.disabled}
            accessibilityLabel={tile.accessibilityLabel}
            accessibilityState={{ disabled: !!tile.disabled }}
            testID={tile.testID}
          >
            <View style={styles.iconCircle}>{tile.icon}</View>
            <Text style={styles.label} numberOfLines={1}>
              {tile.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
};

export default AttachPanel;
