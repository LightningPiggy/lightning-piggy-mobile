import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createShareTargetRecentsStyles = (colors: Palette) =>
  StyleSheet.create({
    sectionLabel: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 4,
    },
  });
