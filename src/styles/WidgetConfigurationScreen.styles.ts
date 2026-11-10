import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createWidgetConfigurationScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
    },
    scroll: {
      paddingHorizontal: 20,
      paddingBottom: 24,
    },
    title: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.textHeader,
      marginTop: 8,
    },
    subtitle: {
      fontSize: 14,
      color: colors.textSupplementary,
      marginTop: 4,
      lineHeight: 20,
    },
    previewWrap: {
      alignItems: 'center',
      marginTop: 20,
      paddingVertical: 20,
      borderRadius: 20,
      // A dusky "home screen" backdrop so every style reads as it will on a
      // wallpaper, including the see-through Night glass.
      backgroundColor: '#43306E',
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 24,
      marginBottom: 8,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      overflow: 'hidden',
    },
    cardSpaced: {
      marginTop: 24,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 14,
      minHeight: 52,
    },
    rowDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
    },
    rowText: {
      flex: 1,
    },
    rowTitle: {
      fontSize: 16,
      color: colors.textHeader,
      fontWeight: '600',
    },
    rowHint: {
      fontSize: 13,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    radio: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 2,
      borderColor: colors.divider,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 12,
    },
    radioOn: {
      borderColor: colors.brandPink,
    },
    radioDot: {
      width: 11,
      height: 11,
      borderRadius: 6,
      backgroundColor: colors.brandPink,
    },
    swatch: {
      width: 34,
      height: 34,
      borderRadius: 10,
      marginRight: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
    },
    notice: {
      fontSize: 14,
      color: colors.textBody,
      lineHeight: 20,
      padding: 16,
    },
    footer: {
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
      backgroundColor: colors.background,
    },
    button: {
      flex: 1,
      height: 48,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    buttonSecondary: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.divider,
    },
    buttonPrimary: {
      backgroundColor: colors.brandPink,
    },
    buttonDisabled: {
      opacity: 0.5,
    },
    buttonSecondaryText: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    buttonPrimaryText: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.white,
    },
  });

export type WidgetConfigurationScreenStyles = ReturnType<
  typeof createWidgetConfigurationScreenStyles
>;
