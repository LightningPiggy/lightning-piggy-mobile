import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createWebOfTrustBottomSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
    sheet: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      maxHeight: '85%',
      backgroundColor: colors.background,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingBottom: 28,
      paddingTop: 8,
    },
    handleBar: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.divider,
      marginBottom: 10,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 4,
    },
    title: {
      flex: 1,
      fontSize: 20,
      fontWeight: '800',
      color: colors.textHeader,
    },
    // Shrink to fit the sheet's maxHeight (RN defaults flexShrink to 0, which
    // let the content overflow under the fixed Done button on short phones).
    scroll: {
      flexGrow: 0,
      flexShrink: 1,
    },
    scrollContent: {
      paddingBottom: 8,
    },
    explainer: {
      fontSize: 13,
      lineHeight: 19,
      color: colors.textBody,
      marginTop: 10,
      marginBottom: 18,
    },
    tierCard: {
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.divider,
      marginBottom: 8,
      backgroundColor: colors.surface,
      overflow: 'hidden',
    },
    tierCardActive: {
      borderColor: colors.zapYellow,
      backgroundColor: 'rgba(255, 193, 7, 0.10)',
    },
    tierRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
    },
    // Status attached under a tier's row, inside the same card. Indented to
    // line up with the title (icon 28 + gap 12 + row padding 12).
    tierExtras: {
      paddingLeft: 52,
      paddingRight: 12,
      paddingBottom: 12,
      marginTop: -4,
    },
    tierIcon: {
      width: 28,
      alignItems: 'center',
    },
    tierBody: {
      flex: 1,
    },
    tierTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.textHeader,
    },
    tierSubtitle: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 2,
      lineHeight: 16,
    },
    radioOuter: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: colors.divider,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioOuterActive: {
      borderColor: colors.zapYellow,
    },
    radioInner: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.zapYellow,
    },
    gateHint: {
      marginTop: 8,
      fontSize: 12,
      color: colors.textSupplementary,
      fontStyle: 'italic',
      lineHeight: 17,
    },
    fofPanel: {
      gap: 10,
    },
    fofPanelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    fofPanelText: {
      flex: 1,
      fontSize: 13,
      color: colors.textBody,
      lineHeight: 18,
    },
    fofTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.divider,
      overflow: 'hidden',
    },
    fofFill: {
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.zapYellow,
    },
    fofCancelButton: {
      alignSelf: 'flex-end',
      paddingVertical: 6,
      paddingHorizontal: 14,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.divider,
    },
    fofCancelText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textHeader,
    },
    metaText: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
    errorText: {
      fontSize: 12,
      lineHeight: 17,
      color: colors.brandPink,
    },
    doneButton: {
      marginTop: 16,
      paddingVertical: 14,
      borderRadius: 999,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
    },
    doneText: {
      color: colors.white,
      fontSize: 15,
      fontWeight: '700',
    },
  });

export type WebOfTrustBottomSheetStyles = ReturnType<typeof createWebOfTrustBottomSheetStyles>;
