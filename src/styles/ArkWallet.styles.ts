import { Platform, StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for the Ark wallet screen and its panels (src/components/ark/). */
export const createArkWalletStyles = (colors: Palette) =>
  StyleSheet.create({
    banner: {
      backgroundColor: 'rgba(255,255,255,0.15)',
      borderRadius: 12,
      padding: 12,
      marginBottom: 16,
    },
    bannerText: { color: colors.white, fontSize: 13, lineHeight: 19 },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 20,
      gap: 8,
      marginBottom: 16,
    },
    balanceLabel: { color: colors.textSupplementary, fontSize: 13, fontWeight: '600' },
    balance: { color: colors.textHeader, fontSize: 32, fontWeight: '800' },
    detailRow: { flexDirection: 'row', justifyContent: 'space-between' },
    detailLabel: { color: colors.textSupplementary, fontSize: 14 },
    detailValue: { color: colors.textBody, fontSize: 14, fontWeight: '600' },
    healthOk: { color: colors.greenDark, fontSize: 14, fontWeight: '600' },
    healthWarn: { color: colors.amber, fontSize: 14, fontWeight: '700' },
    healthUrgent: { color: colors.red, fontSize: 14, fontWeight: '700' },
    tabs: { flexDirection: 'row', gap: 8, marginBottom: 12, flexWrap: 'wrap' },
    tab: {
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 18,
      backgroundColor: 'rgba(255,255,255,0.2)',
    },
    tabActive: { backgroundColor: colors.surface },
    tabText: { color: colors.white, fontWeight: '700', fontSize: 14 },
    tabTextActive: { color: colors.brandPink },
    heading: { color: colors.textHeader, fontSize: 17, fontWeight: '700' },
    body: { color: colors.textBody, fontSize: 14, lineHeight: 21 },
    hint: { color: colors.textSupplementary, fontSize: 12, lineHeight: 18 },
    input: {
      backgroundColor: colors.background,
      borderRadius: 12,
      padding: 14,
      fontSize: 15,
      color: colors.textBody,
    },
    mono: {
      fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
      color: colors.textBody,
      fontSize: 13,
    },
    qr: { alignItems: 'center', paddingVertical: 12 },
    button: {
      backgroundColor: colors.brandPink,
      borderRadius: 12,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { color: colors.white, fontSize: 15, fontWeight: '700' },
    secondaryButton: {
      borderColor: colors.accentSecondary,
      borderWidth: 2,
      borderRadius: 12,
      height: 46,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
    },
    secondaryButtonText: { color: colors.accentSecondary, fontSize: 15, fontWeight: '700' },
    destructiveText: { color: colors.red, fontSize: 15, fontWeight: '700' },
    divider: { height: 1, backgroundColor: colors.divider, marginVertical: 8 },
    historyRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
    historyIn: { color: colors.greenDark, fontWeight: '700' },
    historyOut: { color: colors.textHeader, fontWeight: '700' },
    centered: { alignItems: 'center', paddingVertical: 32, gap: 12 },
    errorText: { color: colors.white, fontSize: 14, textAlign: 'center' },
  });

export type ArkWalletStyles = ReturnType<typeof createArkWalletStyles>;
