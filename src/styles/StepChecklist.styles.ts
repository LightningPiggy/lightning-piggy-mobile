import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Presentation for StepChecklist — the ✓ / spinner / ○ step list shared by
 *  the Move sheet's progress view and the Send overlay's swap stages. */
export const createStepChecklistStyles = (colors: Palette) =>
  StyleSheet.create({
    stepList: {
      alignSelf: 'stretch',
      gap: 12,
      paddingVertical: 12,
      paddingHorizontal: 20,
      backgroundColor: colors.background,
      borderRadius: 12,
      marginTop: 8,
    },
    stepRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    stepIcon: {
      width: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepLabel: {
      fontSize: 15,
      color: colors.textBody,
      fontWeight: '600',
      // Grow into the row and wrap within it; flexShrink (not flex: 1's zero
      // basis) keeps the measured height of a wrapped label correct.
      flexGrow: 1,
      flexShrink: 1,
    },
    stepLabelPending: {
      color: colors.textSupplementary,
      fontWeight: '500',
    },
    stepLabelFailed: {
      color: colors.red,
    },
  });
