import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createAdvancedRelaysSectionStyles = (colors: Palette) =>
  StyleSheet.create({
    toggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 24,
      paddingVertical: 6,
    },
    toggleText: {
      color: colors.white,
      fontSize: 16,
      fontWeight: '700',
    },
    subTitle: {
      color: colors.white,
      fontSize: 14,
      fontWeight: '600',
      marginTop: 16,
      marginBottom: 6,
    },
    list: {
      backgroundColor: 'rgba(255,255,255,0.1)',
      borderRadius: 10,
      paddingVertical: 4,
    },
    appRow: { flexDirection: 'row', alignItems: 'center', paddingRight: 12 },
    relayCell: { flex: 1 },
    warning: { color: colors.white, padding: 12, fontSize: 13 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingHorizontal: 12,
      gap: 10,
    },
    url: {
      flex: 1,
      color: colors.white,
      fontSize: 13,
    },
    removeButton: {
      width: 28,
      height: 28,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
    },
  });
