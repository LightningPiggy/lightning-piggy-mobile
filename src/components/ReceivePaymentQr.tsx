import BrandedSpinner from './BrandedSpinner';
import React from 'react';
import { View, Text } from 'react-native';
import { Check } from 'lucide-react-native';
import ScannableQr from './ScannableQr';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { createReceiveSheetStyles } from '../styles/ReceiveSheet.styles';

interface Props {
  styles: Pick<
    ReturnType<typeof createReceiveSheetStyles>,
    'qrContainer' | 'qrContainerShowingQr' | 'checkmark' | 'checkmarkText' | 'noInvoice'
  >;
  isOnchainWallet: boolean;
  onchainAddress: string | null;
  onchainUri: string;
  mode: 'address' | 'amount';
  currentSats: number;
  lightningAddress: string | null;
  invoice: string;
  paymentReceived: boolean;
  loading: boolean;
}

export default function ReceivePaymentQr({
  styles,
  isOnchainWallet,
  onchainAddress,
  onchainUri,
  mode,
  currentSats,
  lightningAddress,
  invoice,
  paymentReceived,
  loading,
}: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const showsOnchainQr =
    isOnchainWallet && !!onchainAddress && (mode === 'address' || currentSats > 0);
  // Mirrors the branches below: the card turns white only while one of them draws a QR.
  const awaitingOnchainAmount = isOnchainWallet && mode === 'amount' && currentSats === 0;
  const showsQr =
    showsOnchainQr ||
    (mode === 'address' && !!lightningAddress) ||
    (mode === 'amount' && !awaitingOnchainAmount && !loading && !!invoice);
  return (
    <View
      style={[styles.qrContainer, showsQr && styles.qrContainerShowingQr]}
      accessible={
        isOnchainWallet
          ? !!onchainAddress && (mode === 'address' || currentSats > 0)
          : mode === 'address'
            ? !!lightningAddress
            : !!invoice
      }
      accessibilityRole="image"
      accessibilityLabel={t('receiveSheet.paymentQr')}
      testID="receive-payment-qr"
    >
      {isOnchainWallet && onchainAddress && (mode === 'address' || currentSats > 0) ? (
        <View>
          <ScannableQr value={onchainUri} size={200} />
          {paymentReceived && (
            <View style={styles.checkmark}>
              <Text style={styles.checkmarkText}>{'\u2713'}</Text>
            </View>
          )}
        </View>
      ) : isOnchainWallet && mode === 'amount' && currentSats === 0 ? (
        <Text style={styles.noInvoice}>{t('receiveSheet.enterAmountForQr')}</Text>
      ) : mode === 'address' && lightningAddress ? (
        <View>
          <ScannableQr value={`lightning:${lightningAddress}`} size={200} />
          {paymentReceived && (
            <View style={styles.checkmark}>
              <Check size={28} color={colors.white} />
            </View>
          )}
        </View>
      ) : mode === 'amount' && loading ? (
        <BrandedSpinner size="large" />
      ) : mode === 'amount' && invoice ? (
        <View>
          <ScannableQr value={invoice} size={200} />
          {paymentReceived && (
            <View style={styles.checkmark}>
              <Check size={28} color={colors.white} />
            </View>
          )}
        </View>
      ) : (
        <Text style={styles.noInvoice}>
          {mode === 'address'
            ? t('receiveSheet.noLightningAddress')
            : t('receiveSheet.enterAmountForInvoice')}
        </Text>
      )}
    </View>
  );
}
