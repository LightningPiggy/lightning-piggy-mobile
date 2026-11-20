import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createTipSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: {
      backgroundColor: colors.background,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    handleIndicator: {
      backgroundColor: colors.divider,
      width: 40,
    },
    content: {
      flex: 1,
    },
    scrollView: {
      flex: 1,
    },
    scrollContent: {
      padding: 24,
      alignItems: 'center',
      gap: 12,
      paddingBottom: 40,
    },
    qrContainer: {
      width: 240,
      height: 240,
      borderRadius: 16,
      backgroundColor: colors.surface,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 20,
    },
    qrContainerShowingQr: {
      backgroundColor: colors.white,
    },
    amountLabel: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontWeight: '600',
      marginTop: 4,
    },
    amountSats: {
      fontSize: 28,
      fontWeight: '700',
      color: colors.brandPink,
    },
    amountFiat: {
      fontSize: 14,
      color: colors.textSupplementary,
      fontWeight: '600',
    },
    actionRow: {
      flexDirection: 'row',
      gap: 12,
      marginTop: 4,
    },
    actionButton: {
      backgroundColor: colors.surface,
      paddingHorizontal: 20,
      height: 40,
      borderRadius: 10,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.1,
      shadowRadius: 6,
      elevation: 2,
    },
    actionButtonText: {
      color: colors.brandPink,
      fontSize: 14,
      fontWeight: '700',
    },
    instructionText: {
      fontSize: 14,
      color: colors.textBody,
      textAlign: 'center',
      lineHeight: 22,
      marginTop: 4,
    },
    quizSection: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 16,
      width: '100%',
      gap: 10,
    },
    quizTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.textHeader,
      marginBottom: 4,
    },
    quizRow: {
      flexDirection: 'row',
      gap: 10,
      alignItems: 'flex-start',
    },
    quizDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.brandPink,
      marginTop: 6,
      flexShrink: 0,
    },
    quizText: {
      fontSize: 13,
      color: colors.textBody,
      lineHeight: 20,
      flex: 1,
    },
    successOverlay: {
      alignItems: 'center',
      gap: 12,
    },
    successText: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.green,
    },
    errorText: {
      fontSize: 14,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
    closeButton: {
      backgroundColor: colors.surface,
      height: 52,
      paddingHorizontal: 40,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      elevation: 4,
    },
    closeButtonText: {
      color: colors.brandPink,
      fontSize: 16,
      fontWeight: '700',
    },
  });
