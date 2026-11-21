import AsyncStorage from '@react-native-async-storage/async-storage';

// Both the headless service and mounted UI share this queue: the native
// BackgroundDmService dispatches its headless task into the application's
// single ReactHost `currentReactContext` (see BackgroundDmService.kt →
// startHeadlessTask), so there is exactly one JS runtime per process and this
// module-level promise chain serialises every claim. Persist before posting so
// a process restart cannot announce an already claimed payment.
let queue: Promise<unknown> = Promise.resolve();
export function notifyPaymentOnce(
  owner: string,
  walletId: string,
  paymentId: string,
  send: () => Promise<string | null>,
  // Re-checked inside the serialised queue, right before the claim is written
  // and again after — may be async so callers can re-read storage-backed
  // scope (identity / wallet list / credential) per delivery.
  isCurrent: () => boolean | Promise<boolean> = () => true,
): Promise<string | null> {
  const operation = queue
    .catch(() => {})
    .then(async () => {
      const key = `payment_notifications_v1:${owner}:${walletId}`;
      const raw = await AsyncStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error('Invalid payment notification history');
      const seen = parsed.filter((id): id is string => typeof id === 'string');
      if (seen.includes(paymentId) || !(await isCurrent())) return null;
      await AsyncStorage.setItem(key, JSON.stringify([...seen, paymentId].slice(-2048)));
      let result: string | null = null;
      try {
        if (!(await isCurrent())) return null;
        result = await send();
        return result;
      } finally {
        // Permission denial / scheduling failure is retryable on the next pass.
        if (result === null) await AsyncStorage.setItem(key, JSON.stringify(seen));
      }
    });
  queue = operation;
  return operation;
}

/** Whether a payment's notification is recorded as delivered (or claimed by the UI). */
export async function wasPaymentNotified(
  owner: string,
  walletId: string,
  paymentId: string,
): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(`payment_notifications_v1:${owner}:${walletId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) && parsed.includes(paymentId);
  } catch {
    return false;
  }
}

/**
 * Claim payments the UI already showed without an OS notification — the
 * receive announcer publishes only the newest of a burst, so the rest must be
 * claimed here or the background poll would alert for them later (#1100
 * review). Shares the queue so it cannot interleave with a delivery.
 */
export function markPaymentsSeen(
  owner: string,
  walletId: string,
  paymentIds: readonly string[],
  isCurrent: () => boolean | Promise<boolean> = () => true,
): Promise<void> {
  const operation = queue
    .catch(() => {})
    .then(async () => {
      if (paymentIds.length === 0) return;
      const key = `payment_notifications_v1:${owner}:${walletId}`;
      const raw = await AsyncStorage.getItem(key);
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error('Invalid payment notification history');
      const seen = parsed.filter((id): id is string => typeof id === 'string');
      const fresh = paymentIds.filter(
        (id, i) => !seen.includes(id) && paymentIds.indexOf(id) === i,
      );
      if (fresh.length === 0 || !(await isCurrent())) return;
      await AsyncStorage.setItem(key, JSON.stringify([...seen, ...fresh].slice(-2048)));
    });
  queue = operation;
  return operation;
}
