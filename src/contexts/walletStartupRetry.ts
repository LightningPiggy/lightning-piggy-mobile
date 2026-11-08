import { useEffect } from 'react';
import { AppState } from 'react-native';

// Resume stagger (#554): latency-insensitive work waits ~3 s after
// AppState → active so the DM re-arm and tap dispatch go first.
export const WALLET_RETRY_RESUME_DELAY_MS = 3_000;
// Automatic (resume) retries back off 5 s, 10 s, 20 s … up to 5 min, and stop
// after this many failures. A pull-to-refresh is the user asking, so it skips
// the wait and the cap (it is still single-flight).
const RETRY_BASE_BACKOFF_MS = 5_000;
const RETRY_MAX_BACKOFF_MS = 5 * 60_000;
export const WALLET_RETRY_MAX_RESUME_ATTEMPTS = 5;

export type WalletRetryTrigger = 'resume' | 'refresh';

/**
 * In-session recovery for a failed cold-start wallet load (#1746). Armed only
 * when every startup attempt failed for an identity, and disarmed by a
 * successful retry or by that identity being superseded (the identity
 * hydration owns every later load).
 */
export interface WalletLoadRetry {
  /** The startup load failed for the identity `isCurrent` was captured for. */
  arm(isCurrent: () => boolean): void;
  isArmed(): boolean;
  /** Retry now if armed. Never rejects. */
  attempt(trigger: WalletRetryTrigger): Promise<void>;
}

/** `load` commits the wallets for the current identity, or throws. */
export function createWalletLoadRetry(
  load: () => Promise<void>,
  now: () => number = Date.now,
): WalletLoadRetry {
  let armedFor: (() => boolean) | null = null;
  let failures = 0;
  let notBefore = 0;
  let inFlight: Promise<void> | null = null;

  const disarm = () => {
    armedFor = null;
    failures = 0;
    notBefore = 0;
  };
  const isArmed = () => {
    if (armedFor && !armedFor()) disarm();
    return armedFor !== null;
  };

  return {
    arm(isCurrent) {
      armedFor = isCurrent;
      failures = 0;
      notBefore = 0;
    },
    isArmed,
    attempt(trigger) {
      if (!isArmed()) return Promise.resolve();
      if (inFlight) return inFlight;
      if (
        trigger === 'resume' &&
        (failures >= WALLET_RETRY_MAX_RESUME_ATTEMPTS || now() < notBefore)
      ) {
        return Promise.resolve();
      }
      const armedIdentity = armedFor;
      inFlight = (async () => {
        try {
          await load();
          if (armedFor === armedIdentity) disarm();
        } catch (error) {
          console.warn(`[Wallet] startup load retry (${trigger}) failed:`, error);
          if (armedFor !== armedIdentity) return;
          failures += 1;
          notBefore =
            now() + Math.min(RETRY_BASE_BACKOFF_MS * 2 ** (failures - 1), RETRY_MAX_BACKOFF_MS);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

/**
 * Retry an armed load on app resume, staggered and cancellable: a later
 * AppState change (background → active bounce) or unmount clears the timer.
 */
export function useWalletLoadRetryOnResume(retry: WalletLoadRetry): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (next) => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (next !== 'active' || !retry.isArmed()) return;
      timer = setTimeout(() => {
        timer = null;
        void retry.attempt('resume');
      }, WALLET_RETRY_RESUME_DELAY_MS);
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [retry]);
}
