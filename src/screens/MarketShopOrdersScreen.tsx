import OrderStatusFilter from '../components/OrderStatusFilter';
import { useOrderStatusFilter } from '../hooks/useOrderStatusFilter';
import { orderListingPreviews } from '../utils/orderPresentation';
import SellerOrderPanel from '../components/SellerOrderPanel';
import OrderStatusChip from '../components/OrderStatusChip';
import {
  effectiveSellerInvoice,
  receiptProvesPayment,
  shopOrderStatus,
} from '../utils/shopOrderStatus';
import { expiresAtFromBolt11 } from '../utils/bolt11';
import type { RouteProp } from '@react-navigation/native';
import type { ExploreStackParamList } from '../navigation/types';
import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ShoppingBag } from 'lucide-react-native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import NostrLoginSheet from '../components/NostrLoginSheet';
import BrandedSpinner from '../components/BrandedSpinner';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useSellerShop } from '../hooks/useSellerShop';
import { useShopOrders } from '../hooks/useShopOrders';
import { useBuyerProfiles } from '../hooks/useBuyerProfiles';
import MarketSellerHeader from '../components/MarketSellerHeader';
import ShopOrderRow from '../components/ShopOrderRow';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import { createMarketShopOrdersStyles } from '../styles/MarketShopOrders.styles';
import { merchantLabel } from '../utils/marketMerchants';
import { listingTitleMap, type ShopOrder } from '../utils/shopOrders';
import type { ExploreNavigation, RootStackParamList } from '../navigation/types';

// Conversation lives on the root stack, not the Explore stack.
type OrdersNavigation = CompositeNavigationProp<
  ExploreNavigation,
  NativeStackNavigationProp<RootStackParamList>
>;

interface Props {
  navigation: OrdersNavigation;
  route: RouteProp<ExploreStackParamList, 'MarketShopOrders'>;
}

const orderKey = (order: ShopOrder) => order.key;

/** Incoming Gamma orders for the seller's own listings (#1534), read from
 * the encrypted DM store. Tapping one opens its shop detail and explicit
 * invoice actions, without entering a conversation. */
const MarketShopOrdersScreen: React.FC<Props> = ({ navigation, route }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const orderStyles = useMemo(() => createMarketShopOrdersStyles(colors), [colors]);
  const { pubkey, snapshot } = useSellerShop();
  const [loginVisible, setLoginVisible] = useState(false);
  const previews = useMemo(() => orderListingPreviews(snapshot.listings), [snapshot.listings]);
  const titles = useMemo(() => listingTitleMap(snapshot.listings), [snapshot.listings]);
  const { orders, threads, paidKeys, invoices } = useShopOrders(titles);
  const [nowMs, setNowMs] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const nextExpiry = Math.min(
        ...[...threads.values()].flatMap((thread) =>
          thread.invoice && thread.invoice.expiresAt * 1000 > nowMs
            ? [thread.invoice.expiresAt * 1000]
            : [],
        ),
        ...Object.values(invoices).flatMap((record) => {
          const expiry = expiresAtFromBolt11(record.bolt11);
          return expiry !== null && expiry * 1000 > nowMs ? [expiry * 1000] : [];
        }),
      );
      if (!Number.isFinite(nextExpiry)) return;
      const timer = setTimeout(
        () => setNowMs(Date.now()),
        Math.min(Math.max(0, nextExpiry - Date.now()), 2_147_483_647),
      );
      return () => clearTimeout(timer);
    }, [threads, invoices, nowMs]),
  );
  const buyersKey = useMemo(
    () => [...new Set((orders ?? []).map((o) => o.buyer))].sort().join(','),
    [orders],
  );
  const profiles = useBuyerProfiles(buyersKey);

  const statusOf = useCallback(
    (order: ShopOrder) => {
      const thread = threads.get(order.key);
      const effective = thread ? effectiveSellerInvoice(invoices[order.key], thread.invoice) : null;
      return shopOrderStatus(thread, {
        invoiceRecord: invoices[order.key],
        walletPaid: paidKeys.has(order.key),
        nowMs: Math.max(nowMs, Date.now()),
        receiptVerified:
          thread && effective
            ? receiptProvesPayment(thread, effective.paymentHash, effective.bolt11)
            : false,
      });
    },
    [threads, paidKeys, invoices, nowMs],
  );
  const loadedOrders = useMemo(() => orders ?? [], [orders]);
  const filter = useOrderStatusFilter(loadedOrders, statusOf);

  const onOpen = useCallback(
    (order: ShopOrder) => {
      navigation.push('MarketShopOrders', {
        orderId: order.orderId,
        buyerPubkey: order.buyer,
      });
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: ShopOrder }) => {
      const profile = profiles.get(item.buyer);
      return (
        <ShopOrderRow
          order={item}
          listings={previews}
          buyerName={merchantLabel(item.buyer, profile)}
          buyerPicture={profile?.picture ?? undefined}
          styles={orderStyles}
          onPress={onOpen}
          accessory={<OrderStatusChip status={statusOf(item)} />}
        />
      );
    },
    [profiles, orderStyles, onOpen, statusOf, previews],
  );
  const renderSeparator = useCallback(() => <View style={styles.separator} />, [styles]);

  const selected = orders?.find(
    (order) =>
      (order.orderId === route.params?.orderId || order.eventId === route.params?.eventId) &&
      order.buyer === route.params?.buyerPubkey,
  );
  const selectedThread = selected ? threads.get(selected.key) : undefined;

  return (
    <View style={styles.container} testID="shop-orders-screen">
      <MarketSellerHeader
        title={t('market.sell.hub.orders')}
        backLabel={t('market.sell.back')}
        onBack={() => navigation.goBack()}
        testID="shop-orders-back"
      />
      {!pubkey ? (
        <View style={styles.centered} testID="shop-orders-signed-out">
          <ShoppingBag size={40} color={colors.brandPink} strokeWidth={2} />
          <Text style={styles.cardTitle}>{t('market.sell.signInTitle')}</Text>
          <Text style={[styles.cardBody, styles.centerText]}>{t('market.sell.signInBody')}</Text>
          <TouchableOpacity
            style={styles.primaryButton}
            onPress={() => setLoginVisible(true)}
            accessibilityRole="button"
            accessibilityLabel={t('market.sell.signIn')}
            testID="shop-orders-sign-in"
          >
            <Text style={styles.primaryButtonText}>{t('market.sell.signIn')}</Text>
          </TouchableOpacity>
        </View>
      ) : !orders ? (
        <View style={styles.centered}>
          <BrandedSpinner />
        </View>
      ) : route.params?.orderId || route.params?.eventId ? (
        <ScrollView contentContainerStyle={styles.listContent}>
          {selected && selectedThread ? (
            <SellerOrderPanel
              key={selected.key}
              order={selectedThread.placed}
              thread={selectedThread}
              buyerPubkey={selected.buyer}
              id={selected.orderId}
            />
          ) : (
            <Text style={styles.hint}>{t('market.sell.hub.noOrders')}</Text>
          )}
        </ScrollView>
      ) : (
        <FlatList
          data={filter.filtered}
          keyExtractor={orderKey}
          renderItem={renderItem}
          ItemSeparatorComponent={renderSeparator}
          ListHeaderComponent={
            orders.length > 0 ? (
              <>
                <View style={orderStyles.listHeader}>
                  <Text style={styles.hint}>{t('market.sell.orders.hint')}</Text>
                </View>
                <OrderStatusFilter {...filter} />
              </>
            ) : null
          }
          ListEmptyComponent={
            orders.length > 0 ? (
              <Text style={styles.hint}>{t('orderStatus.empty')}</Text>
            ) : (
              <View style={orderStyles.empty} testID="shop-orders-empty">
                <ShoppingBag size={40} color={colors.brandPink} strokeWidth={2} />
                <Text style={orderStyles.emptyTitle}>{t('market.sell.hub.noOrders')}</Text>
                <Text style={orderStyles.emptyBody}>{t('market.sell.orders.emptyBody')}</Text>
              </View>
            )
          }
          contentContainerStyle={styles.listContent}
          style={styles.flex1}
          initialNumToRender={10}
          windowSize={7}
          testID="shop-order-list"
        />
      )}
      <NostrLoginSheet visible={loginVisible} onClose={() => setLoginVisible(false)} />
    </View>
  );
};

export default MarketShopOrdersScreen;
