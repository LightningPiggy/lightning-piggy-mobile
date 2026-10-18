import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
export const createMessageSharedListingStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: colors.background,
      padding: 12,
      gap: 6,
    },
    image: {
      height: 150,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brandPinkLight,
      borderRadius: 8,
    },
    initial: { fontSize: 48, fontWeight: '700', color: colors.brandPink },
    title: { fontSize: 16, fontWeight: '600', color: colors.textBody },
    label: { fontSize: 12, color: colors.textSupplementary },
  });
