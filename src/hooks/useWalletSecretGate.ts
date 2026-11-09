// Gate for the wallet secrets on the settings Connection tab (#1784): the NWC
// connection string (full spend authority) and the CoinOS recovery password.
// Same mechanism as the Back up your key screen (`useKeyBackupReveal`, #1223):
//  - screenshots / screen recording / the recents thumbnail are blocked for
//    as long as the tab is mounted with a secret on it, and a reveal waits for
//    that to settle (warning first if the platform refused it);
//  - revealing, showing the QR and copying need device authentication
//    (`keyRevealGate` + `authenticateForKeyReveal`), or an explicit
//    confirmation when the phone has no screen lock;
//  - the unlock is dropped on app background and on unmount, so leaving the
//    tab or the app needs a fresh unlock;
//  - copies go through the secret clipboard (`copySensitiveText`).
// The secrets themselves never pass through this hook — callers render or
// copy them only after `unlocked` / `reveal()` / `copy()` say so. Nothing
// here logs.
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { Alert } from '../components/BrandedAlert';
import { useTranslation } from '../contexts/LocaleContext';
import { authenticateForKeyReveal, keyRevealGate } from '../services/accountKeyAccess';
import { copySensitiveText } from '../services/sensitiveClipboard';

const SCREEN_CAPTURE_KEY = 'wallet-secret';

export interface WalletSecretGate {
  /** True once the gate has passed on this visit; render secrets only then. */
  unlocked: boolean;
  busy: boolean;
  authFailed: boolean;
  /** Run the gate before showing a secret (reveal or QR). Resolves true if it may be shown. */
  reveal: () => Promise<boolean>;
  /** Run the gate, then copy `text` through the secret clipboard. */
  copy: (text: string) => Promise<boolean>;
}

/** `active` = a secret is on this view (NWC string or CoinOS password). */
export function useWalletSecretGate(active: boolean): WalletSecretGate {
  const t = useTranslation();
  const [unlocked, setUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authFailed, setAuthFailed] = useState(false);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);
  const unlockingRef = useRef(false);
  const authenticatingRef = useRef(false);
  const foregroundWaitRef = useRef<((active: boolean) => void) | null>(null);
  const protectionRef = useRef<Promise<boolean>>(Promise.resolve(false));

  const lock = useCallback(() => {
    generationRef.current += 1;
    unlockingRef.current = false;
    authenticatingRef.current = false;
    foregroundWaitRef.current?.(false);
    foregroundWaitRef.current = null;
    setUnlocked(false);
    setBusy(false);
    setAuthFailed(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    // Android 7–10 opens the PIN/pattern prompt in a separate activity,
    // which reports background; keep only that pending authentication alive.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' && !authenticatingRef.current) lock();
      if (state === 'active') {
        foregroundWaitRef.current?.(true);
        foregroundWaitRef.current = null;
      }
    });
    return () => {
      mountedRef.current = false;
      sub.remove();
      lock();
    };
  }, [lock]);

  // Capture protection for the whole time a secret is on this view — before
  // anything is revealed, so no frame showing it is painted unprotected.
  useEffect(() => {
    if (!active) {
      protectionRef.current = Promise.resolve(false);
      return;
    }
    const enable = async () => {
      await ScreenCapture.preventScreenCaptureAsync(SCREEN_CAPTURE_KEY);
      if (Platform.OS === 'ios') await ScreenCapture.enableAppSwitcherProtectionAsync();
    };
    protectionRef.current = enable().then(
      () => true,
      () => false,
    );
    return () => {
      protectionRef.current = Promise.resolve(false);
      ScreenCapture.allowScreenCaptureAsync(SCREEN_CAPTURE_KEY).catch(() => {});
      if (Platform.OS === 'ios') ScreenCapture.disableAppSwitcherProtectionAsync().catch(() => {});
    };
  }, [active]);

  const confirm = useCallback(
    (title: string, message: string, confirmText: string, testIDPrefix: string) =>
      new Promise<boolean>((resolve) => {
        Alert.alert(title, message, [
          {
            text: t('keyBackupScreen.cancel'),
            style: 'cancel',
            onPress: () => resolve(false),
            testID: `${testIDPrefix}-cancel`,
          },
          {
            text: confirmText,
            style: 'destructive',
            onPress: () => resolve(true),
            testID: `${testIDPrefix}-confirm`,
          },
        ]);
      }),
    [t],
  );

  const unlock = useCallback(async (): Promise<boolean> => {
    if (!active || !mountedRef.current || unlockingRef.current) return false;
    if (unlocked) return true;
    const generation = generationRef.current;
    const isCurrent = () => mountedRef.current && generationRef.current === generation;
    unlockingRef.current = true;
    setBusy(true);
    setAuthFailed(false);
    try {
      const gate = await keyRevealGate();
      if (!isCurrent()) return false;
      let passed: boolean;
      if (gate === 'device-auth') {
        authenticatingRef.current = true;
        passed = await authenticateForKeyReveal({
          promptMessage: t('walletSettingsSheet.secretAuthPrompt'),
          cancelLabel: t('keyBackupScreen.cancel'),
        });
        if (passed && isCurrent() && AppState.currentState !== 'active') {
          passed = await new Promise<boolean>((resolve) => {
            foregroundWaitRef.current = resolve;
          });
        }
        if (isCurrent()) authenticatingRef.current = false;
      } else {
        passed = await confirm(
          t('keyBackupScreen.noLockTitle'),
          t('walletSettingsSheet.secretNoLockMessage'),
          t('keyBackupScreen.noLockConfirm'),
          'wallet-secret-no-lock',
        );
      }
      if (!isCurrent()) return false;
      if (!passed) {
        if (gate === 'device-auth') setAuthFailed(true);
        return false;
      }
      setUnlocked(true);
      return true;
    } catch {
      return false;
    } finally {
      if (isCurrent()) {
        authenticatingRef.current = false;
        unlockingRef.current = false;
        setBusy(false);
      }
    }
  }, [active, unlocked, t, confirm]);

  const reveal = useCallback(async () => {
    const generation = generationRef.current;
    const isCurrent = () => mountedRef.current && generationRef.current === generation;
    const isProtected = await protectionRef.current;
    if (!isCurrent()) return false;
    if (
      !isProtected &&
      !(await confirm(
        t('keyBackupScreen.unprotectedTitle'),
        t('walletSettingsSheet.secretUnprotectedMessage'),
        t('keyBackupScreen.unprotectedConfirm'),
        'wallet-secret-unprotected',
      ))
    )
      return false;
    if (!isCurrent()) return false;
    return (await unlock()) && isCurrent();
  }, [unlock, confirm, t]);

  const copy = useCallback(
    async (text: string) => {
      const generation = generationRef.current;
      if (!(await unlock())) return false;
      if (!mountedRef.current || generationRef.current !== generation) return false;
      try {
        await copySensitiveText(text);
        return true;
      } catch {
        return false;
      }
    },
    [unlock],
  );

  return { unlocked: active && unlocked, busy, authFailed, reveal, copy };
}
