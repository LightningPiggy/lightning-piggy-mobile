// Decides what the remove-wallet confirmation says (#1777).
//
// Removing a wallet deletes its secrets from this phone. For a watch-only
// or URL-imported NWC wallet that only disconnects it, but a hot on-chain
// wallet loses its recovery phrase and a CoinOS wallet the app created loses
// its username / password — if those weren't saved, the money is gone. So
// those two cases get the sign-out wording (#1223), name the balance, and
// (CoinOS) offer to show the recovery info first.
//
// Pure (no React, no storage) so every variant is unit-testable; the caller
// resolves the i18n refs with `t()` and renders the branded Alert.
import type { WalletMetadata } from '../types/wallet';
import { hasStoredRecoveryPhrase, type I18nRef } from './signOutPrompt';

export type RemoveWalletRisk = 'phrase' | 'coinos' | 'none';

export interface RemoveWalletPromptInput {
  wallet: Pick<WalletMetadata, 'alias' | 'walletType' | 'onchainImportMethod' | 'hideBalance'> & {
    balance: number | null;
  };
  /** Whether a recovery phrase is stored for this (on-chain) wallet.
   *  `null` = the read failed. Checked as well as `onchainImportMethod`,
   *  which older wallets lack until the legacy migration fills it in. */
  mnemonicStored: boolean | null;
  /** Whether CoinOS username / password are stored for this (NWC) wallet.
   *  `null` = the read failed. */
  hasCoinosRecovery: boolean | null;
  /** Formats a sats amount for display (locale-aware). */
  formatAmount: (sats: number) => string;
}

export interface RemoveWalletPrompt {
  risk: RemoveWalletRisk;
  /** Warning paragraphs, in display order. Empty when `risk` is 'none' —
   *  the caller keeps its own plain "this will disconnect" message. */
  paragraphs: I18nRef[];
  /** Offer "View recovery info first" as the primary action. */
  offerViewRecovery: boolean;
}

// Fails safe: a storage read that errored counts as "may hold recovery
// details", so the user is warned rather than shown the plain message
// while removeWallet goes on to delete a phrase or login.
export function removeWalletRisk(input: RemoveWalletPromptInput): RemoveWalletRisk {
  const { wallet } = input;
  if (wallet.walletType === 'onchain') {
    return hasStoredRecoveryPhrase(wallet) || input.mnemonicStored !== false ? 'phrase' : 'none';
  }
  return input.hasCoinosRecovery !== false ? 'coinos' : 'none';
}

export function buildRemoveWalletPrompt(input: RemoveWalletPromptInput): RemoveWalletPrompt {
  const risk = removeWalletRisk(input);
  if (risk === 'none') return { risk, paragraphs: [], offerViewRecovery: false };

  const alias = { alias: input.wallet.alias };
  const paragraphs: I18nRef[] = [
    risk === 'phrase'
      ? { key: 'removeWalletPrompt.withPhrase', params: alias }
      : { key: 'removeWalletPrompt.withCoinosLogin', params: alias },
  ];
  // Name the money at stake — unless the user has hidden this wallet's balance.
  const { balance, hideBalance } = input.wallet;
  if (!hideBalance && balance !== null && balance > 0) {
    paragraphs.push({
      key: 'removeWalletPrompt.balance',
      params: { amount: input.formatAmount(balance) },
    });
  }
  // The CoinOS login can be re-displayed in Wallet Settings → Connection. The
  // app has no screen that re-shows an on-chain recovery phrase, so there's
  // nothing to offer there beyond the warning.
  return { risk, paragraphs, offerViewRecovery: risk === 'coinos' };
}
