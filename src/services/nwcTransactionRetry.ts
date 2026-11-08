import type { NostrWebLNProvider } from '@getalby/sdk';
import { CONNECTION_REPLACED_MESSAGE } from './nwcConnectionAttempts';
import { isWalletAnswer } from './nwcErrors';

/** Identity cancellation must fence retries, not just the eventual UI result. */
export async function listTransactionsWithRetry(
  walletId: string,
  provider: NostrWebLNProvider,
  reconnectProvider: () => Promise<NostrWebLNProvider>,
  isActive: () => boolean,
): Promise<unknown[]> {
  // Retry up to 3 times. The LNbits Nostrclient relay has a sporadic
  // transport race where the first request after startup (or after a
  // period of inactivity) is silently dropped — the server never logs
  // it, the client hits the NWC SDK's ~60s reply timeout. Retrying with
  // a relay reconnect between attempts usually clears it on attempt 2.
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!isActive()) throw new Error(CONNECTION_REPLACED_MESSAGE);
    try {
      // LNbits's NWC provider defaults to `limit: 10` (see
      // extensions/nwcprovider/tasks.py::_on_list_transactions), so an empty
      // request only returns the 10 most recent payments. 50 is a balance
      // between showing real history and keeping the fetch + follow-up zap
      // resolver fast; bumping higher (100+) made first-load noticeably slow.
      const result = await provider.listTransactions({ limit: 50 });
      if (!isActive()) throw new Error(CONNECTION_REPLACED_MESSAGE);
      return result.transactions || [];
    } catch (error) {
      if (!isActive()) throw new Error(CONNECTION_REPLACED_MESSAGE);
      // The wallet ANSWERED, just with a NIP-47 error (e.g. NOT_IMPLEMENTED):
      // retrying can't change that, and the reconnect would reset the reply
      // timestamp and leave a healthy wallet grey. Surface the original error
      // at once so the caller's `trackWalletReply` credits the answer (#1768).
      if (isWalletAnswer(error)) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`listTransactions attempt ${attempt}/${maxAttempts} for ${walletId}:`, msg);
      if (attempt < maxAttempts) {
        // Reconnect the relay before retrying — a stale subscription
        // is the most common cause of the drop.
        try {
          provider = await reconnectProvider();
        } catch {}
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  throw new Error(`listTransactions for ${walletId} failed after ${maxAttempts} attempts`);
}
