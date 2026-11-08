import type { WalletConnectionHealth, WalletState } from '../types/wallet';

/**
 * The health a wallet's status dot/label should show (#786, #1768).
 *
 * On-chain wallets have no relay, so they stay binary (balance present →
 * responsive). For NWC the live `connectionHealth` from the watchdog wins;
 * before its first sync it's undefined and we show neutral `checking` — NOT
 * the binary `isConnected`, which is true as soon as the relay socket opens,
 * long before the wallet service has answered anything.
 */
export function resolveWalletHealth(
  wallet: Pick<WalletState, 'walletType' | 'balance' | 'connectionHealth'>,
): WalletConnectionHealth {
  if (wallet.walletType === 'onchain') {
    return wallet.balance !== null ? 'responsive' : 'disconnected';
  }
  return wallet.connectionHealth ?? 'checking';
}
