import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Styles for the Market's seller scope and category filter drawer. */
export const createMarketFilterBarStyles = (colors: Palette) =>
  StyleSheet.create({
    modalRoot: { flex: 1 },
    // ----- panel shell -----------------------------------------------------
    backdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
    // Right-anchored drawer spanning the full height; slides in via translateX.
    panel: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      right: 0,
      backgroundColor: colors.background,
      paddingTop: 52,
      paddingBottom: 28,
      paddingHorizontal: 20,
    },
    panelHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginBottom: 4,
    },
    panelTitle: {
      flex: 1,
      fontSize: 20,
      fontWeight: '800',
      color: colors.textHeader,
    },
    clearText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.brandPink,
    },
    panelScroll: {
      flex: 1,
    },
    panelScrollContent: {
      paddingBottom: 8,
    },
    // ----- sections --------------------------------------------------------
    section: {
      marginTop: 18,
    },
    sectionLabel: {
      fontSize: 13,
      fontWeight: '700',
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      color: colors.textSupplementary,
      marginBottom: 10,
    },
    chipWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    sellerOption: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      padding: 12,
      marginBottom: 8,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.divider,
      backgroundColor: colors.surface,
    },
    sellerCopy: { flex: 1, gap: 4 },
    sellerOptionDisabled: { opacity: 0.5 },
    sellerHint: { fontSize: 12, color: colors.textSupplementary },
    sellerHintSelected: { color: colors.white },
    // ----- chips -----------------------------------------------------------
    chip: {
      maxWidth: '100%',
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: colors.divider,
      backgroundColor: colors.surface,
    },
    chipSelected: {
      backgroundColor: colors.brandPink,
      borderColor: colors.brandPink,
    },
    chipText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textBody,
    },
    chipTextSelected: {
      color: colors.white,
      fontWeight: '700',
    },
    // ----- ships-to "include unknown shipping" toggle ---------------------
    toggleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginTop: 12,
    },
    toggleLabel: { flex: 1, fontSize: 13, color: colors.textSupplementary },
    merchantListTitle: { fontSize: 20, fontWeight: '800', color: colors.textBody },
    merchantRowLabel: { flex: 1, fontSize: 14, color: colors.textBody },
    merchantSheetOverlay: { flex: 1, justifyContent: 'flex-end' },
    merchantList: {
      height: '85%',
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      backgroundColor: colors.background,
      padding: 20,
      paddingTop: 24,
      paddingBottom: 28,
    },
    merchantSearch: {
      marginVertical: 16,
      padding: 12,
      borderWidth: 1,
      borderColor: colors.divider,
      borderRadius: 16,
      color: colors.textBody,
    },
    // ----- done ------------------------------------------------------------
    doneButton: {
      marginTop: 16,
      paddingVertical: 14,
      borderRadius: 999,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
    },
    doneText: {
      color: colors.white,
      fontSize: 15,
      fontWeight: '700',
    },
  });

export type MarketFilterBarStyles = ReturnType<typeof createMarketFilterBarStyles>;
