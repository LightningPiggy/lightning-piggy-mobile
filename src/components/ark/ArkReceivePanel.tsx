import React, { useEffect, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import ArkButton, { showArkError } from './ArkButton';
import { Toast } from '../BrandedToast';
import { useTranslation } from '../../contexts/LocaleContext';
import { createArkInvoice, isArkInvoicePaid, type ArkInvoice } from '../../services/arkPayments';
import { parseSatsInput } from '../../utils/arkDestination';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

const INVOICE_POLL_MS = 3_000;

interface Props {
  styles: ArkWalletStyles;
  arkAddress: string;
  onReceived: () => void;
}

/** Receive into Ark: the reusable Ark address, or a Lightning invoice for an amount. */
export default function ArkReceivePanel({ styles, arkAddress, onReceived }: Props) {
  const t = useTranslation();
  const [mode, setMode] = useState<'ark' | 'lightning'>('ark');
  const [amountText, setAmountText] = useState('');
  const [invoice, setInvoice] = useState<ArkInvoice | null>(null);
  const [paid, setPaid] = useState(false);
  const [busy, setBusy] = useState(false);

  // Watch the open invoice while this panel is mounted (the screen is focused).
  useEffect(() => {
    if (!invoice || paid) return;
    let cancelled = false;
    const id = setInterval(() => {
      isArkInvoicePaid(invoice.paymentHash)
        .then((done) => {
          if (!done || cancelled) return;
          setPaid(true);
          onReceived();
        })
        .catch(() => {});
    }, INVOICE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [invoice, paid, onReceived]);

  const copy = async (value: string) => {
    await Clipboard.setStringAsync(value);
    Toast.show({ type: 'success', text1: t('arkWallet.copied') });
  };

  const makeInvoice = async () => {
    const sats = parseSatsInput(amountText);
    if (!sats) return;
    setBusy(true);
    setPaid(false);
    try {
      setInvoice(await createArkInvoice(sats));
    } catch (err) {
      showArkError(t('arkWallet.invoiceFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  const shown = mode === 'ark' ? arkAddress : (invoice?.invoice ?? null);

  return (
    <View style={styles.card} testID="ark-receive-panel">
      <View style={styles.tabs}>
        {(['ark', 'lightning'] as const).map((m) => (
          <ArkButton
            key={m}
            styles={styles}
            label={t(`arkWallet.receiveMode.${m}`)}
            onPress={() => setMode(m)}
            variant={mode === m ? 'primary' : 'secondary'}
            testID={`ark-receive-mode-${m}`}
          />
        ))}
      </View>
      <Text style={styles.hint}>{t(`arkWallet.receiveHint.${mode}`)}</Text>
      {mode === 'lightning' && (
        <>
          <TextInput
            style={styles.input}
            value={amountText}
            onChangeText={(v) => {
              setAmountText(v);
              setInvoice(null);
            }}
            placeholder={t('arkWallet.amountPlaceholder')}
            keyboardType="number-pad"
            testID="ark-invoice-amount"
            accessibilityLabel={t('arkWallet.amountPlaceholder')}
          />
          <ArkButton
            styles={styles}
            label={t('arkWallet.createInvoice')}
            onPress={makeInvoice}
            busy={busy}
            disabled={!parseSatsInput(amountText)}
            testID="ark-create-invoice"
          />
        </>
      )}
      {shown && (
        <>
          <View
            style={styles.qr}
            accessible
            accessibilityRole="image"
            accessibilityLabel={t('arkWallet.qrLabel')}
            testID="ark-receive-qr"
          >
            <QRCode value={shown} size={200} />
          </View>
          {paid && <Text style={styles.healthOk}>{t('arkWallet.invoicePaid')}</Text>}
          <Text style={styles.mono} selectable numberOfLines={3} testID="ark-receive-value">
            {shown}
          </Text>
          <ArkButton
            styles={styles}
            label={t('arkWallet.copy')}
            onPress={() => void copy(shown)}
            variant="secondary"
            testID="ark-receive-copy"
          />
        </>
      )}
    </View>
  );
}
