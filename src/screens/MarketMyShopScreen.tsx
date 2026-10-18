import BrandedRefreshControl from '../components/BrandedRefreshControl';
import MerchantIdentity from '../components/MerchantIdentity';
import SettingsRow from '../components/SettingsRow';
import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import type { LucideIcon } from 'lucide-react-native';
import { Coins, FolderOpen, Plus, ShoppingBag, Store, Tag, Truck } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useSellerShop } from '../hooks/useSellerShop';
import { useSellItem } from '../hooks/useSellItem';
import { useShopOrders } from '../hooks/useShopOrders';
import MarketSellerHeader from '../components/MarketSellerHeader';
import NostrLoginSheet from '../components/NostrLoginSheet';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import { createMarketMyShopStyles } from '../styles/MarketMyShop.styles';
import { isLegacyShopCollection } from '../utils/marketCollections';
import { hubSummaries, type HubSummaries } from '../utils/myShopHubSummary';
import { listingTitleMap, ordersNeedingInvoice } from '../utils/shopOrders';
import type { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

interface HubRow {
  id: keyof HubSummaries;
  icon: LucideIcon;
  titleKey: string;
  route:
    | 'MarketShopCurrencies'
    | 'MarketShopShipping'
    | 'MarketShopCollections'
    | 'MarketShopListings'
    | 'MarketShopOrders';
  testID: string;
}

const HUB_ROWS: readonly HubRow[] = [
  {
    id: 'currencies',
    icon: Coins,
    titleKey: 'market.sell.hub.currencies',
    route: 'MarketShopCurrencies',
    testID: 'shop-hub-currencies',
  },
  {
    id: 'shipping',
    icon: Truck,
    titleKey: 'market.sell.hub.shipping',
    route: 'MarketShopShipping',
    testID: 'shop-hub-shipping',
  },
  {
    id: 'collections',
    icon: FolderOpen,
    titleKey: 'market.sell.hub.collections',
    route: 'MarketShopCollections',
    testID: 'shop-hub-collections',
  },
  {
    id: 'listings',
    icon: Tag,
    titleKey: 'market.sell.hub.listings',
    route: 'MarketShopListings',
    testID: 'shop-hub-listings',
  },
  {
    id: 'orders',
    icon: ShoppingBag,
    titleKey: 'market.sell.hub.orders',
    route: 'MarketShopOrders',
    testID: 'shop-hub-orders',
  },
];

/** "My shop" hub (#1534): the shop's profile card, one grouped card linking
 * to each part of the shop with a live summary, and "Sell an item". */
const MarketMyShopScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const hubStyles = useMemo(() => createMarketMyShopStyles(colors), [colors]);
  const { pubkey, snapshot, status, refresh, canPublish, defaultCurrency } = useSellerShop();
  const [loginVisible, setLoginVisible] = useState(false);
  const titles = useMemo(() => listingTitleMap(snapshot.listings), [snapshot.listings]);
  const { orders } = useShopOrders(titles);
  const onSellItem = useSellItem({
    navigation,
    zoneCount: snapshot.zones.length,
    status,
    refresh,
  });

  const collectionCount = useMemo(
    () => (snapshot.collections ?? []).filter((e) => !isLegacyShopCollection(e)).length,
    [snapshot.collections],
  );
  const summaries = useMemo(
    () =>
      hubSummaries({
        status,
        currency: defaultCurrency ?? 'SATS',
        zoneCount: snapshot.zones.length,
        collectionCount,
        listingCount: snapshot.listings.length,
        orders: orders ? { total: orders.length, needInvoice: ordersNeedingInvoice(orders) } : null,
      }),
    [status, defaultCurrency, snapshot.zones.length, collectionCount, snapshot.listings, orders],
  );

  const header = (
    <MarketSellerHeader
      title={t('market.sell.myShop')}
      backLabel={t('market.sell.back')}
      onBack={() => navigation.goBack()}
      testID="my-shop-back"
    />
  );

  if (!pubkey || !canPublish) {
    return (
      <View style={styles.container} testID="my-shop-screen">
        {header}
        <View style={styles.centered}>
          <Store size={40} color={colors.brandPink} strokeWidth={2} />
          <Text style={styles.cardTitle}>{t('market.sell.signInTitle')}</Text>
          <Text style={[styles.cardBody, styles.centerText]}>
            {pubkey ? t('market.sell.cannotPublish') : t('market.sell.signInBody')}
          </Text>
          {!pubkey ? (
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={() => setLoginVisible(true)}
              accessibilityLabel={t('market.sell.signIn')}
              testID="my-shop-sign-in"
            >
              <Text style={styles.primaryButtonText}>{t('market.sell.signIn')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <NostrLoginSheet visible={loginVisible} onClose={() => setLoginVisible(false)} />
      </View>
    );
  }

  return (
    <View style={styles.container} testID="my-shop-screen">
      {header}
      <ScrollView
        contentContainerStyle={styles.content}
        style={styles.flex1}
        refreshControl={
          <BrandedRefreshControl refreshing={status === 'loading'} onRefresh={refresh} />
        }
      >
        <View style={styles.card} testID="my-shop-card">
          <MerchantIdentity />
        </View>
        {status === 'error' ? (
          <TouchableOpacity
            onPress={refresh}
            accessibilityLabel={t('market.sell.retry')}
            testID="my-shop-retry"
          >
            <Text style={styles.errorText}>{t('market.sell.loadError')}</Text>
          </TouchableOpacity>
        ) : null}
        <View style={hubStyles.groupCard} testID="shop-hub-card">
          {HUB_ROWS.map((row, index) => {
            const summary = summaries[row.id];
            return (
              <React.Fragment key={row.id}>
                {index > 0 ? <View style={hubStyles.groupSeparator} /> : null}
                <SettingsRow
                  grouped
                  appearance="surface"
                  icon={row.icon}
                  iconColor={colors.brandPink}
                  title={t(row.titleKey)}
                  value={t(summary.key, summary.params)}
                  onPress={() => navigation.navigate(row.route)}
                  testID={row.testID}
                  subtitleTestID={`${row.testID}-summary`}
                />
              </React.Fragment>
            );
          })}
        </View>
        {/* The main seller action. Easy to drop if the Listings row is enough. */}
        <TouchableOpacity
          style={styles.primaryButton}
          onPress={onSellItem}
          accessibilityLabel={t('market.sell.sellItem')}
          testID="my-shop-sell-item"
        >
          <Plus size={18} color={colors.white} strokeWidth={2.5} />
          <Text style={styles.primaryButtonText}>{t('market.sell.sellItem')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

export default MarketMyShopScreen;
