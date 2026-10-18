import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createDmProtocolTagStyles = (colors: Palette) =>
  StyleSheet.create({
    pill: {
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 4,
      backgroundColor: colors.background,
    },
    text: { fontSize: 10, fontWeight: '700' },
    nip17: { color: colors.courseTeal },
    nip04: { color: colors.textSupplementary },
    marmot: { color: colors.brandPink },
    nip171: { color: colors.brandPurple },
  });
