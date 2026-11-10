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

/** `unknown` = the storage read failed, so we can't say what's stored. */
export type RemoveWalletRisk = 'phrase' | 'coinos' | 'unknown' | 'none';

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

// Fails safe: a storage read that errored is 'unknown', which still warns
// (hedged — it doesn't claim a secret exists) rather than showing the plain
// message while removeWallet goes on to delete whatever is stored.
export function removeWalletRisk(input: RemoveWalletPromptInput): RemoveWalletRisk {
  const { wallet } = input;
  if (wallet.walletType === 'onchain') {
    if (hasStoredRecoveryPhrase(wallet) || input.mnemonicStored === true) return 'phrase';
    return input.mnemonicStored === null ? 'unknown' : 'none';
  }
  if (input.hasCoinosRecovery === true) return 'coinos';
  return input.hasCoinosRecovery === null ? 'unknown' : 'none';
}

const WARNING_KEY: Record<Exclude<RemoveWalletRisk, 'none'>, string> = {
  phrase: 'removeWalletPrompt.withPhrase',
  coinos: 'removeWalletPrompt.withCoinosLogin',
  unknown: 'removeWalletPrompt.mayHoldRecovery',
};

export function buildRemoveWalletPrompt(input: RemoveWalletPromptInput): RemoveWalletPrompt {
  const risk = removeWalletRisk(input);
  if (risk === 'none') return { risk, paragraphs: [], offerViewRecovery: false };

  const alias = { alias: input.wallet.alias };
  const paragraphs: I18nRef[] = [{ key: WARNING_KEY[risk], params: alias }];
  // Name the money at stake — unless the user has hidden this wallet's balance.
  const { balance, hideBalance } = input.wallet;
  if (!hideBalance && balance !== null && balance > 0) {
    paragraphs.push({
      key: 'removeWalletPrompt.balance',
      params: { amount: input.formatAmount(balance) },
    });
  }
  // The CoinOS login can be re-displayed in Wallet Settings → Connection, so
  // offer it only when the read confirmed it's there. The app has no screen
  // that re-shows an on-chain recovery phrase.
  return { risk, paragraphs, offerViewRecovery: input.hasCoinosRecovery === true };
}
