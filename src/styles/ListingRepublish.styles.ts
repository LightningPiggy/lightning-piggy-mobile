import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
export const createListingRepublishStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: { backgroundColor: colors.surface },
    sheet: { padding: 24, paddingBottom: 40, gap: 16 },
    title: { color: colors.textBody, fontSize: 18, fontWeight: '700' },
    itemTitle: { color: colors.textBody, fontSize: 16, fontWeight: '700' },
    text: { color: colors.textBody, fontSize: 14 },
    muted: { color: colors.textSupplementary, fontSize: 13 },
    item: { gap: 8 },
    resultRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    resultText: { flex: 1 },
    button: {
      backgroundColor: colors.brandPink,
      padding: 14,
      borderRadius: 12,
      alignItems: 'center',
    },
    buttonText: { color: colors.white, fontWeight: '700' },
  });
