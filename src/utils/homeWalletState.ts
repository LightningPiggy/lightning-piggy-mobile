import type { WalletState } from '../types/wallet';
import { isSendableWallet } from './walletCapabilities';

/** Home's cards, transactions and actions must use the same wallet snapshot.
 * Hydration is only evidence of emptiness once storage has finished reading.
 */
export function selectHomeWalletState(
  wallets: readonly WalletState[],
  activeWalletId: string | null,
  walletsHydrated: boolean,
) {
  const activeWallet = wallets.find((wallet) => wallet.id === activeWalletId) ?? null;
  const hasWallets = wallets.length > 0;
  const isReceiveDisabled = walletsHydrated && !hasWallets;
  // A watch-only wallet (xpub / single address) has no signing key. Send stays
  // pressable so the tap can explain why, rather than silently doing nothing.
  // Only when the import method is KNOWN to be watch-only: an undefined method
  // (legacy migration pending or its read failed) may be a seed wallet, so it
  // stays disabled as before rather than being called watch-only.
  const isSendWatchOnly =
    !isReceiveDisabled &&
    activeWallet?.walletType === 'onchain' &&
    activeWallet.onchainImportMethod === 'xpub';
  const isSendDisabled =
    isReceiveDisabled ||
    (activeWallet !== null && !isSendWatchOnly && !isSendableWallet(activeWallet));
  const isTransferDisabled = walletsHydrated && wallets.length < 2;
  return {
    activeWallet,
    hasWallets,
    showWelcome: walletsHydrated && !hasWallets,
    isReceiveDisabled,
    isSendDisabled,
    isSendWatchOnly,
    isTransferDisabled,
    // A visible card must never look unavailable. Capability restrictions
    // still apply to taps; the sheets handle loading and connection errors.
    dimActions: walletsHydrated && !hasWallets,
  };
}
