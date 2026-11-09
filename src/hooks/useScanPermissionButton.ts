import { useCallback, useEffect, useState } from 'react';
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

  // Expo's hook never re-reads on resume, and Android doesn't restart the app
  // when the camera is allowed in Settings — so without this the button stays
  // "Open Settings" and needs another tap after coming back. Runs immediately
  // rather than staggered: it's one cheap status read, only while this pane is
  // on screen and still waiting for access, not app-wide work on every resume.
  useEffect(() => {
    if (permissionGranted) return;
    let alive = true;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      getPermission()
        // Already granted: the parent's request resolves without a prompt and
        // flips its `permissionGranted`, so the camera starts with no tap.
        .then((result) => (result.granted ? onRequestPermission() : result))
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
    setLatestPermission(await requestOrOpenSettings(onRequestPermission, blocked));
  }, [onRequestPermission, blocked]);

  return { blocked, onPress };
}
