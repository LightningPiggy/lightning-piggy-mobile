import { Linking } from 'react-native';
import { Alert, type BrandedAlertButton } from '../components/BrandedAlert';
import { ensurePermission, isPermissionBlocked, requestOrOpenSettings } from './permissionPrompt';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));

const GRANTED = { granted: true, canAskAgain: true };
const DENIED = { granted: false, canAskAgain: true };
const BLOCKED = { granted: false, canAskAgain: false };

let openSettings: jest.SpyInstance;
beforeEach(() => {
  openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});
afterEach(() => jest.clearAllMocks());

const alertButtons = (): BrandedAlertButton[] | undefined =>
  (Alert.alert as jest.Mock).mock.calls[0][2];

describe('isPermissionBlocked', () => {
  it('is only true once denied with no OS prompt left', () => {
    expect(isPermissionBlocked(BLOCKED)).toBe(true);
    expect(isPermissionBlocked(DENIED)).toBe(false);
    expect(isPermissionBlocked(GRANTED)).toBe(false);
    // Granted but `canAskAgain` false (Android reports this) is not blocked.
    expect(isPermissionBlocked({ granted: true, canAskAgain: false })).toBe(false);
    expect(isPermissionBlocked(null)).toBe(false);
    expect(isPermissionBlocked(undefined)).toBe(false);
  });
});

describe('requestOrOpenSettings', () => {
  it('opens Settings when tapped while already blocked', async () => {
    const request = jest.fn().mockResolvedValue(BLOCKED);
    await expect(requestOrOpenSettings(request, true)).resolves.toEqual(BLOCKED);
    expect(request).toHaveBeenCalledTimes(1);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it('does not open Settings on a fresh denial', async () => {
    const request = jest.fn().mockResolvedValue(BLOCKED);
    await requestOrOpenSettings(request, false);
    expect(openSettings).not.toHaveBeenCalled();
  });

  it('picks up a grant made in Settings instead of reopening them', async () => {
    const request = jest.fn().mockResolvedValue(GRANTED);
    await expect(requestOrOpenSettings(request, true)).resolves.toEqual(GRANTED);
    expect(openSettings).not.toHaveBeenCalled();
  });
});

describe('ensurePermission', () => {
  it('resolves true without an alert when granted', async () => {
    await expect(ensurePermission(jest.fn().mockResolvedValue(GRANTED), 'T', 'M')).resolves.toBe(
      true,
    );
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('explains with a plain OK alert while the OS can still prompt', async () => {
    await expect(ensurePermission(jest.fn().mockResolvedValue(DENIED), 'T', 'M')).resolves.toBe(
      false,
    );
    expect(Alert.alert).toHaveBeenCalledWith('T', 'M', [{ text: expect.any(String) }]);
  });

  it('offers Open Settings once permanently denied', async () => {
    await expect(ensurePermission(jest.fn().mockResolvedValue(BLOCKED), 'T', 'M')).resolves.toBe(
      false,
    );
    const buttons = alertButtons();
    expect(buttons).toHaveLength(2);
    expect(buttons?.[0].style).toBe('cancel');
    expect(openSettings).not.toHaveBeenCalled();
    buttons?.[1].onPress?.();
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});
