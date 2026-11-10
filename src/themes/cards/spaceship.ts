import { StyleSheet } from 'react-native';

// Graffiti rocket blasting through a nebula. Unlike the line-art mascots and
// the sports cards (a square decoration tucked into a corner over the
// gradient) this is a full-bleed nebula background filling the whole card —
// the "space background" itself is the art. absoluteFillObject's 0,0,0,0
// insets resolve against the card's full border box, so the nebula reaches
// every edge despite the card's padding:20. Paired with resizeMode 'stretch'
// (cardThemes) so the ~1.5:1 art fills the ~1.9:1 card; the rocket sits to the
// right and the calmer dark-space left keeps the white balance text readable.
// Slightly under full opacity softens the brightest nebula patches under text.
export const bgStyle = StyleSheet.create({
  full: {
    ...StyleSheet.absoluteFill,
    opacity: 0.9,
  },
});
