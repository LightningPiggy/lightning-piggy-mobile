import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
export const createListingRepublishStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      padding: 24,
    },
    card: { backgroundColor: colors.surface, borderRadius: 20, padding: 20, maxHeight: '80%' },
    title: { color: colors.textBody, fontSize: 18, fontWeight: '700', marginBottom: 8 },
    text: { color: colors.textBody, fontSize: 14 },
    item: { marginBottom: 12 },
    button: {
      backgroundColor: colors.brandPink,
      padding: 14,
      borderRadius: 12,
      alignItems: 'center',
    },
    buttonText: { color: colors.white, fontWeight: '700' },
  });
