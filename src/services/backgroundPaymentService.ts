import { captureBackgroundPaymentScope } from './backgroundPaymentScope';
import { AppState, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadIdentities } from './identitiesStore';
import { getNwcUrl, getWalletList } from './walletStorageService';
import { loadBackgroundDmEnabled } from './backgroundDmPreference';
import { firePaymentNotification, hasNotificationPermission } from './notificationService';
import { notifyPaymentOnce } from './paymentNotificationDedupe';
import { readBackgroundPayments } from './backgroundPaymentTransport';

const appIsActive = () => AppState.currentState === 'active';
const INTERVAL_MS = 60_000;
const CATCHUP_SECONDS = 24 * 60 * 60;
let controller: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether a background payment poll is worth running: opted in, permitted,
 * and the active identity owns at least one NWC wallet. Lets the service
 * hosts keep the foreground service alive for a payment-only identity (one
 * with NWC wallets but no DM relays) instead of tearing it down with the DM
 * subscription (#1100 review).
 */
export async function canWatchBackgroundPayments(): Promise<boolean> {
  try {
    if (Platform.OS !== 'android') return false;
    if (!(await loadBackgroundDmEnabled()) || !(await hasNotificationPermission())) return false;
    const { activePubkey } = await loadIdentities();
    if (!activePubkey) return false;
    for (const wallet of await getWalletList(activePubkey)) {
      if (wallet.walletType !== 'nwc') continue;
      try {
        if ((await getNwcUrl(wallet.id))?.trim()) return true;
      } catch {
        /* try another wallet */
      }
    }
  } catch {
    /* unavailable scope cannot sustain a payment-only host */
  }
  return false;
}

export function isBackgroundPaymentWatchRunning(): boolean {
  return controller !== null;
}

/** One pass; explicit account reads never mutate the foreground wallet scope. */
export async function checkBackgroundPayments(signal: AbortSignal): Promise<void> {
  const generationCurrent = captureBackgroundPaymentScope();
  if (Platform.OS !== 'android' || signal.aborted) return;
  if (!(await loadBackgroundDmEnabled()) || !(await hasNotificationPermission())) return;
  const { activePubkey } = await loadIdentities();
  if (!activePubkey) return;
  // Pass-wide scope: the preference and active identity this pass was read for.
  const scopeCurrent = async () =>
    (await loadBackgroundDmEnabled()) &&
    (await loadIdentities()).activePubkey === activePubkey &&
    generationCurrent();
  const wallets = await getWalletList(activePubkey);
  for (const wallet of wallets) {
    if (signal.aborted) return;
    if (wallet.walletType !== 'nwc') continue;
    try {
      const key = `background_payment_start_v1:${activePubkey}:${wallet.id}`;
      const saved = await AsyncStorage.getItem(key);
      const now = Math.floor(Date.now() / 1000);
      const start = saved === null ? now : Number(saved);
      if (!Number.isSafeInteger(start) || start < 0) continue;
      if (saved === null) await AsyncStorage.setItem(key, String(start));
      // Prime eligibility while the UI is open, without extra wallet traffic.
      if (appIsActive()) continue;
      const url = await getNwcUrl(wallet.id);
      if (!url || signal.aborted) continue;
      // Wallet scope: still listed for this identity, credential unchanged.
      const walletCurrent = async () =>
        (await getWalletList(activePubkey)).some((w) => w.id === wallet.id) &&
        (await getNwcUrl(wallet.id)) === url;
      if (appIsActive()) return;
      const windowStart = Math.max(start, now - CATCHUP_SECONDS);
      const transactions = await readBackgroundPayments(wallet.id, url, signal, windowStart);
      // A switch/removal/disable during a slow request must invalidate its result.
      if (signal.aborted || !(await scopeCurrent())) return;
      if (!(await walletCurrent())) continue;
      for (const tx of transactions) {
        // Some providers report explicit settlement without settled_at. State
        // establishes payment, while creation time only bounds recency: accept
        // these receipts only if the invoice itself was created during this
        // watch window. Never use creation time alone as settlement evidence or
        // announce old timestamp-less history on first background polling.
        const receiptTime = tx?.settled_at ?? (tx?.state === 'settled' ? tx.created_at : undefined);
        if (
          !tx ||
          tx.type !== 'incoming' ||
          (tx.state && tx.state !== 'settled') ||
          !Number.isSafeInteger(receiptTime) ||
          receiptTime! < windowStart ||
          receiptTime! > now + 120 ||
          !/^[0-9a-f]{64}$/i.test(tx.payment_hash ?? '') ||
          !Number.isSafeInteger(tx.amount) ||
          tx.amount <= 0
        )
          continue;
        if (signal.aborted) return;
        // Re-validated per delivery, inside the dedupe queue: the credential,
        // wallet list, preference or identity can change between two
        // transactions of the same response (Copilot review, #1100).
        await notifyPaymentOnce(
          activePubkey,
          wallet.id,
          tx.payment_hash.toLowerCase(),
          () =>
            firePaymentNotification({
              kind: 'payment',
              walletId: wallet.id,
              // Already sats: the WebLN wrapper converts NIP-47 msats, exactly
              // as the foreground receive announcer reads the same rows.
              amountSats: tx.amount,
              owner: activePubkey,
              sourceId: tx.payment_hash,
            }),
          async () =>
            !appIsActive() &&
            !signal.aborted &&
            (await scopeCurrent()) &&
            (await walletCurrent()) &&
            generationCurrent() &&
            !appIsActive(),
        );
      }
    } catch {
      // A wallet with revoked list_transactions permission, a locked keystore,
      // or an unreachable relay must not prevent other wallets being checked.
      // Never log the NWC URL, SDK error, invoice or decrypted transaction.
    }
  }
}

/**
 * Start the polling loop. `onUnwatchable` fires after a pass that found the
 * scope gone (preference off, permission revoked, no active identity or no
 * NWC wallet left) so the HOST can reconcile — stop the foreground service
 * when this was the only watcher, or keep it for a live DM subscription
 * (Copilot review, #1100). The loop itself keeps ticking (each idle pass is
 * two storage reads) so a wallet added later is picked up without a re-arm;
 * a host that tears down calls `stopBackgroundPaymentWatch`, which ends it.
 */
export function startBackgroundPaymentWatch(onUnwatchable?: () => void): void {
  if (Platform.OS !== 'android' || controller) return;
  const current = new AbortController();
  controller = current;
  const tick = async () => {
    try {
      await checkBackgroundPayments(current.signal);
      if (controller === current && !current.signal.aborted && onUnwatchable) {
        if (!(await canWatchBackgroundPayments())) onUnwatchable();
      }
    } catch {
      /* retry next pass */
    }
    if (controller === current && !current.signal.aborted) {
      timer = setTimeout(() => void tick(), INTERVAL_MS);
    }
  };
  void tick();
}

export function stopBackgroundPaymentWatch(): void {
  controller?.abort();
  controller = null;
  if (timer) clearTimeout(timer);
  timer = null;
}
