import OrderStatusChip from '../components/OrderStatusChip';
import OrderStatusFilter from '../components/OrderStatusFilter';
import { useOrderStatusFilter } from '../hooks/useOrderStatusFilter';
import { PREFERRED_SELLERS_ACCOUNT } from '../services/marketPreferredSellers';
import { loadedMarketSnapshots } from '../services/marketStorage';
import { useBuyerProfiles } from '../hooks/useBuyerProfiles';
import { orderItemsSummary, orderProductPreviews } from '../utils/orderPresentation';
import { useNostr } from '../contexts/NostrContext';
import OrderPaymentActions from '../components/OrderPaymentActions';
import SendSheet from '../components/SendSheet';
import type { RouteProp } from '@react-navigation/native';
import type { ExploreStackParamList } from '../navigation/types';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, ScrollView, View, Text } from 'react-native';
import { ReceiptText } from 'lucide-react-native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useBuyerOrders } from '../hooks/useBuyerOrders';
import MarketSellerHeader from '../components/MarketSellerHeader';
import MyOrderRow from '../components/MyOrderRow';
import BrandedSpinner from '../components/BrandedSpinner';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import { createMarketMyOrdersScreenStyles } from '../styles/MarketMyOrdersScreen.styles';
import type { BuyerOrderEntry } from '../utils/orderThreads';
import type { ExploreNavigation, RootStackParamList } from '../navigation/types';

const statusOf = (entry: BuyerOrderEntry) => entry.status;

type Navigation = CompositeNavigationProp<
  ExploreNavigation,
  NativeStackNavigationProp<RootStackParamList>
>;

interface Props {
  navigation: Navigation;
  route: RouteProp<ExploreStackParamList, 'MarketMyOrders'>;
}

/**
 * Buyer's My orders: every Gamma order I placed, newest first, with where it
 * stands (Awaiting invoice / Pay now / Paid / Shipped / Completed). Read from
 * the encrypted DM store — no relay subscription. A row opens a market
 * detail with its validated payment action, without entering chat.
 */
const MarketMyOrdersScreen: React.FC<Props> = ({ navigation, route }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const sellerStyles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const styles = useMemo(() => createMarketMyOrdersScreenStyles(colors), [colors]);
  const [invoiceToPay, setInvoiceToPay] = useState<string | null>(null);
  const { entries, titles, loading } = useBuyerOrders();
  const filter = useOrderStatusFilter(entries, statusOf);
  const { pubkey } = useNostr();
  const sellersKey = useMemo(
    () => [...new Set(entries.map((entry) => entry.sellerPubkey))].sort().join(','),
    [entries],
  );
  const profiles = useBuyerProfiles(sellersKey);
  // Reuse the public preferred catalogue and this account's loaded friends catalogue.
  const previews = useMemo(
    () =>
      orderProductPreviews(
        loadedMarketSnapshots(
          pubkey ? [PREFERRED_SELLERS_ACCOUNT, pubkey] : [PREFERRED_SELLERS_ACCOUNT],
        ).flatMap((s) => s.products),
      ),
    [pubkey],
  );

  const openOrder = useCallback(
    (entry: BuyerOrderEntry) => {
      navigation.push('MarketMyOrders', {
        orderId: entry.orderId,
        sellerPubkey: entry.sellerPubkey,
      });
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: BuyerOrderEntry }) => (
      <MyOrderRow
        entry={item}
        listings={previews}
        itemTitles={titles[item.orderId]}
        profile={profiles.get(item.sellerPubkey)}
        itemsSummary={orderItemsSummary(item.order.items, titles[item.orderId], previews)}
        onPress={openOrder}
      />
    ),
    [titles, openOrder, previews, profiles],
  );

  const selected = entries.find(
    (entry) =>
      entry.orderId === route.params?.orderId && entry.sellerPubkey === route.params?.sellerPubkey,
  );
  return (
    <View style={sellerStyles.container} testID="my-orders-screen">
      <MarketSellerHeader
        title={t('myOrders.title')}
        backLabel={t('market.sell.back')}
        onBack={() => navigation.goBack()}
        testID="my-orders-back"
      />
      {loading && entries.length === 0 ? (
        <View style={styles.empty}>
          <BrandedSpinner />
        </View>
      ) : route.params?.orderId ? (
        <ScrollView contentContainerStyle={styles.listContent}>
          {selected ? (
            <>
              <Text style={styles.emptyText}>
                {orderItemsSummary(selected.order.items, titles[selected.orderId], previews)}
              </Text>
              <OrderStatusChip status={selected.status} />
              {selected.status === 'invoiceExpired' ? (
                <Text style={styles.emptyText}>{t('myOrders.askForNewInvoice')}</Text>
              ) : null}
              {selected.paymentRequest ? (
                <OrderPaymentActions
                  order={selected.paymentRequest}
                  expectedAmountSats={selected.order.amountSats}
                  fromMe={false}
                  onPayInvoice={setInvoiceToPay}
                  testIdPrefix="my-order"
                  id={selected.orderId}
                />
              ) : null}
            </>
          ) : (
            <Text style={styles.emptyText}>{t('myOrders.empty')}</Text>
          )}
        </ScrollView>
      ) : (
        <FlatList
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={filter.filtered}
          ListHeaderComponent={<OrderStatusFilter {...filter} />}
          keyExtractor={(entry) => `${entry.sellerPubkey}:${entry.orderId}`}
          renderItem={renderItem}
          testID="my-orders-list"
          ListEmptyComponent={
            entries.length > 0 ? (
              <Text style={styles.emptyText}>{t('orderStatus.empty')}</Text>
            ) : (
              <View style={styles.empty} testID="my-orders-empty">
                <ReceiptText size={36} color={colors.textSupplementary} strokeWidth={1.75} />
                <Text style={styles.emptyText}>{t('myOrders.empty')}</Text>
              </View>
            )
          }
        />
      )}
      <SendSheet
        visible={invoiceToPay !== null}
        onClose={() => setInvoiceToPay(null)}
        initialAddress={invoiceToPay ?? undefined}
      />
    </View>
  );
};

export default MarketMyOrdersScreen;
