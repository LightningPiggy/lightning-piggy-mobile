import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for the checkout's country-first shipping block (#948 Option A). */
export const createMarketShippingSectionStyles = (colors: Palette) =>
  StyleSheet.create({
    section: {
      marginBottom: 16,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 8,
    },
    countryRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 10,
    },
    countryLabel: {
      fontSize: 15,
      color: colors.textBody,
      fontWeight: '600',
    },
    countryPlaceholder: {
      fontSize: 15,
      color: colors.textSupplementary,
    },
    countryChevronWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginBottom: 8,
      borderWidth: 1.5,
      borderColor: 'transparent',
    },
    optionRowSelected: {
      borderColor: colors.brandPink,
      backgroundColor: colors.brandPinkLight,
    },
    optionInfo: {
      flex: 1,
      marginRight: 10,
    },
    optionTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textBody,
    },
    optionScope: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    optionCost: {
      flexShrink: 1,
      textAlign: 'right',
      fontSize: 14,
      fontWeight: '700',
      color: colors.brandPink,
    },
    statusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 10,
    },
    statusText: {
      fontSize: 14,
      color: colors.textSupplementary,
      flexShrink: 1,
    },
    retryText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.brandPink,
    },
    emptyWrap: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      padding: 14,
      alignItems: 'center',
      gap: 10,
    },
    emptyText: {
      fontSize: 14,
      color: colors.textBody,
      textAlign: 'center',
    },
    messageShopButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 20,
      backgroundColor: colors.brandPinkLight,
    },
    messageShopText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.brandPink,
    },
    addressNote: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 4,
    },
  });

export type MarketShippingSectionStyles = ReturnType<typeof createMarketShippingSectionStyles>;
