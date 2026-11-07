import React, { useMemo, useState } from 'react';
import { Text, TextInput, View } from 'react-native';
import ArkButton, { confirmArk, showArkError } from './ArkButton';
import { Toast } from '../BrandedToast';
import { useTranslation } from '../../contexts/LocaleContext';
import { quoteArkSend, sendArkPayment } from '../../services/arkPayments';
import { parseArkDestination, parseSatsInput } from '../../utils/arkDestination';
import { formatSatsNumber } from '../../utils/marketPrice';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

interface Props {
  styles: ArkWalletStyles;
  spendableSats: number;
  onSent: () => void;
}

/**
 * Send from Ark to an Ark address (instant, off-chain), a Lightning invoice /
 * address / LNURL (through the Ark server's Lightning gateway), or an
 * on-chain address (leaves in the next round).
 */
export default function ArkSendPanel({ styles, spendableSats, onSent }: Props) {
  const t = useTranslation();
  const [destText, setDestText] = useState('');
  const [amountText, setAmountText] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const dest = useMemo(() => parseArkDestination(destText), [destText]);
  const fixedAmount = dest?.amountSats ?? null;
  const amount = fixedAmount ?? parseSatsInput(amountText);
  const takesComment = dest?.kind === 'lightningAddress' || dest?.kind === 'lnurl';
  const sats = (n: number) => t('arkWallet.satsAmount', { amount: formatSatsNumber(n) });

  const review = async () => {
    if (!dest || !amount) return;
    setBusy(true);
    try {
      const quote = await quoteArkSend(dest, amount);
      if (quote.totalSats > spendableSats) {
        showArkError(t('arkWallet.sendFailed'), new Error(t('arkWallet.notEnough')));
        return;
      }
      const ok = await confirmArk(
        t('arkWallet.confirmSendTitle'),
        t('arkWallet.confirmSendBody', {
          amount: sats(amount),
          fee: sats(quote.feeSats),
          kind: t(`arkWallet.destKind.${dest.kind}`),
        }),
        t('arkWallet.send'),
        t('arkWallet.cancel'),
      );
      if (!ok) return;
      const outcome = await sendArkPayment(dest, amount, takesComment ? comment : undefined);
      Toast.show({
        type: 'success',
        text1: outcome === 'paid' ? t('arkWallet.sent') : t('arkWallet.sendPending'),
      });
      setDestText('');
      setAmountText('');
      setComment('');
      onSent();
    } catch (err) {
      showArkError(t('arkWallet.sendFailed'), err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card} testID="ark-send-panel">
      <TextInput
        style={styles.input}
        value={destText}
        onChangeText={setDestText}
        placeholder={t('arkWallet.destPlaceholder')}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
        testID="ark-send-destination"
        accessibilityLabel={t('arkWallet.destPlaceholder')}
      />
      {destText.trim().length > 0 && (
        <Text style={styles.hint} testID="ark-send-kind">
          {dest ? t(`arkWallet.destKind.${dest.kind}`) : t('arkWallet.destUnknown')}
        </Text>
      )}
      {fixedAmount === null ? (
        <TextInput
          style={styles.input}
          value={amountText}
          onChangeText={setAmountText}
          placeholder={t('arkWallet.amountPlaceholder')}
          keyboardType="number-pad"
          testID="ark-send-amount"
          accessibilityLabel={t('arkWallet.amountPlaceholder')}
        />
      ) : (
        <Text style={styles.body}>{sats(fixedAmount)}</Text>
      )}
      {takesComment && (
        <TextInput
          style={styles.input}
          value={comment}
          onChangeText={setComment}
          placeholder={t('arkWallet.commentPlaceholder')}
          maxLength={140}
          testID="ark-send-comment"
          accessibilityLabel={t('arkWallet.commentPlaceholder')}
        />
      )}
      <ArkButton
        styles={styles}
        label={t('arkWallet.review')}
        onPress={review}
        busy={busy}
        disabled={!dest || !amount}
        testID="ark-send-review"
      />
    </View>
  );
}
