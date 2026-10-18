import { CHAT_CARD_MAX_WIDTH } from './chatCardWidth';
import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/**
 * "Add NWC Wallet" conversation card (recipient side) + the sender's own
 * "Shared" copy. Presentation only — extracted per the repo convention that
 * every component's StyleSheet lives in its own `src/styles/<Name>.styles.ts`.
 */
export const createNwcShareCardStyles = (colors: Palette, cardWidth = CHAT_CARD_MAX_WIDTH) =>
  StyleSheet.create({
    row: {
      paddingVertical: 4,
    },
    rowLeft: {
      alignSelf: 'flex-start',
    },
    rowRight: {
      alignSelf: 'flex-end',
    },
    card: {
      width: cardWidth,
      backgroundColor: colors.surface,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.divider,
      padding: 16,
      gap: 12,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    headerIcon: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.brandPinkLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerLabel: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.textHeader,
      flexShrink: 1,
    },
    walletName: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textBody,
    },
    qrWrap: {
      alignSelf: 'center',
      backgroundColor: colors.white, // White quiet zone preserves QR scanning
      padding: 12,
      borderRadius: 12,
    },
    warningBox: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      backgroundColor: colors.amber,
      borderRadius: 10,
      padding: 10,
    },
    warningText: {
      flex: 1,
      fontSize: 12,
      fontWeight: '600',
      color: colors.white,
      lineHeight: 16,
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.brandPink,
      borderRadius: 12,
      paddingVertical: 12,
    },
    addButtonText: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.white,
    },
    sharedCaption: {
      fontSize: 12,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
    time: {
      fontSize: 11,
      color: colors.textSupplementary,
      alignSelf: 'flex-end',
    },
  });

export type NwcShareCardStyles = ReturnType<typeof createNwcShareCardStyles>;
