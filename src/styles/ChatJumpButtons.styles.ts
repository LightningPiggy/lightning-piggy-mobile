import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createChatJumpButtonsStyles = (colors: Palette) =>
  StyleSheet.create({
    // One lane above the composer, level with the "New messages" pill: the
    // latest arrow is centred, the mention button sits at its right end.
    row: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 16,
      height: 40,
      alignItems: 'center',
    },
    // Right-aligned on the arrow's row, clear of the centred arrow / pill.
    mention: {
      position: 'absolute',
      right: 16,
      top: 0,
    },
    fab: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.brandPink,
      // White ring keeps the button visible over a pink bubble.
      borderWidth: 2,
      borderColor: colors.white,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 4,
      elevation: 4,
    },
    atSign: {
      color: colors.white,
      fontSize: 20,
      fontWeight: '800',
      // Optical centring: the glyph sits a touch low in most fonts.
      marginTop: -2,
    },
    count: {
      position: 'absolute',
      top: -8,
      right: -6,
      minWidth: 20,
      height: 20,
      borderRadius: 10,
      paddingHorizontal: 5,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    countText: {
      color: colors.brandPink,
      fontSize: 11,
      fontWeight: '700',
    },
  });

export type ChatJumpButtonsStyles = ReturnType<typeof createChatJumpButtonsStyles>;
