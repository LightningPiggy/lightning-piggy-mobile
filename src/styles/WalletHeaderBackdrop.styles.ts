import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createWalletHeaderBackdropStyles = (_colors: Palette) =>
  StyleSheet.create({
    fill: { ...StyleSheet.absoluteFill },
    pig: {
      position: 'absolute',
      width: 420,
      height: 420,
      right: -60,
      top: -20,
      opacity: 0.15,
    },
  });
