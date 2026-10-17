import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createRelayDetailsScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    avatar: { width: 44, height: 44, borderRadius: 22 },
    link: { color: colors.white, textDecorationLine: 'underline', fontSize: 14, lineHeight: 20 },
    urlRow: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginBottom: 16 },
    url: { color: colors.white, fontSize: 15, flex: 1 },
    card: {
      backgroundColor: 'rgba(255,255,255,0.12)',
      padding: 14,
      borderRadius: 12,
      marginBottom: 16,
      gap: 10,
    },
    heading: { color: colors.white, fontSize: 19, fontWeight: '700', marginBottom: 4 },
    label: { color: colors.white, fontSize: 12, opacity: 0.75 },
    value: { color: colors.white, fontSize: 14, lineHeight: 20 },
    about: { flexDirection: 'row', gap: 12, alignItems: 'center' },
    aboutText: { flex: 1 },
    iconBox: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    icon: { width: 48, height: 48, borderRadius: 12, position: 'absolute' },
    toggle: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    // White button contrasts brand background
    remove: { backgroundColor: colors.white, padding: 14, borderRadius: 12, alignItems: 'center' },
    disabled: { opacity: 0.45 },
    removeText: { color: colors.brandPink, fontWeight: '700', fontSize: 15 },
    // Same white-on-brand button as `remove`, with a ⚡ icon beside the label.
    tip: {
      backgroundColor: colors.white,
      padding: 14,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 8,
    },
    tipText: { color: colors.brandPink, fontWeight: '700', fontSize: 15 },
  });
