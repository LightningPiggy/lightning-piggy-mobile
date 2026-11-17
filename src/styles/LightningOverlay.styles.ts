import { StyleSheet } from 'react-native';

// The lightning canvas fills the overlay behind the card. It's purely
// decorative and never intercepts touches — the card above owns interaction.
export const createLightningOverlayStyles = () =>
  StyleSheet.create({
    canvas: {
      ...StyleSheet.absoluteFill,
    },
  });

export type LightningOverlayStyles = ReturnType<typeof createLightningOverlayStyles>;
