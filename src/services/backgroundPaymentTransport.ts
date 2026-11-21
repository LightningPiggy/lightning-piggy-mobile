import { AppState } from 'react-native';
import type { NostrWebLNProvider } from '@getalby/sdk';
import { pinNip04IfNoInfoEvent } from './nwcEncryption';
import { patchRelayPublish } from './nwcRelayPublishPatch';

/**
 * A WebLN `listTransactions` row. NOT a raw NIP-47 row: the wrapper has
 * already converted `amount` (and `fees_paid`) from msats to whole sats.
 */
export type BackgroundTransaction = Awaited<
  ReturnType<NostrWebLNProvider['listTransactions']>
>['transactions'][number];

export const PAGE_SIZE = 20;
const MAX_PAGES = 5;

// Unknown times count as inside, so a page of them is followed rather than cut short.
function isInsideWindow(tx: BackgroundTransaction, windowStart: number): boolean {
  const time = tx?.settled_at ?? tx?.created_at;
  return !Number.isSafeInteger(time) || time >= windowStart;
}

/** A read-only request on a private connection; never replace the UI's client. */
export async function readBackgroundPayments(
  walletId: string,
  url: string,
  signal: AbortSignal,
  windowStart = 0,
): Promise<BackgroundTransaction[]> {
  if (AppState.currentState === 'active' || signal.aborted) return [];
  // Load the SDK only for an opted-in background request, not during headless task registration.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NostrWebLNProvider } = require('@getalby/sdk') as typeof import('@getalby/sdk');
  const provider = new NostrWebLNProvider({ nostrWalletConnectUrl: url });
  // Same no-wait-for-OK patch as nwcService.connect — without it an LNbits
  // Nostrclient relay (no NIP-20 OK) would hold every list_transactions
  // publish until the deadline below and the poll would never notify.
  // Silent on failure: the deadline + next pass cover it, and we never log
  // the SDK error (it can carry relay/wallet details).
  patchRelayPublish(provider, () => {});
  const cacheKey = `background:${walletId}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  const close = () => {
    try {
      provider.close();
    } catch {
      /* already disconnected */
    }
  };
  let cancel: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => {
      cancelled = true;
      close();
      reject(new Error('Background wallet request cancelled or timed out'));
    };
    timer = setTimeout(cancel, 25_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
  const appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') cancel();
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        try {
          if (cancelled) throw new Error('Cancelled');
          await provider.enable();
          if (cancelled) throw new Error('Cancelled');
          await pinNip04IfNoInfoEvent(provider, cacheKey);
          if (cancelled) throw new Error('Cancelled');
          // No `from`: some wallets filter creation time, missing invoices made
          // earlier but settled now. Select by settlement time in the worker.
          // Same public WebLN wrapper nwcService.listTransactions uses.
          // Small pages, since this runs every minute per wallet (#1860); the next page only while the whole page is still inside the watch window.
          const rows: BackgroundTransaction[] = [];
          for (let page = 0; page < MAX_PAGES; page++) {
            if (cancelled) throw new Error('Cancelled');
            const result = await provider.listTransactions({
              type: 'incoming',
              unpaid: false,
              limit: PAGE_SIZE,
              offset: page * PAGE_SIZE,
            });
            const batch = Array.isArray(result.transactions) ? result.transactions : [];
            rows.push(...batch);
            if (batch.length < PAGE_SIZE || !batch.every((tx) => isInsideWindow(tx, windowStart)))
              break;
          }
          return rows;
        } finally {
          // enable/probe can settle after cancellation; close any late socket.
          if (cancelled) {
            close();
          }
        }
      })(),
    ]);
  } finally {
    appStateSubscription.remove();
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    close();
  }
}
