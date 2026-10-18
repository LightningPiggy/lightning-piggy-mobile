import React, { useCallback, useMemo } from 'react';
import { Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import MarketProductCard from './MarketProductCard';
import { useSharedListing } from '../hooks/useSharedListing';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createMessageSharedListingStyles } from '../styles/MessageSharedListing.styles';
import { titleInitial } from '../utils/titleInitial';
import type { EmbedRef } from '../services/nostrEmbedCache';
import type { MarketProduct } from '../data/marketProducts';
import type { RootStackParamList } from '../navigation/types';

/** The card is present on the first frame, including pending sends and offline misses. */
const MessageSharedListing: React.FC<{
  token: EmbedRef;
  title?: string;
  autoLoadMedia: boolean;
}> = ({ token, title, autoLoadMedia }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMessageSharedListingStyles(colors), [colors]);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const safeToken = useMemo(
    () => (autoLoadMedia ? token : { ...token, relays: [] }),
    [token, autoLoadMedia],
  );
  const product = useSharedListing(safeToken);
  const open = useCallback(
    (p: MarketProduct) => navigation.push('ProductDetail', { productId: p.id, product: p }),
    [navigation],
  );
  if (product)
    return (
      <MarketProductCard
        product={product}
        sellerName={product.sellerName}
        onPress={open}
        variant="list"
        autoLoadMedia={autoLoadMedia}
        testID="message-shared-listing-product"
      />
    );
  const label = title?.trim() || t('market.share.marketListing');
  return (
    <View style={styles.card} testID="message-shared-listing-placeholder">
      <View style={styles.image}>
        <Text style={styles.initial}>{titleInitial(label)}</Text>
      </View>
      <Text style={styles.title} numberOfLines={2}>
        {label}
      </Text>
      <Text style={styles.label}>{t('market.share.marketListing')}</Text>
    </View>
  );
};
export default React.memo(MessageSharedListing);
