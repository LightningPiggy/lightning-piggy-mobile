// Block screenshots / screen recording / the recents thumbnail while
// `active` (FLAG_SECURE on Android; capture block + app-switcher blur on
// iOS), keyed so overlapping users don't release each other's block. Same
// calls as the Back up your key screen (`useKeyBackupReveal`).
//
// Returns a ref to a promise that resolves true once protection is on for
// the current activation, false if the platform refused it (or inactive) —
// await it before showing a secret, and warn if it's false.
import { useEffect, useRef, type MutableRefObject } from 'react';
import { Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';

export function useScreenCaptureBlock(
  key: string,
  active: boolean,
): MutableRefObject<Promise<boolean>> {
  const protectionRef = useRef<Promise<boolean>>(Promise.resolve(false));
  useEffect(() => {
    if (!active) {
      protectionRef.current = Promise.resolve(false);
      return;
    }
    const enable = async () => {
      await ScreenCapture.preventScreenCaptureAsync(key);
      if (Platform.OS === 'ios') await ScreenCapture.enableAppSwitcherProtectionAsync();
    };
    protectionRef.current = enable().then(
      () => true,
      () => false,
    );
    return () => {
      protectionRef.current = Promise.resolve(false);
      ScreenCapture.allowScreenCaptureAsync(key).catch(() => {});
      if (Platform.OS === 'ios') ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => {});
    };
  }, [key, active]);
  return protectionRef;
}
