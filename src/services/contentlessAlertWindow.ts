import AsyncStorage from '@react-native-async-storage/async-storage';

// One audible "New encrypted message" per account per window; the rest land quietly (#1861).
export const CONTENTLESS_QUIET_WINDOW_MS = 10 * 60 * 1000;

const keyFor = (owner: string) => `contentless_alert_last_v1:${owner}`;
let queue: Promise<unknown> = Promise.resolve();

/**
 * True when this contentless alert may buzz, and records it; false while an
 * earlier one buzzed within the window. Persisted, so a headless restart after
 * the OS kills the app keeps the window; serialised, so a burst of wraps
 * arriving together buzzes once.
 */
export function claimAudibleContentlessAlert(owner: string, now = Date.now()): Promise<boolean> {
  const run = queue.then(async () => {
    try {
      const last = Number(await AsyncStorage.getItem(keyFor(owner)));
      if (
        Number.isFinite(last) &&
        last > 0 &&
        last <= now &&
        now - last < CONTENTLESS_QUIET_WINDOW_MS
      )
        return false;
      await AsyncStorage.setItem(keyFor(owner), String(now));
    } catch {
      // Storage unavailable: buzzing is the safe failure, never a missed message.
    }
    return true;
  });
  queue = run.catch(() => {});
  return run;
}
