import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** "Send invoice" confirm sheet for an incoming Gamma order. */
export const createSellerInvoiceSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: { backgroundColor: colors.background },
    handle: { backgroundColor: colors.divider, width: 40 },
    container: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 28, gap: 14 },
    title: { fontSize: 20, fontWeight: '700', color: colors.textHeader },
    subtitle: { fontSize: 13, color: colors.textSupplementary, marginTop: -8 },
    totalRow: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      paddingVertical: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
    },
    totalLabel: { fontSize: 16, fontWeight: '700', color: colors.textHeader },
    totalValue: { alignItems: 'flex-end' },
    totalSats: { fontSize: 20, fontWeight: '800', color: colors.brandPink },
    totalFiat: { fontSize: 13, color: colors.textSupplementary, marginTop: 2 },
    warning: {
      fontSize: 13,
      color: colors.textBody,
      backgroundColor: colors.zapYellowLight,
      borderRadius: 10,
      padding: 10,
    },
    remember: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
    checkbox: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 2,
      borderColor: colors.divider,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxOn: { borderColor: colors.brandPink, backgroundColor: colors.brandPink },
    rememberText: { flex: 1, fontSize: 14, color: colors.textBody },
    primaryButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.brandPink,
      borderRadius: 999,
      paddingVertical: 14,
    },
    primaryButtonDisabled: { opacity: 0.5 },
    primaryButtonText: { color: colors.white, fontWeight: '800', fontSize: 15 },
    errorText: { fontSize: 13, color: colors.red, textAlign: 'center' },
  });
