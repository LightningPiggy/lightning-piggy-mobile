import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useCameraPermissions } from 'expo-camera';
import {
  isPermissionBlocked,
  requestOrOpenSettings,
  type PermissionState,
  type RequestPermission,
} from '../utils/permissionPrompt';

/**
 * State for a QR scanner's "Grant permission" / "Open Settings" button (#1798).
 * The parent owns the request (`onRequestPermission`) so its `permissionGranted`
 * stays in sync; this hook only tracks whether the OS has stopped prompting.
 */
export function useScanPermissionButton(
  permissionGranted: boolean,
  onRequestPermission: RequestPermission,
): { blocked: boolean; onPress: () => Promise<void> } {
  // Read on mount to tell "never asked" from "permanently denied".
  const [initialPermission, , getPermission] = useCameraPermissions();
  const [latestPermission, setLatestPermission] = useState<PermissionState | null>(null);
  const blocked = isPermissionBlocked(latestPermission ?? initialPermission);
  // Expo's Android code sends every request to the OS, even when already
  // granted, which can flash the permission screen and fire another
  // background → active cycle. These stop that cycle sending extra requests.
  const tapInFlightRef = useRef(false);
  const grantHandledRef = useRef(false);

  // Expo's hook never re-reads on resume, and Android doesn't restart the app
  // when the camera is allowed in Settings — so without this the button stays
  // "Open Settings" and needs another tap after coming back. Runs immediately
  // rather than staggered: it's one cheap status read, only while this pane is
  // on screen and still waiting for access, not app-wide work on every resume.
  useEffect(() => {
    if (permissionGranted) return;
    let alive = true;
    const sub = AppState.addEventListener('change', (state) => {
      // A tap's own request is still settling — its result wins.
      if (state !== 'active' || tapInFlightRef.current || grantHandledRef.current) return;
      getPermission()
        .then((result) => {
          if (!result.granted || grantHandledRef.current) return result;
          // Already granted: the parent's request resolves without a prompt
          // and flips its `permissionGranted`, so the camera starts with no
          // tap. Only once — a further resume mustn't request again.
          grantHandledRef.current = true;
          return onRequestPermission();
        })
        .then((result) => {
          if (alive) setLatestPermission(result);
        })
        .catch(() => undefined);
    });
    return () => {
      alive = false;
      sub.remove();
    };
  }, [permissionGranted, getPermission, onRequestPermission]);

  const onPress = useCallback(async () => {
    tapInFlightRef.current = true;
    try {
      setLatestPermission(await requestOrOpenSettings(onRequestPermission, blocked));
    } finally {
      tapInFlightRef.current = false;
    }
  }, [onRequestPermission, blocked]);

  return { blocked, onPress };
}
