import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for {@link MarketScreen}. The shared MarketHeader owns the header presentation. */
export const createMarketScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    // ----- product grid ----------------------------------------------------
    // Outer padding matches MARKET_GRID_PADDING (16); the tile width is
    // derived to fill the row inside it. Row gutter comes from gridRow's
    // marginBottom, the column gutter from justify-between spacing.
    gridContent: {
      paddingHorizontal: 16,
      paddingTop: 16,
      paddingBottom: 32,
    },
    // Each grid row: tiles pushed to the outer edges with the gutter between
    // (MARKET_GRID_GAP is baked into the derived tile width). A lone last tile
    // stays left-aligned at column width rather than stretching.
    gridRow: {
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    // Shown only when a load missed some sellers — never a permanent row.
    partialBanner: {
      marginHorizontal: 16,
      marginTop: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 10,
      backgroundColor: colors.surface,
    },
    partialBannerText: { fontSize: 12, color: colors.textSupplementary },
    emptyWrap: {
      paddingVertical: 48,
      paddingHorizontal: 24,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      lineHeight: 19,
    },
  });
