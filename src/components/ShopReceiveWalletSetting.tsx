import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { useInvoiceWallets } from '../hooks/useInvoiceWallets';
import { loadSellerReceiveWallet, saveSellerReceiveWallet } from '../services/sellerReceiveWallet';
import { resolveReceiveWallet } from '../utils/invoiceWallets';
import { createInvoiceWalletPickerStyles } from '../styles/InvoiceWalletPicker.styles';
import InvoiceWalletPicker from './InvoiceWalletPicker';
import { Toast } from './BrandedToast';

/**
 * Shop setting: "Receive payments to" — the wallet order invoices are
 * created on by default. Saved on this device for the signed-in account
 * (services/sellerReceiveWallet), never published. A removed or pay-only
 * wallet reads as unset, so the seller is asked again at invoice time.
 * Standalone so any shop screen (e.g. Currencies) can host it.
 */
function ShopReceiveWalletSetting(): React.ReactElement {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createInvoiceWalletPickerStyles(colors), [colors]);
  const { pubkey } = useNostr();
  const choices = useInvoiceWallets(true);
  const [stored, setStored] = useState<string | null>(null);

  useEffect(() => {
    setStored(null);
    if (!pubkey) return;
    let cancelled = false;
    void loadSellerReceiveWallet(pubkey).then((id) => {
      if (!cancelled) setStored(id);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey]);

  const selectedId = resolveReceiveWallet(stored, choices);
  const onSelect = useCallback(
    (walletId: string) => {
      if (!pubkey) return;
      setStored(walletId);
      saveSellerReceiveWallet(pubkey, walletId).catch(() =>
        Toast.show({ type: 'error', text1: t('sellerOrders.wallet.saveFailed') }),
      );
    },
    [pubkey, t],
  );

  return (
    <View style={styles.container} testID="shop-receive-wallet-picker">
      <Text style={styles.label}>{t('sellerOrders.wallet.receiveTo')}</Text>
      <Text style={styles.hint}>{t('sellerOrders.wallet.receiveToHint')}</Text>
      <InvoiceWalletPicker
        choices={choices}
        selectedId={selectedId}
        onSelect={onSelect}
        testIDPrefix="shop-receive-wallet"
      />
    </View>
  );
}

export default React.memo(ShopReceiveWalletSetting);
