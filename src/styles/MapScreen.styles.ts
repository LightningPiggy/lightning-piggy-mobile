import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// Presentation for the full-screen MapScreen (header, footer, legend,
// cache detail sheet, filter sheet). Extracted per the standing
// "styles live in their own file" convention (CLAUDE.md → File size and
// modularity) — keeps the screen under its over-cap baseline while the
// friends-sharing layer landed.
export const createMapScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingTop: 48,
      paddingBottom: 16,
      backgroundColor: colors.brandPink,
    },
    headerTitle: {
      flex: 1,
      textAlign: 'center',
      fontSize: 18,
      fontWeight: '700',
      color: colors.white,
    },
    headerRightSpacer: {
      width: 24,
    },
    webviewWrapper: {
      flex: 1,
      position: 'relative',
    },
    webview: {
      flex: 1,
    },
    recenterButton: {
      position: 'absolute',
      left: 14,
      bottom: 14,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
    // Legend button — sits just above the recenter at bottom-left so
    // the two map utilities cluster visually. Same surface treatment
    // as recenterButton (white circle + shadow) so they read as a pair.
    legendButton: {
      position: 'absolute',
      left: 14,
      bottom: 62,
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 4,
      shadowOffset: { width: 0, height: 1 },
      elevation: 3,
    },
    footer: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
    },
    footerText: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontWeight: '500',
    },
    footerError: {
      fontSize: 13,
      color: colors.brandPink,
      fontWeight: '600',
    },
    deniedBody: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 32,
      gap: 12,
    },
    deniedTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
      textAlign: 'center',
    },
    deniedSubtitle: {
      fontSize: 14,
      color: colors.textSupplementary,
      textAlign: 'center',
      lineHeight: 20,
    },
    deniedButton: {
      marginTop: 12,
      backgroundColor: colors.brandPink,
      paddingHorizontal: 18,
      paddingVertical: 10,
      borderRadius: 100,
    },
    deniedButtonText: {
      color: colors.white,
      fontSize: 13,
      fontWeight: '700',
    },
    // ----- bottom sheet
    sheetBackdrop: {
      ...StyleSheet.absoluteFillObject,
      justifyContent: 'flex-end',
      backgroundColor: 'rgba(0,0,0,0.4)',
    },
    sheetTapAway: {
      flex: 1,
    },
    sheet: {
      backgroundColor: colors.surface,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 28,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      gap: 8,
      // Cap so the FilterSheet's category list can scroll instead of
      // pushing the sheet off the top of the screen.
      maxHeight: '80%',
    },
    // Touch target around the visible handle bar — bigger than the
    // 4px-tall pill itself so a swipe from anywhere in the top of the
    // sheet actually reaches the PanResponder. Without this you'd
    // need pixel-precise drag aim.
    sheetHandleGrabber: {
      width: '100%',
      paddingVertical: 12,
      alignItems: 'center',
    },
    sheetHandle: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.divider,
      marginBottom: 6,
    },
    sheetTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
    },
    sheetSubtitle: {
      fontSize: 13,
      color: colors.textSupplementary,
    },
    wotRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginTop: 8,
    },
    wotHiddenCount: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
    sheetChipRow: {
      flexDirection: 'row',
      gap: 8,
      marginTop: 6,
    },
    sheetChipPink: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: colors.brandPink,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 100,
    },
    sheetChipPinkText: {
      color: colors.white,
      fontSize: 11,
      fontWeight: '700',
    },
    sheetChipGrey: {
      backgroundColor: colors.divider,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 100,
    },
    sheetChipGreyText: {
      color: colors.textSupplementary,
      fontSize: 11,
      fontWeight: '700',
    },
    sheetDescription: {
      fontSize: 13,
      color: colors.textBody,
      lineHeight: 18,
      marginTop: 8,
      marginBottom: 4,
    },
    sheetActions: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 14,
    },
    sheetButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      backgroundColor: colors.brandPink,
      paddingVertical: 12,
      borderRadius: 100,
    },
    sheetButtonText: {
      color: colors.white,
      fontSize: 14,
      fontWeight: '700',
    },
    sheetTitleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 4,
    },
    sheetIconWrap: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    filterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    filterSwatchDot: {
      width: 18,
      height: 18,
      borderRadius: 9,
    },
    filterSwatchDiamond: {
      width: 14,
      height: 14,
      transform: [{ rotate: '45deg' }],
    },
    filterTextWrap: {
      flex: 1,
    },
    filterLabel: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.textHeader,
    },
    filterHint: {
      fontSize: 11,
      color: colors.textSupplementary,
      marginTop: 1,
    },
    filterToggle: {
      width: 40,
      height: 24,
      borderRadius: 12,
      backgroundColor: colors.divider,
      padding: 2,
      justifyContent: 'center',
    },
    filterToggleOn: {
      backgroundColor: colors.brandPink,
    },
    filterToggleThumb: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: colors.white, // White thumb contrasts toggle track
    },
    filterToggleThumbOn: {
      transform: [{ translateX: 16 }],
    },
    categoryHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    categoryClearText: {
      color: colors.brandPink,
      fontSize: 13,
      fontWeight: '700',
    },
    categoryChipsWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 10,
    },
    categoryChip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
    },
    categoryChipOff: {
      backgroundColor: 'transparent',
      borderColor: colors.divider,
    },
    categoryChipOn: {
      backgroundColor: colors.brandPink,
      borderColor: colors.brandPink,
    },
    categoryChipText: {
      fontSize: 12,
      color: colors.textHeader,
      fontWeight: '600',
      textTransform: 'capitalize',
    },
    categoryChipTextOn: {
      color: colors.white,
    },
  });

export type MapScreenStyles = ReturnType<typeof createMapScreenStyles>;
