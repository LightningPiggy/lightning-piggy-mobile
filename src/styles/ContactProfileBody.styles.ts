import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createContactProfileBodyStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetContent: {
      alignItems: 'center',
      // 32 matches the other dynamic-sized sheets (AccountSwitcherSheet) so the
      // bottom gap is consistent — the old 80 left a big white margin once the
      // sheet switched to content-based dynamic sizing (#18).
      paddingBottom: 32,
    },
    handleOverlay: {
      position: 'absolute',
      top: 8,
      left: 0,
      right: 0,
      alignItems: 'center',
    },
    handleBar: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: 'rgba(255,255,255,0.6)',
    },
    bannerContainer: {
      width: '100%',
      height: 100,
      backgroundColor: colors.brandPinkLight,
      overflow: 'hidden',
      // Match the sheet's 24px top corners (ContactProfileSheet.sheetBackground)
      // so the banner doesn't square off the rounded sheet (#18).
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    bannerImage: {
      width: '100%',
      height: '100%',
    },
    avatarContainer: {
      marginTop: -36,
      width: 88,
      height: 88,
      borderRadius: 44,
      backgroundColor: colors.surface,
      padding: 4,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatar: {
      width: 80,
      height: 80,
      borderRadius: 40,
    },
    avatarDefault: {
      width: 80,
      height: 80,
      borderRadius: 40,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    name: {
      fontSize: 18,
      fontWeight: '800',
      color: colors.textHeader,
      textAlign: 'center',
      marginTop: 12,
      paddingHorizontal: 24,
    },
    // Handle + "unverified" badge side by side: the handle may truncate, the
    // badge never does, so a long nip05 can't push the label off-screen.
    nip05Row: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'center',
      marginTop: 2,
      paddingHorizontal: 24,
    },
    nip05: {
      fontSize: 13,
      color: colors.textSupplementary,
      flexShrink: 1,
    },
    nip05Badge: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontStyle: 'italic',
      flexShrink: 0,
      marginLeft: 6,
    },
    about: {
      fontSize: 14,
      lineHeight: 20,
      color: colors.textBody,
      textAlign: 'center',
      marginTop: 10,
      paddingHorizontal: 28,
    },
    actionRowSheet: {
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 16,
      paddingVertical: 12,
      marginTop: 4,
    },
    iconCircleButton: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    iconCircleButtonDisabled: {
      backgroundColor: colors.divider,
    },
    iconCircleButtonYellow: {
      backgroundColor: colors.zapYellow,
    },
    viewProfileButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      height: 52,
      paddingHorizontal: 18,
      borderRadius: 26,
      backgroundColor: colors.brandPink,
    },
    viewProfileButtonText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.white,
    },
  });
