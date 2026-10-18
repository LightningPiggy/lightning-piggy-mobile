import MarketHeader from '../components/MarketHeader';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View, useWindowDimensions } from 'react-native';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import MarketProductCard from '../components/MarketProductCard';
import NostrLoginSheet from '../components/NostrLoginSheet';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useLikedListings } from '../hooks/useLikedListings';
import { createMarketLikedItemsStyles } from '../styles/MarketLikedItemsScreen.styles';
import { sellerOf, type MarketProduct } from '../data/marketProducts';
import { MARKET_GRID_COLUMNS, marketGridTileWidth } from '../utils/marketGrid';
import type { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

/**
 * "Liked items" (#1541): the Market listings the viewer has liked (their own
 * NIP-25 reactions on kind-30402 listings, minus the ones they took back),
 * as the usual product grid. Fetched on focus; pull down to refresh.
 */
const MarketLikedItemsScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketLikedItemsStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const tileWidth = useMemo(() => marketGridTileWidth(width), [width]);
  const { products, loading, failed, signedIn, refresh } = useLikedListings();
  const [loginVisible, setLoginVisible] = useState(false);

  const openProduct = useCallback(
    (product: MarketProduct) =>
      navigation.navigate('MarketProductDetail', { productId: product.id, product }),
    [navigation],
  );

  const renderProduct = useCallback(
    ({ item }: { item: MarketProduct }) => {
      const vendor = sellerOf(item);
      return (
        <View style={{ width: tileWidth }}>
          <MarketProductCard
            product={item}
            sellerName={vendor?.name ?? item.sellerName}
            vendor={vendor}
            variant="grid"
            onPress={openProduct}
            testID={`liked-item-card-${item.id}`}
          />
        </View>
      );
    },
    [tileWidth, openProduct],
  );

  const emptyCopy = !signedIn
    ? t('market.liked.signedOut')
    : loading
      ? t('market.liked.loading')
      : failed
        ? t('market.liked.loadFailed')
        : t('market.liked.empty');

  return (
    <View style={styles.container} testID="market-liked-items-screen">
      <MarketHeader
        title={t('market.liked.title')}
        backLabel={t('market.liked.back')}
        onBack={() => navigation.goBack()}
        testID="market-liked-items-back"
      />

      <FlatList
        data={products}
        testID="liked-items-grid"
        refreshControl={
          signedIn ? <BrandedRefreshControl refreshing={loading} onRefresh={refresh} /> : undefined
        }
        keyExtractor={(p) => p.id}
        numColumns={MARKET_GRID_COLUMNS}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.gridContent}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        initialNumToRender={8}
        windowSize={7}
        renderItem={renderProduct}
        ListHeaderComponent={
          failed && signedIn && products.length > 0 ? (
            <View style={styles.emptyWrap} testID="liked-items-refresh-error">
              <Text style={styles.emptyText} accessibilityRole="alert">
                {t('market.liked.loadFailed')}
              </Text>
            </View>
          ) : null
        }
        ListEmptyComponent={
          <View style={styles.emptyWrap} testID="liked-items-empty">
            <Text style={styles.emptyText}>{emptyCopy}</Text>
            {signedIn ? null : (
              <TouchableOpacity
                style={styles.signInButton}
                onPress={() => setLoginVisible(true)}
                accessibilityRole="button"
                accessibilityLabel={t('market.liked.signIn')}
                testID="liked-items-sign-in"
              >
                <Text style={styles.signInText}>{t('market.liked.signIn')}</Text>
              </TouchableOpacity>
            )}
          </View>
        }
      />

      <NostrLoginSheet visible={loginVisible} onClose={() => setLoginVisible(false)} />
    </View>
  );
};

export default MarketLikedItemsScreen;
