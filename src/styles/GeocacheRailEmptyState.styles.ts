import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createGeocacheRailEmptyStateStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      padding: 16,
      borderRadius: 12,
      backgroundColor: colors.surface,
      gap: 12,
      alignItems: 'flex-start',
    },
    message: {
      color: colors.textSupplementary,
      fontSize: 14,
      lineHeight: 20,
    },
    button: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.brandPink,
    },
    buttonText: {
      color: colors.brandPink,
      fontSize: 14,
      fontWeight: '700',
    },
  });
