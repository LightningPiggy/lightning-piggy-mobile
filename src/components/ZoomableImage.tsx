// One full-screen image with pinch-to-zoom + pan, double-tap-to-zoom and
// single-tap-to-dismiss — the page FullscreenImageModal renders (#661), once
// for a lone image or per page of a swipeable gallery (#1531).
//
// Mount it with `key={url}` so a different image starts un-zoomed (fresh
// shared values) rather than inheriting the previous image's transform.

import React from 'react';
import { Image as ExpoImage } from 'expo-image';
import { GestureDetector, Gesture } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';

interface Props {
  url: string;
  width: number;
  height: number;
  accessibilityLabel: string;
  onClose: () => void;
  /**
   * Gallery pages: panning only takes over once zoomed in, so an un-zoomed
   * horizontal drag falls through to the pager and swipes to the next image.
   * A lone image keeps the original always-pannable behaviour.
   */
  panRequiresZoom?: boolean;
  /** Told when the image zooms in (true) or returns to fit (false). */
  onZoomChange?: (zoomed: boolean) => void;
  testID?: string;
}

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const noop = () => {};

const ZoomableImage: React.FC<Props> = ({
  url,
  width,
  height,
  accessibilityLabel,
  onClose,
  panRequiresZoom = false,
  onZoomChange = noop,
  testID,
}) => {
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const tx = useSharedValue(0);
  const ty = useSharedValue(0);
  const savedTx = useSharedValue(0);
  const savedTy = useSharedValue(0);

  const pinch = Gesture.Pinch()
    .onStart(() => {
      runOnJS(onZoomChange)(true);
    })
    .onUpdate((e) => {
      scale.value = Math.min(Math.max(savedScale.value * e.scale, 0.5), MAX_SCALE);
    })
    .onEnd(() => {
      if (scale.value <= 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
        runOnJS(onZoomChange)(false);
      } else {
        savedScale.value = scale.value;
      }
    });

  const pan = Gesture.Pan()
    .manualActivation(panRequiresZoom)
    .onTouchesMove((_e, manager) => {
      // Only reached with manual activation (gallery pages): pan the zoomed
      // image, otherwise step aside so the pager scrolls.
      if (!panRequiresZoom) return;
      if (savedScale.value > 1) manager.activate();
      else manager.fail();
    })
    .onUpdate((e) => {
      tx.value = savedTx.value + e.translationX;
      ty.value = savedTy.value + e.translationY;
    })
    .onEnd(() => {
      savedTx.value = tx.value;
      savedTy.value = ty.value;
    });

  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      if (scale.value > 1) {
        scale.value = withTiming(1);
        savedScale.value = 1;
        tx.value = withTiming(0);
        ty.value = withTiming(0);
        savedTx.value = 0;
        savedTy.value = 0;
        runOnJS(onZoomChange)(false);
      } else {
        scale.value = withTiming(DOUBLE_TAP_SCALE);
        savedScale.value = DOUBLE_TAP_SCALE;
        runOnJS(onZoomChange)(true);
      }
    });

  const singleTap = Gesture.Tap()
    .numberOfTaps(1)
    .onEnd(() => {
      runOnJS(onClose)();
    });

  // pinch + pan run together; single tap dismisses but waits for a possible
  // double tap (which zooms) to fail first.
  const composed = Gesture.Simultaneous(pinch, pan, Gesture.Exclusive(doubleTap, singleTap));

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }));

  return (
    <GestureDetector gesture={composed}>
      <Animated.View style={[{ width, height }, animatedStyle]} testID={testID}>
        <ExpoImage
          source={{ uri: url }}
          style={{ width, height }}
          contentFit="contain"
          cachePolicy={url.startsWith('file://') ? 'memory' : 'memory-disk'}
          recyclingKey={url}
          autoplay={false}
          transition={150}
          accessibilityLabel={accessibilityLabel}
        />
      </Animated.View>
    </GestureDetector>
  );
};

export default React.memo(ZoomableImage);
