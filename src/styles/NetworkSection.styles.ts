import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
export const createNetworkSectionStyles = (colors: Palette) =>
  StyleSheet.create({
    headingRow: {
      flexDirection: 'row',
      gap: 10,
      alignItems: 'center',
      marginTop: 24,
      marginBottom: 8,
    },
    heading: { flex: 1, color: colors.white, fontSize: 16, fontWeight: '700' },
    sheetBackground: { backgroundColor: colors.surface },
    sheet: { padding: 24, paddingBottom: 40, gap: 16 },
    sheetTitle: { color: colors.textBody, fontSize: 18, fontWeight: '700' },
    sheetText: { color: colors.textBody, fontSize: 15, lineHeight: 22 },
    resultRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    resultText: { flex: 1 },
    link: { color: colors.brandPink, fontWeight: '700', fontSize: 15 },
  });
