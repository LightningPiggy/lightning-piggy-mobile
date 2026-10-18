import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createOrderItemThumbnailsStyles } from '../styles/OrderItemThumbnails.styles';
import { isSupportedImageUrl } from '../utils/imageUrl';
import type { OrderItemPreview } from '../utils/orderPresentation';
import { titleInitial } from '../utils/titleInitial';

export const OrderItemImage = React.memo(function OrderItemImage({
  item,
  large = false,
  testID,
}: {
  item: Pick<OrderItemPreview, 'title' | 'image'>;
  large?: boolean;
  testID?: string;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createOrderItemThumbnailsStyles(colors), [colors]);
  const [failedUri, setFailedUri] = useState<string>();
  const uri = item.image;
  return (
    <View style={[styles.thumbnail, large && styles.large]} testID={testID}>
      {uri && failedUri !== uri && isSupportedImageUrl(uri) ? (
        <Image
          source={{ uri }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={uri}
          autoplay={false}
          onError={() => setFailedUri(uri)}
          accessibilityLabel={item.title}
        />
      ) : (
        <Text style={styles.initial}>{titleInitial(item.title)}</Text>
      )}
    </View>
  );
});

function OrderItemThumbnails({ items, orderId }: { items: OrderItemPreview[]; orderId: string }) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createOrderItemThumbnailsStyles(colors), [colors]);
  return (
    <View style={styles.row}>
      {items.slice(0, 3).map((item, i) => (
        <View key={item.ref}>
          <OrderItemImage item={item} testID={`order-item-thumb-${orderId}-${i}`} />
          <View style={styles.badge}>
            <Text style={styles.count}>×{item.quantity}</Text>
          </View>
        </View>
      ))}
      {items.length > 3 ? (
        <Text style={styles.more} testID={`order-item-more-${orderId}`}>
          {t('myOrders.moreItems', { count: items.length - 3 })}
        </Text>
      ) : null}
    </View>
  );
}
export default React.memo(OrderItemThumbnails);
