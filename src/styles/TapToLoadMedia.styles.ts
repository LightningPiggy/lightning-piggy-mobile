import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// Presentation for the tap-to-load placeholder shown in place of chat media
// from senders the reader doesn't follow (#1338). Only the link-preview card
// sits on our pink bubble, so only it uses `fromMe`'s white text; the image
// box and thumbnail tile are light boxes, read the same in any bubble (our own
// media shows one too when its link is blocked).
export const createTapToLoadMediaStyles = (colors: Palette, fromMe: boolean) =>
  StyleSheet.create({
    // Link-preview variant: a card the same shape as MessageLinkPreview.
    previewCard: {
      marginTop: 6,
      borderRadius: 12,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: fromMe ? 'rgba(255,255,255,0.4)' : colors.brandPink,
      backgroundColor: fromMe ? 'rgba(255,255,255,0.08)' : colors.surface,
      maxWidth: 280,
      paddingHorizontal: 12,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    // Image variant: fills the bubble; the caller supplies the bounded aspect.
    // Pale brand pink with a dashed pink edge, like the file card's "tap to
    // load": the text stays dark (pink text on this tint is only ~3.9:1).
    imageBox: {
      width: '100%',
      aspectRatio: 1,
      borderWidth: 1,
      borderStyle: 'dashed',
      borderColor: colors.brandPink,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 16,
      gap: 6,
    },
    // Thumb variant: fills a profile thumbnail / media tile.
    thumbBox: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 6,
      gap: 4,
    },
    // Applied after the caller's style, which sets its own background.
    boxTint: {
      backgroundColor: colors.mediaBoxFill,
    },
    thumbLabel: {
      fontSize: 11,
      fontWeight: '600',
      textAlign: 'center',
      color: colors.mediaBoxAction,
    },
    textCol: {
      flexShrink: 1,
      gap: 2,
    },
    label: {
      fontSize: 14,
      fontWeight: '700',
      color: fromMe ? colors.white : colors.textHeader,
    },
    // The image box / thumbnail tile: light, whoever sent the message.
    boxLabel: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.textHeader,
    },
    // The action line ("Tap to load …", "Tap to retry"): dark ink on the
    // pale pink box, brand pink on the neutral dark one.
    boxAction: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.mediaBoxAction,
    },
    boxHost: {
      fontSize: 12,
      // textBody, not textSupplementary: small text on the light box needs
      // ≥4.5:1 on the pale pink box (supplementary grey falls short).
      color: colors.textBody,
    },
    labelCentered: {
      textAlign: 'center',
    },
    host: {
      fontSize: 12,
      color: fromMe ? 'rgba(255,255,255,0.75)' : colors.textSupplementary,
    },
  });
