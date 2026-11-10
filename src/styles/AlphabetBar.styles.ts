import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createAlphabetBarStyles = (colors: Palette) =>
  StyleSheet.create({
    alphabetBar: {
      // The parent (`listWithBar` in both FriendsScreen and
      // FriendPickerSheet) is `flexDirection: 'row'` so the default
      // `alignItems: 'stretch'` already gives this bar the parent's
      // full column height. We rely on that — do NOT set `flex: 1`
      // here, which would claim row WIDTH instead and visibly bloat
      // the sidebar (the per-letter `flex: 1` below uses the
      // stretched height to distribute 27 letters proportionally).
      flexDirection: 'column',
      // The visible top/bottom breathing comes from this container's
      // padding, while the per-letter `flex: 1` buckets below consume
      // the remaining height and centre each letter within its bucket.
      // `space-around` is kept defensively in case a future change
      // removes `flex: 1` from the touches; with `flex: 1` it has no
      // material effect because the buckets fill all free space.
      justifyContent: 'space-around',
      alignItems: 'center',
      paddingTop: 8,
      paddingBottom: 8,
      // Wider + nudged in from the screen edge so the letters are easier to
      // tap (were tight against the left bezel at width 22 / marginLeft 2).
      width: 26,
      marginLeft: 6,
    },
    alphabetLetterTouch: {
      // `flex: 1` distributes the 27 letter buckets proportionally
      // across the bar's height, so they never overflow the container
      // (which would clip the trailing letters — V-Z were getting
      // hidden in FriendPickerSheet's bottom sheet on smaller AVDs
      // when items kept their intrinsic heights via `space-between`/
      // `space-around`). Each bucket gets ~containerHeight/27.
      flex: 1,
      paddingHorizontal: 2,
      borderRadius: 8,
      width: 24,
      justifyContent: 'center',
      alignItems: 'center',
    },
    alphabetLetterActive: {
      backgroundColor: colors.brandPink,
      borderRadius: 8,
    },
    alphabetLetter: {
      // Keep the text compact so the full A-Z index is more likely to
      // remain visible in constrained layouts such as
      // FriendPickerSheet, reducing the chance that trailing letters
      // get clipped on smaller screens.
      fontSize: 11,
      lineHeight: 13,
      fontWeight: '700',
      color: colors.textSupplementary,
      textAlign: 'center',
    },
    alphabetLetterDisabled: {
      // Greyed-out letter for buckets with no contacts. Faded enough to
      // read as inactive but still legible so the user can verify the
      // index spans the whole alphabet.
      opacity: 0.3,
    },
    alphabetLetterTextActive: {
      color: colors.white,
    },
  });
