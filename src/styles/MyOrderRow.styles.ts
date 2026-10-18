import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** One order in the buyer's My orders list. */
export const createMyOrderRowStyles = (colors: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 16,
      backgroundColor: colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.brandPinkLight },
    avatarFallback: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.brandPinkLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarLetter: { fontSize: 16, fontWeight: '700', color: colors.brandPink },
    body: { flex: 1, gap: 2 },
    topLine: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      flexWrap: 'wrap',
    },
    seller: { flex: 1, fontSize: 15, fontWeight: '600', color: colors.textHeader },
    total: { flexShrink: 1, fontSize: 14, fontWeight: '700', color: colors.textHeader },
    items: { fontSize: 13, color: colors.textBody },
    bottomLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
    expiredNote: { fontSize: 13, color: colors.textSupplementary },
    date: { fontSize: 12, color: colors.textSupplementary },
  });
