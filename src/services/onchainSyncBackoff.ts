// Per-wallet failure backoff for the background on-chain poll (#1725).
//
// The poll (contexts/useOnchainIncomingPoll) records failures and skips a
// wallet until its retry time. ANY successful sync clears the wallet's entry —
// onchainService.syncAndRefresh reports successes from every caller (pull-to-
// refresh, refreshBalanceForWallet, wallet open, the poll itself) — so a
// network that has recovered is picked up at once, not up to 30 min later.
// Module state (not hook state) precisely so that service can reach it.

/** The poll's healthy cadence; also the base of the backoff. */
export const ONCHAIN_POLL_MS = 2 * 60 * 1000;
const ONCHAIN_BACKOFF_CAP_MS = 30 * 60 * 1000;

const backoff = new Map<string, { failures: number; retryAt: number }>();

/** Wait before retrying a wallet after `failures` consecutive failed syncs. */
export function onchainRetryDelayMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(ONCHAIN_POLL_MS * 2 ** failures, ONCHAIN_BACKOFF_CAP_MS);
}

/** True while the poll should leave this wallet alone. */
export function isOnchainSyncBackedOff(walletId: string, now = Date.now()): boolean {
  const entry = backoff.get(walletId);
  return entry !== undefined && now < entry.retryAt;
}

export function recordOnchainSyncFailure(walletId: string, now = Date.now()): void {
  const failures = (backoff.get(walletId)?.failures ?? 0) + 1;
  backoff.set(walletId, { failures, retryAt: now + onchainRetryDelayMs(failures) });
}

export function noteOnchainSyncSuccess(walletId: string): void {
  backoff.delete(walletId);
}

/** Forget every wallet's backoff (resume from background, identity switch). */
export function clearOnchainSyncBackoff(): void {
  backoff.clear();
}

/** Drop entries for wallets that no longer exist (deleted, other account). */
export function pruneOnchainSyncBackoff(walletIds: Iterable<string>): void {
  const keep = new Set(walletIds);
  for (const id of [...backoff.keys()]) if (!keep.has(id)) backoff.delete(id);
}

/** @internal Test use only. */
export const __onchainSyncBackoffSize = (): number => backoff.size;
