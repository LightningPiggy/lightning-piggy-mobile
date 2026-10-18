import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createMessagesScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.brandPink,
    },
    /** Extras row below TabHeader (search + chips). The TabHeader owns its
     * own vertical padding; this just claims the bottom spacing the full
     * header used to provide so the list content doesn't hug the chip row. */
    headerExtras: {
      paddingHorizontal: 20,
      paddingBottom: 24,
    },
    chipRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: 8,
      marginBottom: 4,
    },
    searchRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(255,255,255,0.2)',
      borderRadius: 20,
      paddingHorizontal: 12,
      gap: 8,
    },
    searchToggle: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(255,255,255,0.2)',
      justifyContent: 'center',
      alignItems: 'center',
    },
    filterChipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: 8,
      marginTop: 12,
      marginLeft: 16,
    },
    filterChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: 'rgba(229, 34, 120, 0.1)',
    },
    // Off-state for the dev-only Following-only toggle. Mirrors
    // GroupsScreen's matching style — desaturated background + outline
    // makes the "filter is OFF" state visually loud so a forgotten
    // toggle doesn't blend into a normal-looking chip row.
    filterChipOff: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: 'rgba(0, 0, 0, 0.05)',
      borderWidth: 1,
      borderColor: 'rgba(0, 0, 0, 0.1)',
    },
    filterChipTextOff: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSupplementary,
    },
    filterChipInteractive: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: 'rgba(229, 34, 120, 0.1)',
      borderWidth: 1,
      borderColor: 'rgba(229, 34, 120, 0.3)',
    },
    // Filled variant for an "on" toggleable chip (e.g. the Zaps filter
    // chip when zap counterparties are unioned into the inbox). Same
    // footprint as filterChipInteractive so layout doesn't shift; just
    // a stronger background + border to read as "active".
    filterChipInteractiveOn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 14,
      backgroundColor: 'rgba(229, 34, 120, 0.25)',
      borderWidth: 1,
      borderColor: colors.brandPink,
    },
    filterChipText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.brandPink,
    },
    searchInput: {
      flex: 1,
      paddingVertical: 8,
      fontSize: 15,
      color: colors.white,
      fontWeight: '500',
    },
    content: {
      flex: 1,
      backgroundColor: colors.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      marginTop: -24,
      paddingTop: 0,
      overflow: 'hidden',
    },
    listContent: {
      paddingTop: 12,
      paddingBottom: 20,
    },
    emptyState: {
      padding: 40,
      alignItems: 'center',
      gap: 8,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
    },
    emptySubtitle: {
      fontSize: 14,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
    connectButton: {
      backgroundColor: colors.brandPink,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 10,
      marginTop: 8,
    },
    connectButtonText: {
      color: colors.white,
      fontSize: 15,
      fontWeight: '700',
    },
    fab: {
      position: 'absolute',
      right: 20,
      bottom: 20,
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.brandPink,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 6,
    },
  });
