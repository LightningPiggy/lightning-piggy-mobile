import { StyleSheet } from 'react-native';

// Pop-art ostrich on a halftone comic burst. Unlike the line-art mascots
// (a square decoration tucked into a corner over the gradient) this is a
// full-bleed photo background filling the whole card. absoluteFillObject's
// 0,0,0,0 insets resolve against the card's full border box, so the art
// reaches every edge despite the card's padding:20 (percentage width/height
// would instead resolve against the padded content box and leave a gap on
// the right/bottom). Paired with resizeMode 'stretch' (cardThemes) so the
// centred ostrich is never cropped — the card is ~1.9:1 vs the art's ~1.78:1,
// a ~7% horizontal stretch that's imperceptible. Slightly under full opacity
// keeps the white card text readable over the brightest parts of the art.
export const bgStyle = StyleSheet.create({
  full: {
    ...StyleSheet.absoluteFill,
    opacity: 0.9,
  },
});
