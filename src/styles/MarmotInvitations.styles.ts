import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createMarmotInvitationsStyles = (colors: Palette) =>
  StyleSheet.create({
    // A FlatList grows by default: size to the rows, up to the cap.
    section: { maxHeight: 280, flexGrow: 0 },
    row: {
      padding: 12,
      gap: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
    },
    identity: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    details: { flex: 1 },
    name: { color: colors.textBody, fontWeight: '600', fontSize: 14 },
    subtitle: { color: colors.textSupplementary, fontSize: 13 },
    actions: { flexDirection: 'row', gap: 12 },
    button: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: colors.brandPink,
    },
    buttonText: { color: colors.brandPink, fontWeight: '600' },
  });
