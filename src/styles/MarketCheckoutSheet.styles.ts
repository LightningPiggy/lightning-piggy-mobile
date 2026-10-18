import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for the in-app Market checkout bottom sheet (#market). */
export const createMarketCheckoutSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    amountColumn: { flexShrink: 1, textAlign: 'right', marginLeft: 8 },
    sheetBackground: {
      backgroundColor: colors.background,
    },
    handle: {
      backgroundColor: colors.divider,
      width: 40,
    },
    container: {
      paddingHorizontal: 20,
      paddingTop: 4,
      paddingBottom: 28,
    },
    header: { marginHorizontal: -20, marginTop: -4, marginBottom: 16 },
    productRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 20,
    },
    thumb: {
      width: 56,
      height: 56,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    thumbFallback: {
      width: 56,
      height: 56,
      borderRadius: 12,
      backgroundColor: colors.brandPinkLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    thumbFallbackText: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.brandPink,
    },
    productInfo: {
      flex: 1,
    },
    productTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.textHeader,
    },
    productSeller: {
      fontSize: 13,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    unitPrice: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textBody,
      marginTop: 4,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 18,
    },
    rowLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textBody,
    },
    stepper: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
    },
    stepButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      borderWidth: 1.5,
      borderColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepButtonDisabled: {
      borderColor: colors.divider,
    },
    qtyText: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
      minWidth: 24,
      textAlign: 'center',
    },
    summaryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    summaryLabel: {
      fontSize: 14,
      color: colors.textSupplementary,
    },
    summaryValue: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textBody,
    },
    totalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingTop: 14,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
      marginBottom: 20,
    },
    totalLabel: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    totalValue: {
      flexShrink: 1,
      marginLeft: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    totalSats: {
      flexShrink: 1,
      fontSize: 18,
      fontWeight: '800',
      color: colors.textHeader,
    },
    primaryButton: {
      // `alignSelf: 'stretch'` so the button fills its column even inside the
      // centered success view (`sentWrap` uses alignItems:'center', which would
      // otherwise shrink it to hug the label and clip "Go to chat to pay").
      alignSelf: 'stretch',
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.brandPink,
      borderRadius: 14,
      paddingVertical: 15,
      paddingHorizontal: 20,
    },
    primaryButtonDisabled: {
      opacity: 0.6,
    },
    primaryButtonText: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.white,
      // Shrink within the flex row (never overflow/clip) and stay centered
      // when the font is auto-scaled down to fit a tight width.
      flexShrink: 1,
      textAlign: 'center',
    },
    hint: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      marginTop: 12,
      lineHeight: 18,
    },
    errorText: {
      fontSize: 13,
      color: colors.red,
      textAlign: 'center',
      marginTop: 12,
    },
    sentWrap: {
      alignItems: 'center',
      gap: 10,
      paddingVertical: 8,
    },
    sentBadge: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.greenLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sentTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
    },
    sentBody: {
      fontSize: 14,
      color: colors.textBody,
      textAlign: 'center',
      lineHeight: 20,
      paddingHorizontal: 8,
    },
    fallbackLink: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      marginTop: 16,
      paddingVertical: 8,
    },
    fallbackLinkText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.brandPink,
    },
    rememberAddress: { minHeight: 24, justifyContent: 'center' },
    rememberAddressLabel: { marginBottom: 0 },
    addressField: {
      marginBottom: 16,
    },
    addressLabel: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textHeader,
      marginBottom: 6,
    },
    addressInput: {
      minHeight: 48,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.divider,
      backgroundColor: colors.surface,
      color: colors.textBody,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      textAlignVertical: 'center',
    },
    addressCountry: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    addressCountryText: {
      flex: 1,
      color: colors.textBody,
      fontSize: 15,
    },
    addressHint: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 4,
    },
    stockNote: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'right',
      marginTop: -8,
      marginBottom: 12,
    },
  });

export type MarketCheckoutSheetStyles = ReturnType<typeof createMarketCheckoutSheetStyles>;
