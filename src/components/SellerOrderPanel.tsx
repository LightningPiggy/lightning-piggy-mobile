import FiatAmount from './FiatAmount';
import { buyerOrderNote, orderAddressLines } from '../utils/orderPresentation';
import { OrderItemImage } from './OrderItemThumbnails';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Check, RefreshCw, Zap } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { useSellerOrderQuote } from '../hooks/useSellerOrderQuote';
import { SellerInvoiceError, useSellerInvoice } from '../hooks/useSellerInvoice';
import { createSellerOrderPanelStyles } from '../styles/SellerOrderPanel.styles';
import { formatMarketAmount } from '../utils/marketListingShipping';
import { localizeDeliveryAddress } from '../utils/deliveryAddress';
import { orderOwnership } from '../utils/sellerOrderQuote';
import { expiresAtFromBolt11, paymentHashFromBolt11 } from '../utils/bolt11';
import {
  receiptProvesPayment,
  shopOrderStatus,
  sellerRecordIsCurrent,
  type SellerOrderThread,
} from '../utils/shopOrderStatus';
import type { ParsedOrderEvent } from '../utils/orderEvents';
import OrderStatusChip from './OrderStatusChip';
import SellerInvoiceSheet from './SellerInvoiceSheet';
import { Alert } from './BrandedAlert';
import { Toast } from './BrandedToast';

interface Props {
  /** The buyer's kind-16 type-1 order. */
  order: ParsedOrderEvent;
  /** What I've done about it so far (from the conversation's order rows). */
  thread?: SellerOrderThread;
  /** The buyer (this conversation's peer). */
  buyerPubkey: string;
  /** Unique suffix for testIDs. */
  id: string;
}

const CONFIRMED = new Set(['confirmed', 'processing', 'completed']);

/**
 * The seller's side of an incoming Gamma order, shown in the order card when
 * every item is one of MY listings (anything else renders nothing — not mine
 * to invoice). Items, shipping and the total are priced from my OWN current
 * listing / shipping events (useSellerOrderQuote); the buyer's stated amount
 * must match the computed total before invoicing. Then: Send invoice (on a wallet I pick)
 * → wait for payment on THAT wallet → Mark paid.
 */
function SellerOrderPanel({ order, thread, buyerPubkey, id }: Props): React.ReactElement | null {
  const colors = useThemeColors();
  const { t, locale, formatLocale } = useLocale();
  const styles = useMemo(() => createSellerOrderPanelStyles(colors), [colors]);
  const { pubkey } = useNostr();
  const mine = pubkey ? orderOwnership(order, pubkey) === 'mine' : false;
  const { quote, quoteCurrent, loading } = useSellerOrderQuote(mine ? order : null);
  const invoice = useSellerInvoice(
    mine ? buyerPubkey : null,
    mine ? order.orderId : null,
    thread?.invoice?.bolt11,
    thread?.invoice?.at,
  );
  const [sheetVisible, setSheetVisible] = useState(false);
  const [allowUnknownInvoice, setAllowUnknownInvoice] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);

  const errorText = useCallback(
    (e: unknown) =>
      t(`sellerOrders.errors.${e instanceof SellerInvoiceError ? e.code : 'sendFailed'}`),
    [t],
  );
  const onConfirm = useCallback(
    async (walletId: string, remember: boolean) => {
      setError(null);
      try {
        const current = quoteCurrent();
        if (current?.totalSats == null || current.totalSats !== quote?.totalSats) {
          throw new SellerInvoiceError('shopChanged', 'Shop pricing changed; review the order');
        }
        if (current.totalSats !== order.amountSats) {
          throw new SellerInvoiceError('amountMismatch', 'Buyer has not approved this total');
        }
        await invoice.sendInvoice({
          walletId,
          amountSats: current.totalSats,
          remember,
          allowUnknownInvoice,
        });
        Toast.show({ type: 'success', text1: t('sellerOrders.invoiceSent') });
      } catch (e) {
        setError(errorText(e));
        throw e;
      }
    },
    [invoice, allowUnknownInvoice, order.amountSats, quote?.totalSats, quoteCurrent, t, errorText],
  );
  const onMarkPaid = useCallback(async () => {
    try {
      await invoice.markPaid();
      Toast.show({ type: 'success', text1: t('sellerOrders.buyerNotified') });
    } catch (e) {
      Toast.show({ type: 'error', text1: errorText(e) });
    }
  }, [invoice, t, errorText]);
  const onCheckPaid = useCallback(async () => {
    try {
      const paid = await invoice.checkPaid();
      if (paid !== true)
        Toast.show({
          type: 'info',
          text1: t(
            paid === false ? 'sellerOrders.notPaidYet' : 'sellerOrders.couldNotConfirmPayment',
          ),
        });
    } catch (e) {
      Toast.show({ type: 'error', text1: errorText(e) });
    }
  }, [invoice, t, errorText]);

  const recordCurrent = sellerRecordIsCurrent(invoice.record, thread?.invoice);
  const expiresAt =
    recordCurrent && invoice.record
      ? (expiresAtFromBolt11(invoice.record.bolt11) ??
        (invoice.record.bolt11 === thread?.invoice?.bolt11 ? thread.invoice.expiresAt : null))
      : (thread?.invoice?.expiresAt ?? null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (expiresAt === null || expiresAt * 1000 <= Date.now()) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.min(expiresAt * 1000 - Date.now(), 2_147_483_647),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  if (!mine) return null;
  if (!quote || (loading && quote.problem === 'missingListing')) {
    return (
      <View style={styles.container}>
        <Text style={styles.muted}>{t('sellerOrders.loadingShop')}</Text>
      </View>
    );
  }

  // Which invoice to watch: the one I recorded on this device for this order.
  const record = invoice.record;
  const invoiceHash = recordCurrent
    ? (record?.paymentHash ?? null)
    : thread?.invoice
      ? paymentHashFromBolt11(thread.invoice.bolt11)
      : null;
  const effectiveBolt11 = recordCurrent
    ? (record?.bolt11 ?? null)
    : (thread?.invoice?.bolt11 ?? null);
  const receiptVerified = thread
    ? receiptProvesPayment(thread, invoiceHash, effectiveBolt11)
    : false;
  const walletPaid = Boolean(record?.paidAt);
  const status = shopOrderStatus(thread, {
    walletPaid,
    receiptVerified,
    nowMs: now,
    invoiceRecord: record ?? undefined,
  });
  const confirmedSent =
    Boolean(record?.confirmedAt) || (thread?.status !== undefined && CONFIRMED.has(thread.status));
  const canReplace =
    status === 'invoiceExpired' &&
    Boolean(
      record?.walletId &&
      record.paymentHash &&
      (invoice.unpaidInvoice === record.bolt11 || invoice.unknownInvoice === record.bolt11),
    ) &&
    recordCurrent;
  const canRetry =
    status === 'invoiceSent' &&
    Boolean(record?.deliveryPending) &&
    !record?.paidAt &&
    !confirmedSent &&
    recordCurrent &&
    (expiresAt === null || expiresAt * 1000 > now);
  const busy = invoice.sending;
  const invoiceBlocked = quote.totalSats === null || quote.totalSats !== order.amountSats || busy;
  const note = [buyerOrderNote(order.message), order.notes?.trim()].filter(Boolean).join('\n\n');
  const sats = (n: number) => t('market.sats', { amount: n.toLocaleString(formatLocale) });

  return (
    <View style={styles.container} testID={`seller-order-panel-${id}`}>
      <View style={styles.headerRow}>
        <Text style={styles.heading}>{t('sellerOrders.yourShopOrder')}</Text>
        <OrderStatusChip status={status} testID={`seller-order-status-${id}`} />
      </View>

      {quote.problem && quote.problem !== 'noRate' ? (
        <Text style={styles.warning} testID={`seller-order-problem-${id}`}>
          {t(`sellerOrders.problems.${quote.problem}`)}
        </Text>
      ) : null}

      {quote.lines.map((line) => (
        <View key={line.ref}>
          <View style={styles.lineRow}>
            <OrderItemImage item={line} large />
            <View style={styles.lineText}>
              <Text style={styles.lineTitle} numberOfLines={2}>
                {line.title}
              </Text>
              <Text style={styles.lineSub}>
                {t('sellerOrders.unitPrice', {
                  amount: formatMarketAmount(line.unitAmount, line.currency),
                  currency: line.currency === 'SATS' ? 'sats' : line.currency,
                })}
              </Text>
            </View>
            <View style={styles.lineValues}>
              <Text style={styles.lineSub}>× {line.quantity}</Text>
              <Text style={styles.lineAmount}>
                {line.lineSats !== null ? sats(line.lineSats) : '—'}
              </Text>
            </View>
          </View>
          {line.overStock ? (
            <Text style={styles.warning}>
              {t('sellerOrders.overStock', { stock: line.stock ?? 0 })}
            </Text>
          ) : null}
        </View>
      ))}

      <View style={styles.divider} />
      {quote.shipping ? (
        <View style={styles.lineRow}>
          <Text style={styles.lineTitle}>
            {t('sellerOrders.shippingLine', { title: quote.shipping.title })}
          </Text>
          <Text style={styles.lineAmount}>
            {quote.shipping.sats === null
              ? '—'
              : quote.shipping.sats === 0
                ? t('market.free')
                : sats(quote.shipping.sats)}
          </Text>
        </View>
      ) : null}
      {quote.shipping?.notOffered ? (
        <Text style={styles.warning}>{t('sellerOrders.shippingNotOffered')}</Text>
      ) : null}
      {quote.shippingMissing ? (
        <Text style={styles.warning}>{t('sellerOrders.shippingMissing')}</Text>
      ) : null}

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>{t('sellerOrders.total')}</Text>
        <View style={styles.totalValue}>
          <Text style={styles.totalSats} testID={`seller-order-total-${id}`}>
            {quote.totalSats !== null
              ? sats(quote.totalSats)
              : quote.problem === 'noRate'
                ? t('sellerOrders.waitingForRate')
                : '—'}
          </Text>
          {quote.fiatTotal ? (
            <Text style={styles.totalFiat}>
              {t('sellerOrders.fiatAtRate', {
                amount: formatMarketAmount(quote.fiatTotal.amount, quote.fiatTotal.currency),
                currency: quote.fiatTotal.currency,
              })}
            </Text>
          ) : (
            <FiatAmount sats={quote.totalSats} testID={`seller-order-fiat-${id}`} />
          )}
        </View>
      </View>
      {quote.amountMismatch && quote.buyerAmountSats !== null ? (
        <Text style={styles.warning} testID={`seller-order-mismatch-${id}`}>
          {t('sellerOrders.amountDiffers', {
            buyer: quote.buyerAmountSats.toLocaleString(formatLocale),
          })}
        </Text>
      ) : null}

      {order.address ? (
        <View style={styles.section}>
          <Text style={styles.detailLabel}>{t('sellerOrders.shipTo')}</Text>
          <Text style={styles.detail} selectable testID={`seller-order-address-${id}`}>
            {localizeDeliveryAddress(orderAddressLines(order.address).join('\n'), locale)}
          </Text>
        </View>
      ) : null}
      {order.email || order.phone || order.contact ? (
        <View style={styles.section}>
          <Text style={styles.detailLabel}>{t('sellerOrders.contact')}</Text>
          <Text style={styles.detail} selectable>
            {[order.email, order.phone, order.contact].filter(Boolean).join(' · ')}
          </Text>
        </View>
      ) : null}
      {note ? (
        <View style={styles.section}>
          <Text style={styles.detailLabel}>{t('sellerOrders.buyerNote')}</Text>
          <Text style={styles.detail} selectable>
            {note}
          </Text>
        </View>
      ) : null}
      {thread?.receipt && !receiptVerified ? (
        <Text style={styles.muted}>{t('sellerOrders.receiptUnverified')}</Text>
      ) : null}

      <View style={styles.actions}>
        {status === 'needsInvoice' || canReplace || canRetry ? (
          <TouchableOpacity
            style={[styles.primaryButton, invoiceBlocked && styles.buttonDisabled]}
            onPress={() => {
              setError(null);
              setAllowUnknownInvoice(undefined);
              if (canReplace && invoice.unknownInvoice === record?.bolt11) {
                Alert.alert(
                  t('sellerOrders.checkWalletFirst'),
                  t('sellerOrders.unknownInvoiceWarning'),
                  [
                    { text: t('market.sell.cancel'), style: 'cancel' },
                    {
                      text: t('sellerOrders.sendNewInvoice'),
                      onPress: () => {
                        setAllowUnknownInvoice(record.bolt11);
                        setSheetVisible(true);
                      },
                    },
                  ],
                );
              } else setSheetVisible(true);
            }}
            disabled={invoiceBlocked}
            accessibilityRole="button"
            accessibilityLabel={t(
              canReplace ? 'sellerOrders.sendNewInvoice' : 'sellerOrders.sendInvoice',
            )}
            testID={`seller-order-send-invoice-${id}`}
          >
            <Zap size={14} color={colors.white} strokeWidth={2.5} fill={colors.white} />
            <Text style={styles.primaryButtonText}>
              {t(canReplace ? 'sellerOrders.sendNewInvoice' : 'sellerOrders.sendInvoice')}
            </Text>
          </TouchableOpacity>
        ) : null}
        {(status === 'invoiceSent' || status === 'invoiceExpired') && record ? (
          <TouchableOpacity
            style={[styles.secondaryButton, invoice.checking && styles.buttonDisabled]}
            onPress={onCheckPaid}
            disabled={invoice.checking}
            accessibilityRole="button"
            accessibilityLabel={t('sellerOrders.checkPayment')}
            testID={`seller-order-check-paid-${id}`}
          >
            <RefreshCw size={14} color={colors.brandPink} strokeWidth={2.5} />
            <Text style={styles.secondaryButtonText}>{t('sellerOrders.checkPayment')}</Text>
          </TouchableOpacity>
        ) : null}
        {status === 'invoiceSent' && !record ? (
          <Text style={styles.muted}>{t('sellerOrders.waitingForPayment')}</Text>
        ) : null}
        {status === 'paid' && !confirmedSent ? (
          <TouchableOpacity
            style={[styles.primaryButton, busy && styles.buttonDisabled]}
            onPress={onMarkPaid}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={t('sellerOrders.markPaid')}
            testID={`seller-order-mark-paid-${id}`}
          >
            <Check size={14} color={colors.white} strokeWidth={3} />
            <Text style={styles.primaryButtonText}>{t('sellerOrders.markPaid')}</Text>
          </TouchableOpacity>
        ) : null}
        {status === 'paid' && confirmedSent ? (
          <Text style={styles.muted}>{t('sellerOrders.buyerNotified')}</Text>
        ) : null}
      </View>

      {quote.totalSats !== null ? (
        <SellerInvoiceSheet
          visible={sheetVisible}
          onClose={() => setSheetVisible(false)}
          orderId={order.orderId}
          totalSats={quote.totalSats}
          fiatTotal={quote.fiatTotal}
          buyerAmountSats={quote.buyerAmountSats}
          onConfirm={onConfirm}
          error={error}
        />
      ) : null}
    </View>
  );
}

export default React.memo(SellerOrderPanel);
