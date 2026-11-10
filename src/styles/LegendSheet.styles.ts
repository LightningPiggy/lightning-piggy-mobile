import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createLegendSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      ...StyleSheet.absoluteFill,
      backgroundColor: 'rgba(0,0,0,0.4)',
      justifyContent: 'flex-end',
    },
    tapAway: { ...StyleSheet.absoluteFill },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      maxHeight: '75%',
      paddingHorizontal: 20,
      paddingBottom: 32,
    },
    grabber: { width: '100%', paddingVertical: 12, alignItems: 'center' },
    // Expanded drag zone — grabber pill at the top + the "Pin types"
    // section title below it. The whole 60-px tall strip catches the
    // PanResponder so the user can dismiss from anywhere near the top.
    grabberZone: {
      width: '100%',
      paddingTop: 12,
      paddingBottom: 4,
      alignItems: 'stretch',
    },
    handle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.divider,
      alignSelf: 'center',
    },
    scrollPad: { paddingBottom: 8 },
    sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.textHeader },
    sectionSub: { fontSize: 13, color: colors.textSupplementary, marginTop: 2, marginBottom: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 8,
    },
    swatchDot: {
      width: 14,
      height: 14,
      borderRadius: 7,
      borderWidth: 1.5,
      borderColor: '#fff',
    },
    // Shared chassis for every pin-type / category row chip. 22 px
    // diameter byte-for-byte matches the map markers so the legend
    // swatches are the same size as what the user sees on the map.
    // 12-px glyph inside, 1.5-px white border around.
    pinChip: {
      width: 22,
      height: 22,
      borderRadius: 11,
      borderWidth: 1.5,
      borderColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
    },
    // The "You" row inner dot matches the map's user dot exactly.
    userDotChip: {
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
    },
    userDotInner: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: '#2D88FF',
      borderWidth: 2,
      borderColor: '#fff',
    },
    cacheCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 2,
      borderColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
    },
    cacheZapBadge: {
      position: 'absolute',
      top: -2,
      right: -2,
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: '#FFB200',
      borderWidth: 1.5,
      borderColor: '#fff',
      alignItems: 'center',
      justifyContent: 'center',
    },
    swatchDiamond: {
      width: 12,
      height: 12,
      transform: [{ rotate: '45deg' }],
      borderWidth: 1.5,
      borderColor: '#fff',
    },
    iconWrap: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.background,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowLabel: { fontSize: 14, color: colors.textBody, flex: 1 },
  });
