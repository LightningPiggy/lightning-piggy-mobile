import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { useWalletSecretGate } from './useWalletSecretGate';
import { authenticateForKeyReveal, keyRevealGate } from '../services/accountKeyAccess';
import { copySensitiveText } from '../services/sensitiveClipboard';
import { Alert } from '../components/BrandedAlert';

jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('../services/accountKeyAccess', () => ({
  keyRevealGate: jest.fn(async () => 'device-auth'),
  authenticateForKeyReveal: jest.fn(async () => true),
}));
jest.mock('../services/sensitiveClipboard', () => ({ copySensitiveText: jest.fn(async () => {}) }));
jest.mock('expo-screen-capture', () => ({
  preventScreenCaptureAsync: jest.fn(async () => {}),
  allowScreenCaptureAsync: jest.fn(async () => {}),
  enableAppSwitcherProtectionAsync: jest.fn(async () => {}),
  disableAppSwitcherProtectionAsync: jest.fn(async () => {}),
}));

// Deliberately not a real connection string.
const SECRET = 'test-wallet-secret';
let appStateListener: ((state: AppStateStatus) => void) | null = null;

beforeEach(() => {
  jest.clearAllMocks();
  AppState.currentState = 'active';
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (state: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
});

function setup(active = true) {
  return renderHook(({ on }: { on: boolean }) => useWalletSecretGate(on), {
    initialProps: { on: active },
  });
}

it('blocks screen capture while a secret is on the tab and releases it on unmount', async () => {
  const { unmount } = setup();
  await act(async () => {});
  expect(ScreenCapture.preventScreenCaptureAsync).toHaveBeenCalledWith('wallet-secret');
  unmount();
  expect(ScreenCapture.allowScreenCaptureAsync).toHaveBeenCalledWith('wallet-secret');
});

it('does not block capture when there is no secret to protect', () => {
  setup(false);
  expect(ScreenCapture.preventScreenCaptureAsync).not.toHaveBeenCalled();
});

it('stays locked until device authentication passes', async () => {
  const { result } = setup();
  expect(result.current.unlocked).toBe(false);
  let shown = false;
  await act(async () => {
    shown = await result.current.reveal();
  });
  expect(authenticateForKeyReveal).toHaveBeenCalledTimes(1);
  expect(shown).toBe(true);
  expect(result.current.unlocked).toBe(true);
});

it('keeps the secret hidden and flags the failure when authentication fails', async () => {
  (authenticateForKeyReveal as jest.Mock).mockResolvedValueOnce(false);
  const { result } = setup();
  let shown = true;
  await act(async () => {
    shown = await result.current.reveal();
  });
  expect(shown).toBe(false);
  expect(result.current).toMatchObject({ unlocked: false, authFailed: true });
});

it('copies only after the gate, and only through the secret clipboard', async () => {
  (authenticateForKeyReveal as jest.Mock).mockResolvedValueOnce(false);
  const { result } = setup();
  await act(async () => {
    await result.current.copy(SECRET);
  });
  expect(copySensitiveText).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.copy(SECRET);
  });
  expect(copySensitiveText).toHaveBeenCalledWith(SECRET);
});

it('asks for a fresh unlock after the app goes to the background', async () => {
  const { result } = setup();
  await act(async () => {
    await result.current.reveal();
  });
  expect(result.current.unlocked).toBe(true);
  act(() => appStateListener?.('background'));
  expect(result.current.unlocked).toBe(false);
  await act(async () => {
    await result.current.reveal();
  });
  expect(authenticateForKeyReveal).toHaveBeenCalledTimes(2);
});

it('asks for confirmation, like key backup, when the phone has no screen lock', async () => {
  (keyRevealGate as jest.Mock).mockResolvedValueOnce('confirm-only');
  const { result } = setup();
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.reveal();
  });
  await act(async () => {});
  expect(authenticateForKeyReveal).not.toHaveBeenCalled();
  const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
  expect(title).toBe('keyBackupScreen.noLockTitle');
  await act(async () => {
    buttons[1].onPress();
    await pending;
  });
  expect(result.current.unlocked).toBe(true);
});

it('warns before revealing when capture protection could not be enabled', async () => {
  (ScreenCapture.preventScreenCaptureAsync as jest.Mock).mockRejectedValueOnce(new Error('no'));
  const { result } = setup();
  let pending!: Promise<boolean>;
  act(() => {
    pending = result.current.reveal();
  });
  await act(async () => {});
  const [title, , buttons] = (Alert.alert as jest.Mock).mock.calls[0];
  expect(title).toBe('keyBackupScreen.unprotectedTitle');
  let shown = true;
  await act(async () => {
    buttons[0].onPress();
    shown = await pending;
  });
  expect(shown).toBe(false);
  expect(authenticateForKeyReveal).not.toHaveBeenCalled();
});
