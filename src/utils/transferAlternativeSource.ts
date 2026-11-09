// Before a Boltz cross-chain Move, offer a same-chain source wallet that can
// cover the amount — moving from it avoids the swap fee. Extracted from
// TransferSheet so the selection rule is testable on its own.

import { Alert } from '../components/BrandedAlert';
import type { WalletState } from '../types/wallet';
import type { TransferType } from './transferPhase';

/**
 * The best-funded wallet (other than the source) that could send `amountSats`
 * without a swap, or null. Only cross-chain Moves have an alternative:
 * on-chain→LN looks for a connected Lightning wallet, LN→on-chain for a
 * mnemonic (spendable) on-chain wallet.
 */
export function findSameChainAlternative(
  wallets: WalletState[],
  sourceId: string,
  transferType: TransferType,
  amountSats: number,
): WalletState | null {
  if (transferType !== 'onchain-to-ln' && transferType !== 'ln-to-onchain') return null;
  const eligible = (w: WalletState) =>
    transferType === 'onchain-to-ln'
      ? w.walletType === 'nwc' && w.isConnected
      : w.walletType === 'onchain' && w.onchainImportMethod === 'mnemonic';
  return (
    wallets
      .filter((w) => w.id !== sourceId && eligible(w) && (w.balance ?? 0) >= amountSats)
      .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))[0] ?? null
  );
}

/**
 * Ask whether to switch to `alternative`. Resolves `'switch'`, `'continue'`
 * (keep the swap) or `'cancel'`.
 */
export function promptSameChainAlternative(
  alternative: WalletState,
  transferType: 'onchain-to-ln' | 'ln-to-onchain',
  formatLocale: string,
): Promise<'switch' | 'continue' | 'cancel'> {
  const toLightning = transferType === 'onchain-to-ln';
  return new Promise((resolve) =>
    Alert.alert(
      toLightning ? 'Use Lightning wallet instead?' : 'Use on-chain wallet instead?',
      `"${alternative.alias}" has ${alternative.balance?.toLocaleString(formatLocale)} sats. ` +
        (toLightning
          ? 'Sending from a Lightning wallet avoids Boltz swap fees.'
          : 'Sending from an on-chain wallet avoids Boltz swap fees.'),
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve('cancel') },
        {
          text: toLightning ? 'Use Lightning' : 'Use on-chain',
          onPress: () => resolve('switch'),
        },
        {
          text: toLightning ? 'Continue with on-chain' : 'Continue with Lightning',
          onPress: () => resolve('continue'),
        },
      ],
    ),
  );
}
