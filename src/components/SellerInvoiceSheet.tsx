import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import {
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { Check, Zap } from 'lucide-react-native';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import BrandedSpinner from './BrandedSpinner';
import InvoiceWalletPicker from './InvoiceWalletPicker';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { useInvoiceWallets } from '../hooks/useInvoiceWallets';
import { loadSellerReceiveWallet } from '../services/sellerReceiveWallet';
import { resolveReceiveWallet } from '../utils/invoiceWallets';
import { formatMarketAmount } from '../utils/marketListingShipping';
import { shortOrderId } from '../utils/marketOrder';
import { createSellerInvoiceSheetStyles } from '../styles/SellerInvoiceSheet.styles';

interface Props {
  visible: boolean;
  onClose: () => void;
  orderId: string;
  /** The seller's computed total, in sats. */
  totalSats: number;
  fiatTotal: { amount: number; currency: string } | null;
  /** The buyer's stated amount, when it differs from `totalSats`. */
  buyerAmountSats: number | null;
  /** Create the invoice on `walletId` and send it; rejects with a coded error. */
  onConfirm: (walletId: string, remember: boolean) => Promise<void>;
  /** Localised error from the last attempt. */
  error: string | null;
}

/**
 * Confirm before invoicing an order: the computed total, and WHICH wallet the
 * invoice is created on. Pre-selects the shop's "Receive payments to" wallet
 * when it's still usable; otherwise nothing is pre-selected and the seller
 * must choose (with "Remember for my shop" to save the choice).
 */
function SellerInvoiceSheet({
  visible,
  onClose,
  orderId,
  totalSats,
  fiatTotal,
  buyerAmountSats,
  onConfirm,
  error,
}: Props): React.ReactElement {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createSellerInvoiceSheetStyles(colors), [colors]);
  const sheetRef = useRef<BottomSheetModal>(null);
  const { pubkey } = useNostr();
  const choices = useInvoiceWallets(visible);
  const [stored, setStored] = useState<string | null | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [remember, setRemember] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (visible) {
      setSelectedId(null);
      setRemember(false);
      setStored(undefined);
      sheetRef.current?.present();
      if (pubkey)
        void loadSellerReceiveWallet(pubkey).then((value) => {
          if (!cancelled) setStored(value);
        });
    } else {
      sheetRef.current?.dismiss();
    }
    return () => {
      cancelled = true;
    };
  }, [visible, pubkey]);

  // Pre-select the shop wallet once it's known to still make invoices.
  const shopWallet = resolveReceiveWallet(stored, choices);
  useEffect(() => {
    if (visible && shopWallet && selectedId === null) setSelectedId(shopWallet);
  }, [visible, shopWallet, selectedId]);
  const selectedUsable = choices.some((c) => c.wallet.id === selectedId && c.capability === 'yes');
  const offerRemember = selectedId !== null && selectedId !== shopWallet;

  const confirm = useCallback(async () => {
    if (!selectedId || !selectedUsable || submitting) return;
    setSubmitting(true);
    try {
      await onConfirm(selectedId, offerRemember && remember);
      onClose();
    } catch {
      // Surfaced via `error`.
    } finally {
      setSubmitting(false);
    }
  }, [selectedId, selectedUsable, submitting, onConfirm, offerRemember, remember, onClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        pressBehavior={submitting ? 'none' : 'close'}
      />
    ),
    [submitting],
  );

  return (
    <BottomSheetModal
      ref={sheetRef}
      enablePanDownToClose={!submitting}
      enableDynamicSizing
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handle}
      onDismiss={onClose}
    >
      <BottomSheetScrollView contentContainerStyle={styles.container} testID="seller-invoice-sheet">
        <Text style={styles.title}>{t('sellerOrders.sendInvoice')}</Text>
        <Text style={styles.subtitle}>
          {t('sellerOrders.orderNumber', { id: shortOrderId(orderId) })}
        </Text>

        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>{t('sellerOrders.total')}</Text>
          <View style={styles.totalValue}>
            <Text style={styles.totalSats} testID="seller-invoice-total">
              {t('market.sats', { amount: totalSats.toLocaleString(formatLocale) })}
            </Text>
            {fiatTotal ? (
              <Text style={styles.totalFiat}>
                {t('sellerOrders.fiatAtRate', {
                  amount: formatMarketAmount(fiatTotal.amount, fiatTotal.currency),
                  currency: fiatTotal.currency,
                })}
              </Text>
            ) : null}
          </View>
        </View>
        {buyerAmountSats !== null && buyerAmountSats !== totalSats ? (
          <Text style={styles.warning} testID="seller-invoice-mismatch">
            {t('sellerOrders.amountDiffers', {
              buyer: buyerAmountSats.toLocaleString(formatLocale),
            })}
          </Text>
        ) : null}

        <InvoiceWalletPicker
          choices={choices}
          selectedId={selectedId}
          onSelect={setSelectedId}
          testIDPrefix="seller-invoice-wallet"
          disabled={submitting}
        />

        {offerRemember ? (
          <TouchableOpacity
            style={styles.remember}
            onPress={() => setRemember((r) => !r)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: remember }}
            accessibilityLabel={t('sellerOrders.wallet.remember')}
            testID="seller-invoice-remember"
          >
            <View style={[styles.checkbox, remember && styles.checkboxOn]}>
              {remember ? <Check size={14} color={colors.white} strokeWidth={3} /> : null}
            </View>
            <Text style={styles.rememberText}>{t('sellerOrders.wallet.remember')}</Text>
          </TouchableOpacity>
        ) : null}

        <TouchableOpacity
          style={[
            styles.primaryButton,
            (!selectedUsable || submitting) && styles.primaryButtonDisabled,
          ]}
          onPress={confirm}
          disabled={!selectedUsable || submitting}
          accessibilityRole="button"
          accessibilityState={{ disabled: !selectedUsable || submitting, busy: submitting }}
          accessibilityLabel={t('sellerOrders.confirmSend')}
          testID="seller-invoice-confirm"
        >
          {submitting ? (
            <BrandedSpinner size="small" onGradient />
          ) : (
            <>
              <Zap size={16} color={colors.white} strokeWidth={2.5} fill={colors.white} />
              <Text style={styles.primaryButtonText}>
                {selectedId ? t('sellerOrders.confirmSend') : t('sellerOrders.wallet.choose')}
              </Text>
            </>
          )}
        </TouchableOpacity>
        {error ? (
          <Text style={styles.errorText} testID="seller-invoice-error">
            {error}
          </Text>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}

export default SellerInvoiceSheet;
