import { Linking } from 'react-native';
import { Alert } from '../components/BrandedAlert';
import { t } from '../i18n';

/** The two fields every Expo permission response carries. */
export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

export type RequestPermission = () => Promise<PermissionState>;

/**
 * Denied, and the OS won't show its prompt again (iOS after one denial,
 * Android after "Don't ask again"). Only system Settings can grant it now, so
 * a "Grant permission" button that just re-requests would do nothing.
 */
export function isPermissionBlocked(permission: PermissionState | null | undefined): boolean {
  return !!permission && !permission.granted && !permission.canAskAgain;
}

function openSettings(): void {
  Linking.openSettings().catch(() => undefined);
}

/**
 * For an inline "Grant permission" / "Open Settings" button. Always requests
 * first: when blocked the OS resolves at once without a prompt, and picks up a
 * grant the user has since made in Settings. Only a tap made while already
 * blocked opens Settings — a fresh denial just now doesn't bounce the user out
 * of the app; the button turns into "Open Settings" instead.
 */
export async function requestOrOpenSettings(
  request: RequestPermission,
  wasBlocked: boolean,
): Promise<PermissionState> {
  const result = await request();
  if (wasBlocked && isPermissionBlocked(result)) openSettings();
  return result;
}

/**
 * Requests a permission and, if it isn't granted, explains why it's needed.
 * Once the OS has stopped prompting, the alert offers "Open Settings" — the
 * only way left to grant it. Resolves true when granted.
 */
export async function ensurePermission(
  request: RequestPermission,
  title: string,
  message: string,
): Promise<boolean> {
  const result = await request();
  if (result.granted) return true;
  Alert.alert(
    title,
    message,
    isPermissionBlocked(result)
      ? [
          { text: t('permissionPrompt.cancel'), style: 'cancel' },
          {
            text: t('permissionPrompt.openSettings'),
            onPress: openSettings,
            testID: 'permission-open-settings',
          },
        ]
      : undefined,
  );
  return false;
}
