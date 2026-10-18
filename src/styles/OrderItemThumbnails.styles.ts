import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createOrderItemThumbnailsStyles = (colors: Palette) =>
  StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 6, marginVertical: 8 },
    thumbnail: {
      width: 40,
      height: 40,
      borderRadius: 8,
      overflow: 'hidden',
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    large: { width: 48, height: 48, borderRadius: 10 },
    image: { width: '100%', height: '100%' },
    initial: { fontSize: 18, fontWeight: '700', color: colors.textSupplementary },
    badge: {
      position: 'absolute',
      bottom: 0,
      right: 0,
      borderRadius: 5,
      paddingHorizontal: 3,
      backgroundColor: colors.textHeader,
    },
    count: { fontSize: 10, fontWeight: '700', color: colors.surface },
    more: { flexShrink: 1, fontSize: 12, color: colors.textSupplementary },
  });
