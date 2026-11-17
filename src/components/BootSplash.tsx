/**
 * JS-side boot splash — a full-screen pig image on brand-pink shown
 * from the moment `<App>` mounts until the app signals it's ready.
 * Pairs with the native splash in `app.config.ts`: the native layer
 * covers from process start → JS bundle load, then this JS layer takes
 * over from JS-mount → first-meaningful-paint so the user never sees
 * the plain pink "loading" screen between them.
 *
 * Visual: same pig + logo IntroScreen uses, so the transition from
 * splash → Intro (new users) or splash → Home (logged-in users) is
 * a continuous pink background with the pig centered.
 *
 * The splash fades out over 250 ms once `done=true`, via React Native
 * `Animated`. After the animation, the component returns null so it
 * doesn't intercept touch events.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image } from 'react-native';
import { createBootSplashStyles } from '../styles/BootSplash.styles';
import { lightPalette } from '../styles/palettes';

// BootSplash is brand-fixed (only ever shows over the native pink splash
// during the JS-mount → first-paint window) so it pulls from the shared
// palette directly rather than via `useThemeColors()`. brandPink is
// identical in both palettes; this keeps the legacy `colors` import
// out of the file.
const styles = createBootSplashStyles(lightPalette);

interface Props {
  /** When true, fade out over 250ms and unmount. */
  done: boolean;
}

const FADE_MS = 450;

const BootSplash: React.FC<Props> = ({ done }) => {
  const opacity = useRef(new Animated.Value(1)).current;
  const [unmounted, setUnmounted] = useState(false);

  useEffect(() => {
    if (done) {
      // Cubic-out easing so the fade decelerates as it nears 0 — feels
      // gentler than linear or default ease-in-out, which read as a
      // sudden snap at the end. 450 ms (was 250 ms) gives the user a
      // moment to register the brand before the next screen takes over.
      Animated.timing(opacity, {
        toValue: 0,
        duration: FADE_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(() => setUnmounted(true));
    }
  }, [done, opacity]);

  if (unmounted) return null;

  return (
    <Animated.View style={[styles.root, { opacity }]} pointerEvents={done ? 'none' : 'auto'}>
      {/* Pig artwork is decorative — the wordmark below is the
          canonical "Lightning Piggy" announcement, so we mark this
          image hidden to screen readers to avoid the brand being
          read twice. */}
      <Image
        source={require('../../assets/images/lightning-piggy-intro.png')}
        style={styles.pig}
        resizeMode="contain"
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no"
      />
      <Image
        source={require('../../assets/images/lightning-piggy-logo.png')}
        style={styles.logo}
        resizeMode="contain"
        accessibilityLabel="Lightning Piggy"
      />
    </Animated.View>
  );
};

export default BootSplash;
