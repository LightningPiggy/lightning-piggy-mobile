import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createMarketShortcutsStyles = (colors: Palette) =>
  StyleSheet.create({
    scroll: { flexGrow: 0, flexShrink: 0 },
    row: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingTop: 16 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 10,
      minHeight: 44,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
      backgroundColor: colors.surface,
    },
    label: { color: colors.textBody, fontSize: 14, fontWeight: '700' },
    badge: {
      minWidth: 20,
      height: 20,
      paddingHorizontal: 5,
      borderRadius: 10,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  });
