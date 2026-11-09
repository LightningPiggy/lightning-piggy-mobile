// Shows the remove-wallet confirmation (#1777). Shared by the Manage wallets
// row and the Wallet Settings sheet so both warn the same way before a
// recovery phrase or CoinOS login is deleted. Copy + buttons come from the
// pure `buildRemoveWalletPrompt`.
import { useCallback } from 'react';
import { Alert, type BrandedAlertButton } from '../components/BrandedAlert';
import { useLocale } from '../contexts/LocaleContext';
import { getCoinosRecovery } from '../services/walletStorageService';
import { buildRemoveWalletPrompt } from '../utils/removeWalletPrompt';
import type { WalletState } from '../types/wallet';

export interface RemoveWalletConfirmRequest {
  wallet: WalletState;
  title: string;
  /** Plain message for wallets whose removal deletes no recovery secret. */
  fallbackMessage: string;
  onConfirm: () => void;
  /** Shows the wallet's CoinOS recovery info (Wallet Settings → Connection). */
  onViewRecovery: () => void;
}

export function useRemoveWalletConfirm(): (req: RemoveWalletConfirmRequest) => Promise<void> {
  const { t, formatLocale } = useLocale();
  return useCallback(
    async (req: RemoveWalletConfirmRequest) => {
      const { wallet } = req;
      // Existence check only; a failed read counts as "no CoinOS login".
      const hasCoinosRecovery =
        wallet.walletType === 'nwc' &&
        (await getCoinosRecovery(wallet.id).catch(() => null)) !== null;
      const prompt = buildRemoveWalletPrompt({
        wallet,
        hasCoinosRecovery,
        formatAmount: (sats) => sats.toLocaleString(formatLocale),
      });
      const message =
        prompt.paragraphs.length > 0
          ? prompt.paragraphs.map((p) => t(p.key, p.params)).join('\n\n')
          : req.fallbackMessage;
      const cancel: BrandedAlertButton = {
        text: t('removeWalletPrompt.cancel'),
        style: 'cancel',
        testID: 'remove-wallet-cancel',
      };
      const confirm: BrandedAlertButton = {
        text: t(
          prompt.offerViewRecovery
            ? 'removeWalletPrompt.removeAnyway'
            : 'removeWalletPrompt.remove',
        ),
        style: 'destructive',
        onPress: req.onConfirm,
        testID: 'remove-wallet-confirm',
      };
      // Three actions stack vertically: the safe primary action on top,
      // Cancel last (same layout as the sign-out prompt).
      const buttons: BrandedAlertButton[] = prompt.offerViewRecovery
        ? [
            {
              text: t('removeWalletPrompt.viewRecoveryFirst'),
              onPress: req.onViewRecovery,
              testID: 'remove-wallet-view-recovery',
            },
            confirm,
            cancel,
          ]
        : [cancel, confirm];
      Alert.alert(req.title, message, buttons);
    },
    [t, formatLocale],
  );
}
