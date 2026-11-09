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
  /** Whether CoinOS username / password are stored for this wallet. */
  hasCoinosRecovery: boolean;
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

export function removeWalletRisk(input: RemoveWalletPromptInput): RemoveWalletRisk {
  if (hasStoredRecoveryPhrase(input.wallet)) return 'phrase';
  if (input.wallet.walletType === 'nwc' && input.hasCoinosRecovery) return 'coinos';
  return 'none';
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
