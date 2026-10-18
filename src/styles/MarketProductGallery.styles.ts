import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for the Market product page's hero image / image gallery. */
export const createMarketProductGalleryStyles = (colors: Palette) =>
  StyleSheet.create({
    // `aspectRatio: 1` is only the pre-load placeholder shape; once the
    // (first) image loads, MarketProductGallery overrides it inline with the
    // image's real aspect ratio so the hero isn't cropped to a square.
    imageWrap: {
      width: '100%',
      aspectRatio: 1,
      backgroundColor: colors.surface,
    },
    image: { width: '100%', height: '100%' },
    imageFallback: {
      width: '100%',
      height: '100%',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.brandPinkLight,
    },
    imageFallbackText: { fontSize: 64, fontWeight: '800', color: colors.brandPink },

    // "2 / 5" pill over the gallery's top-right corner.
    counter: {
      position: 'absolute',
      top: 12,
      right: 12,
      paddingHorizontal: 10,
      paddingVertical: 3,
      borderRadius: 12,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
    },
    counterText: { color: colors.white, fontSize: 12, fontWeight: '700' },

    thumbnails: {
      gap: 8,
      paddingHorizontal: 16,
      paddingTop: 10,
    },
    thumbnail: {
      width: 56,
      height: 56,
      borderRadius: 8,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
    },
    thumbnailFallbackText: { fontSize: 20, fontWeight: '800', color: colors.brandPink },
  });

export type MarketProductGalleryStyles = ReturnType<typeof createMarketProductGalleryStyles>;
