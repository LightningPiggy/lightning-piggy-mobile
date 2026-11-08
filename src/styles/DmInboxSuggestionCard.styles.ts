import { StyleSheet } from 'react-native';

import type { Palette } from './palettes';

export const createDmInboxSuggestionCardStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      marginTop: 24,
    },
    relays: {
      marginTop: 8,
    },
    publishButton: {
      marginTop: 12,
    },
    dismissButton: {
      alignSelf: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
    },
    dismissText: {
      color: colors.white,
      fontSize: 14,
      fontWeight: '600',
    },
  });
