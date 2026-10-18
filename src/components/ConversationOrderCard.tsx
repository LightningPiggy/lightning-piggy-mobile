import { useChatCardWidth } from '../styles/chatCardWidth';
import { buyerOrderNote } from '../utils/orderPresentation';
import { orderNavigationTarget } from '../utils/orderNavigation';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import FiatAmount from './FiatAmount';
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Clock } from 'lucide-react-native';
import OrderPaymentActions from './OrderPaymentActions';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createConversationOrderCardStyles } from '../styles/ConversationOrderCard.styles';
import type { Item } from '../utils/conversationItems';
import { formatTime } from '../utils/messageContent';
import { orderCardHeader, shortOrderId } from '../utils/orderEvents';

type OrderItem = Extract<Item, { kind: 'order' }>;

interface Props {
  item: OrderItem;
  /** The conversation's peer (hex) — the buyer, on an order I received. */
  peerPubkey?: string;
  /** 1:1 settlement predicate (NWC poll + wallet-tx history). */
  isInvoicePaid?: (paymentHash: string, fromMe: boolean) => boolean;
  onPayInvoice: (rawInvoice: string) => void;
}

/**
 * Marketplace order / receipt card (#market) — a Gamma Markets kind-16/17
 * rumor in a 1:1 NIP-17 thread. A structured, non-text Item the chat bubble
 * doesn't model (like the zap card). Lifted out of ConversationMessageRow so
 * the order lifecycle (waiting for the seller's invoice, pay, paid) lives in
 * one place.
 */
function ConversationOrderCard({
  item,
  peerPubkey,
  isInvoicePaid,
  onPayInvoice,
}: Props): React.ReactElement {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const colors = useThemeColors();
  const { formatLocale, t } = useLocale();
  const cardWidth = useChatCardWidth();
  const styles = useMemo(
    () => createConversationOrderCardStyles(colors, cardWidth),
    [colors, cardWidth],
  );
  const note = buyerOrderNote(item.order.message);
  const header = orderCardHeader(item.order.type);
  const totalItems = item.order.items.reduce((sum, i) => sum + i.quantity, 0);
  return (
    <View style={[styles.orderRow, item.fromMe ? styles.orderRowRight : styles.orderRowLeft]}>
      <View
        style={styles.orderCard}
        accessibilityLabel={`${header.label} for order ${shortOrderId(item.order.orderId)}`}
        testID={`conversation-order-${item.id}`}
      >
        <View style={styles.orderCardHeaderRow}>
          <Text style={styles.orderCardEmoji}>{header.emoji}</Text>
          <Text style={styles.orderCardLabel}>{header.label}</Text>
        </View>
        <Text style={styles.orderCardId}>Order #{shortOrderId(item.order.orderId)}</Text>
        {item.order.amountSats !== undefined ? (
          <Text style={styles.orderCardAmount}>
            {item.order.amountSats.toLocaleString(formatLocale)} sats
            <FiatAmount
              inline
              sats={item.order.amountSats}
              testID={`conversation-order-fiat-${item.id}`}
            />
          </Text>
        ) : null}
        {item.order.status ? (
          <Text style={styles.orderCardMeta}>Status: {item.order.status}</Text>
        ) : null}
        {item.order.tracking ? (
          <Text style={styles.orderCardMeta}>Tracking: {item.order.tracking}</Text>
        ) : null}
        {totalItems > 0 ? (
          <Text style={styles.orderCardMeta}>
            {totalItems} item{totalItems === 1 ? '' : 's'}
          </Text>
        ) : null}
        {note ? (
          <Text style={styles.orderCardMessage} testID={`conversation-order-note-${item.id}`}>
            {item.order.type === 'order' ? `${t('sellerOrders.buyerNote')}: ` : ''}
            {note}
          </Text>
        ) : null}
        {item.awaitingInvoice ? (
          // My placed order with no payment request back yet. Many sellers
          // don't run a Gamma-aware client, so the invoice may also arrive as
          // a plain chat message — say what we're waiting for.
          <View style={styles.orderCardWaiting} testID={`conversation-order-waiting-${item.id}`}>
            <Clock size={14} color={colors.textSupplementary} strokeWidth={2.5} />
            <Text style={styles.orderCardWaitingText}>{t('orderCard.waitingForInvoice')}</Text>
          </View>
        ) : null}
        {/* Pay / QR affordance — a Pay button + QR + copy on a kind-16 type-2
            payment request, or a "Paid ✓" badge on a kind-17 receipt (#925
            follow-up). Renders nothing for other order types. */}
        <OrderPaymentActions
          order={item.order}
          expectedAmountSats={item.expectedAmountSats}
          fromMe={item.fromMe}
          isInvoicePaid={isInvoicePaid}
          onPayInvoice={onPayInvoice}
          testIdPrefix="conversation"
          id={item.id}
        />
        {peerPubkey && item.order.type === 'order' ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('orderCard.viewOrder')}
            testID={`conversation-order-view-${item.id}`}
            onPress={() =>
              navigation.navigate(
                'Main',
                item.fromMe
                  ? orderNavigationTarget('MarketMyOrders', {
                      orderId: item.order.orderId,
                      sellerPubkey: peerPubkey,
                    })
                  : orderNavigationTarget('MarketShopOrders', {
                      orderId: item.order.orderId,
                      buyerPubkey: peerPubkey,
                    }),
              )
            }
          >
            <Text style={styles.orderCardMeta}>{t('orderCard.viewOrder')}</Text>
          </TouchableOpacity>
        ) : null}
        <Text style={styles.orderCardTime}>{formatTime(item.createdAt)}</Text>
      </View>
    </View>
  );
}

export default React.memo(ConversationOrderCard);
