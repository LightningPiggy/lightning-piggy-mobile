import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createMarketHeaderStyles = (colors: Palette) =>
  StyleSheet.create({
    header: { backgroundColor: colors.brandPink, overflow: 'hidden' },
    actions: { paddingHorizontal: 20, paddingBottom: 16 },
    spacer: { flex: 1 },
    activeButton: { backgroundColor: colors.brandPurple },
    badge: {
      position: 'absolute',
      top: -4,
      right: -4,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 4,
      borderRadius: 9,
      backgroundColor: colors.brandPurple,
      borderWidth: 1,
      borderColor: colors.white,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { color: colors.white, fontSize: 10, fontWeight: '800' },
  });
