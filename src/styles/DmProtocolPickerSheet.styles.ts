import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createDmProtocolPickerSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    background: { backgroundColor: colors.surface },
    handle: { backgroundColor: colors.divider },
    content: { paddingHorizontal: 20, paddingBottom: 32, gap: 12 },
    title: { fontSize: 20, fontWeight: '700', color: colors.textHeader },
    option: { padding: 12, borderRadius: 12, backgroundColor: colors.background, gap: 6 },
    disabled: { opacity: 0.6 },
    heading: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    name: { color: colors.textHeader, fontSize: 14, fontWeight: '600' },
    badge: { color: colors.courseTeal, fontSize: 12, flex: 1 },
    description: { color: colors.textBody, fontSize: 13, lineHeight: 19 },
    availability: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start' },
    availabilityText: { color: colors.textSupplementary, fontSize: 13, lineHeight: 19 },
    retryText: { color: colors.brandPink, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  });

export type DmProtocolPickerSheetStyles = ReturnType<typeof createDmProtocolPickerSheetStyles>;
