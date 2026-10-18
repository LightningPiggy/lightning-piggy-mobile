import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for {@link MarketProductDetailScreen} — header mirrors MarketScreen
 * so the Explore sub-screens read as siblings; the body is a scrolling product
 * page (image, info, buy, then the reviews/comments tabs). */
export const createMarketProductDetailStyles = (colors: Palette) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },

    scrollContent: { paddingBottom: 40 },

    // Hero image / gallery styles live in MarketProductGallery.styles.ts.

    body: { padding: 16, gap: 12 },
    title: { fontSize: 22, fontWeight: '800', color: colors.textHeader },
    shippingUnknown: { fontSize: 13, color: colors.textSupplementary },

    vendorRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    vendorName: { fontSize: 14, fontWeight: '700', color: colors.textHeader },

    buyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.brandPink,
      borderRadius: 999,
      paddingVertical: 14,
      marginTop: 4,
    },
    buyText: { color: colors.white, fontWeight: '800', fontSize: 15 },
    buyButtonDisabled: { opacity: 0.5 },
    // Under a Nostr listing's Buy: the seller answers the order with an invoice.
    invoiceNote: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      marginTop: 8,
    },
    // Replaces the buy affordances when a refresh finds the listing gone.
    withdrawn: {
      padding: 14,
      borderRadius: 12,
      backgroundColor: colors.surface,
      marginTop: 4,
    },
    withdrawnText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.textSupplementary,
      textAlign: 'center',
    },

    divider: {
      height: 1,
      backgroundColor: colors.divider,
      marginVertical: 16,
    },

    feedbackWrap: { paddingHorizontal: 16 },

    noFeedback: {
      marginHorizontal: 16,
      padding: 16,
      borderRadius: 12,
      backgroundColor: colors.surface,
    },
    noFeedbackText: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      lineHeight: 19,
    },

    missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
    missingText: { fontSize: 15, color: colors.textSupplementary, textAlign: 'center' },
    previewBanner: {
      marginBottom: 12,
      padding: 12,
      borderRadius: 12,
      backgroundColor: colors.zapYellowLight,
    },
    previewBannerText: { fontSize: 13, fontWeight: '600', color: colors.zapYellowDark },
  });
