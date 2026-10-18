import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Check, Wallet } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createInvoiceWalletPickerStyles } from '../styles/InvoiceWalletPicker.styles';
import type { InvoiceWalletChoice } from '../utils/invoiceWallets';

interface Props {
  choices: readonly InvoiceWalletChoice[];
  selectedId: string | null;
  onSelect: (walletId: string) => void;
  /** Row testIDs are `<prefix>-<walletId>`. */
  testIDPrefix: string;
  disabled?: boolean;
}

/**
 * Pick the Lightning wallet an order invoice is created on. Lists only
 * wallets that can make invoices (see utils/invoiceWallets); a wallet whose
 * permissions are still being checked shows but can't be chosen yet.
 */
function InvoiceWalletPicker({
  choices,
  selectedId,
  onSelect,
  testIDPrefix,
  disabled = false,
}: Props): React.ReactElement {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createInvoiceWalletPickerStyles(colors), [colors]);

  if (choices.length === 0) {
    return (
      <Text style={styles.empty} testID={`${testIDPrefix}-empty`}>
        {t('sellerOrders.wallet.none')}
      </Text>
    );
  }
  return (
    <View style={styles.container} accessibilityRole="radiogroup">
      {choices.map(({ wallet, capability }) => {
        const selected = wallet.id === selectedId;
        const checking = capability === 'unknown';
        const rowDisabled = disabled || checking;
        return (
          <TouchableOpacity
            key={wallet.id}
            style={[styles.row, selected && styles.rowSelected, rowDisabled && styles.rowDisabled]}
            onPress={() => onSelect(wallet.id)}
            disabled={rowDisabled}
            accessibilityRole="radio"
            accessibilityState={{ selected, disabled: rowDisabled }}
            accessibilityLabel={wallet.alias}
            testID={`${testIDPrefix}-${wallet.id}`}
          >
            <View style={[styles.radio, selected && styles.radioSelected]}>
              {selected ? <Check size={12} color={colors.white} strokeWidth={3} /> : null}
            </View>
            <Wallet size={18} color={colors.textSupplementary} strokeWidth={2} />
            <View style={styles.rowBody}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {wallet.alias}
              </Text>
              {checking ? (
                <Text style={styles.rowSub}>{t('sellerOrders.wallet.checking')}</Text>
              ) : !wallet.isConnected ? (
                <Text style={styles.rowSub}>{t('sellerOrders.wallet.offline')}</Text>
              ) : null}
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default React.memo(InvoiceWalletPicker);
