import BrandedRefreshControl from '../components/BrandedRefreshControl';
import React, { useCallback, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity, FlatList } from 'react-native';
import { Plus } from 'lucide-react-native';
import type { Event } from 'nostr-tools';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useSellerShop } from '../hooks/useSellerShop';
import { useSellerActions } from '../hooks/useSellerActions';
import { useSellItem } from '../hooks/useSellItem';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';
import MarketSellerHeader from '../components/MarketSellerHeader';
import ListingRepublishSheet from '../components/ListingRepublishSheet';
import { useListingRepublish } from '../hooks/useListingRepublish';
import SellerListingRow from '../components/SellerListingRow';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import { parseListingDraft, type ListingDraft } from '../utils/marketSellerEvents';
import { parseMarketListing } from '../utils/marketListings';
import type { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

interface Row {
  event: Event;
  draft: ListingDraft;
}

const rowKey = (row: Row) => row.event.id;

/** The seller's kind-30402 product listings (#1534): "Sell an item" plus
 * each listing with Edit, Preview and Delete. */
const MarketShopListingsScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const { snapshot, status, refresh } = useSellerShop();
  const { deleteListing, resignListing, busy } = useSellerActions(snapshot);
  const republish = useListingRepublish(snapshot.listings, resignListing);
  const onSellItem = useSellItem({
    navigation,
    zoneCount: snapshot.zones.length,
    status,
    refresh,
  });

  // Re-use a row (and so its parsed draft) while the event is unchanged, so
  // the memoised rows skip re-rendering on unrelated store updates.
  const rowCache = useRef(new Map<string, Row>());
  const rows = useMemo<Row[]>(() => {
    const next = new Map<string, Row>();
    const out = snapshot.listings.map((event) => {
      const row = rowCache.current.get(event.id) ?? { event, draft: parseListingDraft(event) };
      next.set(event.id, row);
      return row;
    });
    rowCache.current = next;
    return out;
  }, [snapshot.listings]);

  const onEdit = useCallback(
    (dTag: string) => navigation.navigate('MarketListingEditor', { dTag }),
    [navigation],
  );
  const onPreview = useCallback(
    (event: Event) => {
      const product = parseMarketListing(event);
      if (product) navigation.navigate('MarketProductDetail', { productId: product.id, product });
    },
    [navigation],
  );
  const onDelete = useCallback(
    (event: Event) => {
      // One change at a time: two quick deletes would both rebuild the shop
      // from the same snapshot.
      if (busy) return;
      const title = parseListingDraft(event).title;
      Alert.alert(t('market.sell.deleteTitle'), t('market.sell.deleteBody', { title }), [
        { text: t('market.sell.cancel'), style: 'cancel' },
        {
          text: t('market.sell.delete'),
          style: 'destructive',
          onPress: () => {
            deleteListing(event)
              .then(() => Toast.show({ type: 'success', text1: t('market.sell.deleted') }))
              .catch((e: Error) =>
                Toast.show({
                  type: 'error',
                  text1: t('market.sell.deleteFailed'),
                  text2: e.message,
                }),
              );
          },
        },
      ]);
    },
    [deleteListing, busy, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) => (
      <SellerListingRow
        event={item.event}
        draft={item.draft}
        styles={styles}
        onEdit={onEdit}
        onPreview={onPreview}
        onDelete={onDelete}
        coverage={republish.coverage.get(item.draft.dTag)}
        onRepublish={republish.republish}
        republishBusy={busy || republish.busy || !republish.ready}
      />
    ),
    [styles, onEdit, onPreview, onDelete, republish, busy],
  );
  const renderSeparator = useCallback(() => <View style={styles.separator} />, [styles]);

  const listHeader = (
    <View style={styles.listHeader}>
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={republish.republishAll}
        disabled={busy || republish.busy || !republish.ready || !rows.length}
        accessibilityLabel={t('market.republish.all')}
        testID="listings-republish-all"
      >
        <Text style={styles.primaryButtonText}>{t('market.republish.all')}</Text>
      </TouchableOpacity>
      {status === 'error' ? (
        <TouchableOpacity
          onPress={refresh}
          accessibilityLabel={t('market.sell.retry')}
          testID="shop-listings-retry"
        >
          <Text style={styles.errorText}>{t('market.sell.loadError')}</Text>
        </TouchableOpacity>
      ) : null}
      <TouchableOpacity
        style={styles.primaryButton}
        onPress={onSellItem}
        accessibilityLabel={t('market.sell.sellItem')}
        testID="shop-listings-sell-item"
      >
        <Plus size={18} color={colors.white} strokeWidth={2.5} />
        <Text style={styles.primaryButtonText}>{t('market.sell.sellItem')}</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container} testID="shop-listings-screen">
      <MarketSellerHeader
        title={t('market.sell.hub.listings')}
        backLabel={t('market.sell.back')}
        onBack={() => navigation.goBack()}
        testID="shop-listings-back"
      />
      <ListingRepublishSheet progress={republish.progress} onClose={republish.close} />
      <FlatList
        data={rows}
        keyExtractor={rowKey}
        renderItem={renderItem}
        ListHeaderComponent={listHeader}
        ListEmptyComponent={
          status === 'loading' ? null : (
            <Text style={[styles.muted, styles.emptyText]} testID="my-shop-no-listings">
              {t('market.sell.noListings')}
            </Text>
          )
        }
        ItemSeparatorComponent={renderSeparator}
        contentContainerStyle={styles.listContent}
        style={styles.flex1}
        refreshControl={
          <BrandedRefreshControl refreshing={status === 'loading'} onRefresh={refresh} />
        }
        initialNumToRender={8}
        windowSize={7}
        testID="shop-listing-list"
      />
    </View>
  );
};

export default MarketShopListingsScreen;
