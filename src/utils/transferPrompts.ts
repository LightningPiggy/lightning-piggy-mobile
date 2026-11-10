// The prompts the Move sheet (TransferSheet) awaits before it moves anything.
//
// Every prompt resolves on `onDismiss` as a cancel. BrandedAlert closes an open
// alert when another one replaces it (e.g. a background swap's refund alert)
// and only calls the displaced alert's `onDismiss` (#1264). A prompt without
// it never settles, and because Move runs behind a single-flight guard, every
// later Move tap would be silently dropped (#1778).

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
 * Before a Boltz cross-chain Move, offer the same-chain `alternative` — moving
 * from it avoids the swap fee. Resolves `'switch'`, `'continue'` (keep the
 * swap) or `'cancel'` (also on dismissal).
 */
export function promptSameChainAlternative(
  alternative: WalletState,
  transferType: TransferType,
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
      { onDismiss: () => resolve('cancel') },
    ),
  );
}

/**
 * High-value confirmation (issue #82). `amountLabel` is pre-formatted, e.g.
 * "5,000 sats ($3.10)". Resolves true only on Confirm — false on Cancel or dismissal.
 */
export function confirmLargeMove(
  amountLabel: string,
  sourceAlias: string,
  destAlias: string,
): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(
      'Confirm large move',
      `You're about to move ${amountLabel} from ${sourceAlias} to ${destAlias}. Tap Confirm to proceed.`,
      [
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Confirm', onPress: () => resolve(true) },
      ],
      { onDismiss: () => resolve(false) },
    ),
  );
}
