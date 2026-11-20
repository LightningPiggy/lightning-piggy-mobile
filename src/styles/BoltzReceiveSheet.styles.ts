import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createBoltzReceiveSheetStyles = (colors: Palette) =>
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
    innerContent: {
      padding: 20,
      paddingBottom: 40,
      alignItems: 'center',
      gap: 12,
    },
    title: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    subtitle: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      paddingHorizontal: 8,
    },
    qrContainer: {
      width: 220,
      height: 220,
      borderRadius: 24,
      backgroundColor: colors.white,
      justifyContent: 'center',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.background,
    },
    addressLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textBody,
      textAlign: 'center',
      paddingHorizontal: 8,
    },
    addressHighlight: {
      color: colors.green,
      fontWeight: '700',
    },
    amountRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: 6,
    },
    amountValue: {
      fontSize: 34,
      fontWeight: '700',
      color: colors.brandPink,
      letterSpacing: 0.5,
      includeFontPadding: false,
    },
    amountUnit: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.brandPink,
      letterSpacing: 1,
    },
    amountFiat: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontWeight: '600',
    },
    feeBreakdown: {
      backgroundColor: colors.surface,
      borderRadius: 10,
      padding: 12,
      alignSelf: 'stretch',
      gap: 4,
    },
    feeRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    feeLabel: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontWeight: '500',
    },
    feeValue: {
      fontSize: 13,
      color: colors.textBody,
      fontWeight: '600',
    },
    statusBlock: {
      alignSelf: 'stretch',
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      gap: 8,
      flexDirection: 'row',
      alignItems: 'center',
    },
    statusBlockSuccess: {
      backgroundColor: colors.green,
    },
    statusBlockError: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.red,
    },
    statusText: {
      flex: 1,
      fontSize: 13,
      fontWeight: '600',
      color: colors.textBody,
    },
    statusTextSuccess: {
      color: colors.white,
    },
    timeoutNote: {
      fontSize: 11,
      color: colors.textSupplementary,
      textAlign: 'center',
      paddingHorizontal: 8,
      fontStyle: 'italic',
    },
    buttonRow: {
      flexDirection: 'row',
      gap: 10,
      alignSelf: 'stretch',
    },
    actionButton: {
      flex: 1,
      minWidth: 0,
      backgroundColor: colors.surface,
      height: 52,
      paddingHorizontal: 12,
      borderRadius: 12,
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: 6,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      elevation: 4,
    },
    actionButtonDisabled: {
      opacity: 0.4,
      elevation: 0,
      shadowOpacity: 0,
    },
    actionButtonPrimary: {
      backgroundColor: colors.brandPink,
    },
    actionButtonText: {
      color: colors.brandPink,
      fontSize: 15,
      fontWeight: '700',
    },
    actionButtonTextPrimary: {
      color: colors.white,
    },
    refundButton: {
      alignSelf: 'stretch',
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.brandPink,
      paddingVertical: 12,
      borderRadius: 12,
      alignItems: 'center',
    },
    refundButtonText: {
      color: colors.brandPink,
      fontSize: 14,
      fontWeight: '700',
    },
    walletLabel: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSupplementary,
    },
    errorText: {
      color: colors.red,
      fontSize: 13,
      textAlign: 'center',
      paddingHorizontal: 12,
    },
    loadingBlock: {
      paddingVertical: 24,
      alignItems: 'center',
      gap: 12,
    },
  });
