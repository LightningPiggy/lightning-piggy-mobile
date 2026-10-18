import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
import { createMarketScreenStyles } from './MarketScreen.styles';

/** Styles for {@link MarketLikedItemsScreen}: the Market screen's header and
 * grid, so the Liked items page reads as part of the Market. */
export const createMarketLikedItemsStyles = (colors: Palette) => {
  const market = createMarketScreenStyles(colors);
  return StyleSheet.create({
    container: market.container,
    gridContent: market.gridContent,
    gridRow: market.gridRow,
    emptyWrap: market.emptyWrap,
    emptyText: market.emptyText,
    signInButton: {
      marginTop: 16,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 20,
      backgroundColor: colors.brandPink,
    },
    signInText: { color: colors.white, fontSize: 14, fontWeight: '700' },
  });
};
