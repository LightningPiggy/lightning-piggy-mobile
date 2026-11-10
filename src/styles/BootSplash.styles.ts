import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createBootSplashStyles = (colors: Palette) =>
  StyleSheet.create({
    root: {
      ...StyleSheet.absoluteFill,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
    },
    pig: {
      width: '80%',
      height: '50%',
    },
    logo: {
      // The logo PNG (177×86 native, ~2:1) is the wordmark — yellow
      // lightning bolt + white "Lightning Piggy" text baked in. Render
      // it at a readable size (60% of the splash width) instead of the
      // previous 32×32 squished icon. accessibilityLabel preserves the
      // brand announcement for screen readers; the previous separate
      // <Text>LIGHTNING PIGGY</Text> was duplicating what the image
      // already says (#215).
      width: '60%',
      aspectRatio: 177 / 86,
      marginTop: 24,
    },
  });
