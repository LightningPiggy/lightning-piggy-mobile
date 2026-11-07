import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const THUMB_SIZE = 72;

export const createSharedImageTrayStyles = (colors: Palette) =>
  StyleSheet.create({
    tray: {
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
      paddingTop: 10,
      paddingBottom: 6,
    },
    title: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.textHeader,
      paddingHorizontal: 16,
      marginBottom: 8,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    thumbScroll: {
      flex: 1,
    },
    thumbs: {
      gap: 8,
      paddingLeft: 16,
      paddingRight: 4,
    },
    thumb: {
      width: THUMB_SIZE,
      height: THUMB_SIZE,
      borderRadius: 10,
      overflow: 'hidden',
      backgroundColor: colors.background,
    },
    thumbImage: {
      width: '100%',
      height: '100%',
    },
    removeButton: {
      position: 'absolute',
      top: 4,
      right: 4,
      width: 22,
      height: 22,
      borderRadius: 11,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    sendButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 40,
      paddingHorizontal: 16,
      borderRadius: 20,
      marginRight: 16,
      backgroundColor: colors.brandPink,
    },
    sendButtonDisabled: {
      opacity: 0.6,
    },
    sendButtonText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.white,
    },
  });

export type SharedImageTrayStyles = ReturnType<typeof createSharedImageTrayStyles>;
