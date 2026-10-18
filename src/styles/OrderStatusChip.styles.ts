import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Order status chip (buyer My orders + seller Orders), one tone per meaning. */
export const createOrderStatusChipStyles = (colors: Palette) =>
  StyleSheet.create({
    chip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, alignSelf: 'flex-start' },
    text: { fontSize: 11, fontWeight: '700' },
    waiting: { backgroundColor: colors.zapYellowLight },
    waitingText: { color: colors.zapYellowInk },
    action: { backgroundColor: colors.brandPinkLight },
    actionText: { color: colors.brandPink },
    done: { backgroundColor: colors.greenLight },
    doneText: { color: colors.greenDark },
    moving: { backgroundColor: colors.accentSecondaryLight },
    movingText: { color: colors.accentSecondary },
    stopped: { backgroundColor: colors.redLight },
    stoppedText: { color: colors.red },
  });
