import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createGroupHeaderTitleStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      flexShrink: 1,
    },
    // Same typography as the 1:1 header name (ChatHeader.styles headerName).
    title: {
      color: colors.textHeader,
      fontSize: 16,
      fontWeight: '700',
      flexShrink: 1,
    },
  });
