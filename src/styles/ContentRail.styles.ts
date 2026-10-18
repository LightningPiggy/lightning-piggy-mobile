import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createContentRailStyles = (colors: Palette) =>
  StyleSheet.create({
    section: {
      marginBottom: 22,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      marginBottom: 10,
      gap: 12,
    },
    headerText: { flex: 1 },
    title: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    caption: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    seeAll: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    seeAllText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.brandPink,
    },
    list: {
      paddingHorizontal: 16,
    },
    separator: {
      width: 10,
    },
    placeholderRow: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      gap: 10,
    },
    placeholderCard: {
      width: 160,
      height: 130,
      backgroundColor: colors.surface,
      borderRadius: 12,
      opacity: 0.5,
    },
    emptyWrap: {
      paddingHorizontal: 16,
    },
  });
