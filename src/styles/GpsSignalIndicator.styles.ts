import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// Presentation for the GPS signal indicator in the full-map header.
export const createGpsSignalIndicatorStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      width: 26,
      height: 26,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badge: {
      position: 'absolute',
      top: -4,
      right: -6,
      minWidth: 14,
      height: 14,
      borderRadius: 7,
      paddingHorizontal: 3,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.white,
    },
    badgeText: {
      fontSize: 9,
      fontWeight: '700',
      color: colors.brandPink,
    },
    strike: {
      position: 'absolute',
      width: 28,
      height: 2,
      borderRadius: 1,
      backgroundColor: colors.white,
      transform: [{ rotate: '-45deg' }],
    },
  });

export type GpsSignalIndicatorStyles = ReturnType<typeof createGpsSignalIndicatorStyles>;
