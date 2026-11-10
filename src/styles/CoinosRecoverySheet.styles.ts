import { StyleSheet, Platform } from 'react-native';
import type { Palette } from './palettes';

export const createCoinosRecoverySheetStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    handle: {
      backgroundColor: colors.divider,
      width: 40,
    },
    content: {
      padding: 24,
      paddingBottom: 40,
      gap: 14,
      alignItems: 'stretch',
    },
    iconBubble: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'center',
      marginBottom: 4,
    },
    title: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.textHeader,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 14,
      color: colors.textSupplementary,
      lineHeight: 20,
      textAlign: 'center',
      marginBottom: 8,
    },
    row: {
      backgroundColor: colors.background,
      borderRadius: 12,
      padding: 14,
      gap: 6,
    },
    rowLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.textSupplementary,
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    rowValueWrap: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 12,
    },
    rowValue: {
      flex: 1,
      fontSize: 14,
      color: colors.textBody,
    },
    mono: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      fontSize: 12,
    },
    copyButton: {
      paddingTop: 2,
    },
    copyConfirm: {
      fontSize: 13,
      color: colors.green,
      textAlign: 'center',
      fontWeight: '600',
    },
    primaryButton: {
      marginTop: 16,
      backgroundColor: colors.brandPink,
      height: 52,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
    },
    primaryButtonText: {
      color: colors.white,
      fontSize: 16,
      fontWeight: '700',
    },
  });
