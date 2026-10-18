import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Buyer's My orders list (the header comes from MarketSeller.styles). */
export const createMarketMyOrdersScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    list: { flex: 1, backgroundColor: colors.background },
    listContent: { paddingBottom: 32 },
    empty: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12 },
    emptyText: { fontSize: 15, color: colors.textSupplementary, textAlign: 'center' },
  });
