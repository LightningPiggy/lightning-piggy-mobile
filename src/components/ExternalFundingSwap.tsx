import { useExternalSwapHeight } from '../hooks/useExternalSwapHeight';
import { canPayExternalSwap } from '../utils/externalSwapPayment';
import { getSwapBackendForId } from '../services/swapBackendService';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Text, TouchableOpacity, View, FlatList } from 'react-native';
import { navigationRef } from '../navigation/AppNavigator';
import * as SecureStore from 'expo-secure-store';
import * as Clipboard from 'expo-clipboard';
import ScannableQr from './ScannableQr';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useWallet } from '../contexts/WalletContext';
import type { WalletMetadata } from '../types/wallet';
import { useTransferSwapFees } from '../utils/useTransferSwapFees';
import { quoteForwardSwap } from '../utils/forwardSwapQuote';
import {
  buildBoltzBip21Uri,
  classifySubmarineSwapStatus,
  isQuoteChangedError,
} from '../services/boltzService';
import { createRecoverableSubmarineSwap } from '../services/createRecoverableSubmarineSwap';
import {
  externalSwapState,
  loadExternalSwaps,
  type ExternalSwapState,
} from '../services/externalSwapState';
import { subscribeExternalSwap, type ExternalSwapUpdate } from '../services/externalSwapTracking';
import { getActivePubkey } from '../services/walletStorageService';
import { recordSubmarineSwapLegs } from '../services/swapRecoveryService';
import { buildSwapPlaceholders, markSwapPlaceholdersResolved } from '../utils/swapPendingMerge';
import * as lnurlService from '../services/lnurlService';
import { createExternalFundingSwapStyles } from '../styles/ExternalFundingSwap.styles';
import AmountEntryScreen from './AmountEntryScreen';
import Toast from './BrandedToast';

/** Creates funding instructions; this component never signs or sends funds. */
export default function ExternalFundingSwap({
  sourceId,
  dest,
  crossProfile,
  onClose,
}: {
  sourceId: string;
  dest: WalletMetadata | null;
  crossProfile: boolean;
  onClose: () => void;
}) {
  const { t, formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createExternalFundingSwapStyles(colors), [colors]);
  const wallet = useWallet();
  const quote = useTransferSwapFees('onchain-to-ln', true);
  const [amount, setAmount] = useState(0);
  const [enteringAmount, setEnteringAmount] = useState(false);
  const [swap, setSwap] = useState<ExternalSwapState | null>(null);
  const [tracking, setTracking] = useState<ExternalSwapUpdate | null>(null);
  const [history, setHistory] = useState<ExternalSwapState[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const owner = getActivePubkey() ?? undefined;
  const destinationId = dest?.id;

  useEffect(() => {
    let active = true;
    mounted.current = true;
    if (!destinationId) {
      setBusy(false);
      return;
    }
    void loadExternalSwaps(sourceId, destinationId)
      .then((saved) => {
        if (active) {
          setSwap(saved[0] ?? null);
          setHistory(saved);
        }
      })
      .catch(() => {
        if (active) setError(t('externalSwap.loadError'));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [sourceId, destinationId, t]);

  useEffect(() => {
    if (!swap) return;
    return subscribeExternalSwap(swap.id, (update) => {
      setTracking(update);
      if (update.trackingFailed) setError(t('externalSwap.trackingError'));
      if (!update.status) return;
      const next = { ...swap, status: update.status };
      setSwap(next);
      setHistory((previous) => previous.map((item) => (item.id === next.id ? next : item)));
      const txId = update.raw?.transaction?.id;
      if (typeof txId === 'string') {
        void recordSubmarineSwapLegs(txId, swap.invoice, swap.id).catch(() => {});
      }
      const phase = classifySubmarineSwapStatus(update.status);
      if (phase === 'complete' || phase === 'failed') {
        markSwapPlaceholdersResolved(swap.id);
        void wallet.fetchTransactionsForWallet(swap.destinationWalletId).catch(() => {});
      }
    });
    // Status updates must not tear down and restart the same subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swap?.id, t]);

  const create = async () => {
    if (
      inFlight.current ||
      busy ||
      !dest ||
      !quote.fees ||
      amount < quote.fees.minAmount ||
      amount > quote.fees.maxAmount
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      let invoice: string;
      if (crossProfile) {
        if (!dest.lightningAddress) throw new Error(t('externalSwap.noAddress'));
        const params = await lnurlService.resolveLightningAddress(dest.lightningAddress);
        if (amount < params.minSats || amount > params.maxSats)
          throw new Error(t('externalSwap.invoiceRange'));
        invoice = await lnurlService.fetchInvoice(params.callback, amount);
      } else {
        invoice = await wallet.makeInvoiceForWallet(dest.id, amount, t('externalSwap.title'));
      }
      if (owner !== (getActivePubkey() ?? undefined)) throw new Error('Identity changed');
      const created = await createRecoverableSubmarineSwap(
        invoice,
        amount,
        sourceId,
        quote.fees,
        dest.id,
      );
      const state = externalSwapState(created, sourceId, dest.id, amount, invoice, owner);
      if (mounted.current) {
        setSwap(state);
        setHistory((prev) => [state, ...prev]);
      }
      void recordSubmarineSwapLegs(undefined, invoice, created.id).catch(() => {});
      if (!crossProfile) {
        const { incoming } = buildSwapPlaceholders({
          swapId: created.id,
          swapType: 'submarine',
          sentSats: created.expectedAmount,
          receivedSats: amount,
          nowSeconds: Math.floor(Date.now() / 1000),
        });
        wallet.addPendingTransaction(dest.id, incoming);
      }
    } catch (e) {
      if (mounted.current) {
        if (isQuoteChangedError(e)) quote.adopt(e.quote);
        setError(t('externalSwap.createError'));
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const copy = async (value: string) => {
    try {
      await Clipboard.setStringAsync(value);
      Toast.show({ type: 'success', text1: t('externalSwap.copied') });
    } catch {
      setError(t('externalSwap.copyError'));
    }
  };
  const button = (id: string, label: string, action: () => void, disabled = false) => (
    <TouchableOpacity
      testID={id}
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={disabled}
      style={[styles.button, disabled && styles.disabled]}
      onPress={action}
    >
      <Text style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
  const height = useExternalSwapHeight(swap?.id);
  if (enteringAmount)
    return (
      <AmountEntryScreen
        initialSats={amount}
        title={t('externalSwap.title')}
        minSats={quote.fees?.minAmount}
        maxSats={quote.fees?.maxAmount}
        onBack={() => setEnteringAmount(false)}
        onConfirm={(sats) => {
          setAmount(sats);
          setEnteringAmount(false);
        }}
      />
    );
  const expired = !!swap && height !== null && height >= swap.timeoutBlockHeight;
  const phase = swap ? classifySubmarineSwapStatus(swap.status) : null;
  const awaiting =
    !!swap &&
    canPayExternalSwap(
      swap.status,
      height,
      swap.timeoutBlockHeight,
      tracking?.id === swap.id && !tracking.trackingFailed ? tracking.status : null,
    );
  const fee = quote.fees && amount > 0 ? quoteForwardSwap(amount, quote.fees, null) : null;
  return (
    <View style={styles.container} testID="external-swap-flow">
      <Text style={styles.title}>{t('externalSwap.title')}</Text>
      <Text style={styles.text}>{t('externalSwap.explanation')}</Text>
      {swap ? (
        <View style={styles.container} testID="external-swap-payment">
          <Text style={styles.text} testID="external-swap-status">
            {t(
              `externalSwap.${phase === 'complete' ? 'complete' : phase === 'failed' || expired ? 'failed' : phase === 'awaiting-payment' ? 'waiting' : 'confirming'}`,
            )}
          </Text>
          {awaiting && (
            <>
              <View style={styles.qr} testID="external-swap-qr">
                <ScannableQr
                  value={buildBoltzBip21Uri(swap.address, swap.expectedAmount)}
                  size={200}
                />
              </View>
              <Text style={styles.amount} testID="external-swap-exact-amount">
                {t('externalSwap.exactAmount', {
                  amount: swap.expectedAmount.toLocaleString(formatLocale),
                })}
              </Text>
              <Text selectable style={styles.text} testID="external-swap-address">
                {swap.address}
              </Text>
              {button(
                'external-swap-copy-address',
                t('externalSwap.copyAddress'),
                () => void copy(swap.address),
              )}
              {button(
                'external-swap-copy-amount',
                t('externalSwap.copyAmount'),
                () => void copy(String(swap.expectedAmount)),
              )}
              {button(
                'external-swap-copy-bip21',
                t('externalSwap.copyPayment'),
                () => void copy(buildBoltzBip21Uri(swap.address, swap.expectedAmount)),
              )}
            </>
          )}
          <Text style={styles.text}>
            {t('externalSwap.timeout', { height: String(swap.timeoutBlockHeight) })}
          </Text>
          <Text style={styles.text}>{t('externalSwap.refund')}</Text>
          {(phase === 'failed' || expired) &&
            button('external-swap-refund-details', t('externalSwap.refundDetails'), () => {
              void SecureStore.getItemAsync(`submarine_swap_${swap.id}`)
                .then(async (raw) => {
                  if (!raw) {
                    setError(t('externalSwap.loadError'));
                    return;
                  }
                  const recovery = JSON.parse(raw);
                  if (recovery.ownerPubkey !== (getActivePubkey() ?? undefined)) return;
                  return copy(
                    JSON.stringify({
                      id: recovery.id,
                      currency: 'BTC',
                      backend: await getSwapBackendForId(swap.id),
                      privateKey: recovery.refundPrivateKey,
                      claimPublicKey: recovery.claimPublicKey,
                      swapTree: recovery.swapTree,
                      timeoutBlockHeight: recovery.timeoutBlockHeight,
                      address: recovery.address,
                      expectedAmount: recovery.expectedAmount,
                    }),
                  );
                })
                .catch(() => setError(t('externalSwap.copyError')));
            })}
          {(phase === 'complete' || phase === 'failed') &&
            button('external-swap-new', t('externalSwap.newSwap'), () => {
              setSwap(null);
              setAmount(0);
            })}
          {button('external-swap-close', t('externalSwap.close'), onClose)}
        </View>
      ) : (
        <>
          {quote.loading && (
            <Text testID="external-swap-quote-loading" style={styles.text}>
              {t('swapBackend.loadingQuote')}
            </Text>
          )}
          {quote.failed && (
            <>
              <Text style={styles.text} testID="transfer-swap-quote-error">
                {t(quote.errorKey)}
              </Text>
              {quote.errorKey === 'swapBackend.notConfigured'
                ? button('external-swap-settings', t('externalSwap.settings'), () => {
                    onClose();
                    navigationRef.navigate('Main', { screen: 'AccountOnChain' });
                  })
                : button('external-swap-retry', t('swapBackend.retryQuote'), quote.retry)}
            </>
          )}
          {button(
            'external-swap-amount',
            amount ? `${amount.toLocaleString(formatLocale)} sats` : t('externalSwap.amount'),
            () => setEnteringAmount(true),
            busy || !quote.fees,
          )}
          {fee && (
            <Text style={styles.text}>
              {t('externalSwap.fee', {
                fee: fee.boltzFeeSats.toLocaleString(formatLocale),
                total: fee.lockupSats.toLocaleString(formatLocale),
              })}
            </Text>
          )}
          {crossProfile && !dest?.lightningAddress && (
            <Text style={styles.text}>{t('externalSwap.noAddress')}</Text>
          )}
          {button(
            'external-swap-create',
            t('externalSwap.create'),
            () => void create(),
            busy ||
              !quote.fees ||
              !dest ||
              amount < (quote.fees?.minAmount ?? 1) ||
              amount > (quote.fees?.maxAmount ?? 0) ||
              (crossProfile && !dest.lightningAddress),
          )}
        </>
      )}
      {history.length > 1 && (
        <FlatList
          style={styles.history}
          data={history}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <SwapHistoryRow item={item} onSelect={setSwap} />}
        />
      )}
      {!!error && (
        <Text style={styles.text} accessibilityLiveRegion="polite">
          {error}
        </Text>
      )}
    </View>
  );
}

const SwapHistoryRow = React.memo(function SwapHistoryRow({
  item,
  onSelect,
}: {
  item: ExternalSwapState;
  onSelect: (swap: ExternalSwapState) => void;
}) {
  const { t, formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createExternalFundingSwapStyles(colors), [colors]);
  return (
    <TouchableOpacity
      testID={`external-swap-history-${item.id}`}
      accessibilityRole="button"
      style={styles.button}
      onPress={() => onSelect(item)}
    >
      <Text style={styles.text}>
        {t('externalSwap.title')} · {item.invoiceSats.toLocaleString(formatLocale)} sats · {item.id}
      </Text>
    </TouchableOpacity>
  );
});
