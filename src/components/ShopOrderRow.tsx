import OrderItemThumbnails from './OrderItemThumbnails';
import { distinctOrderItems, type OrderListingPreview } from '../utils/orderPresentation';
import React, { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { useLocale } from '../contexts/LocaleContext';
import { isSupportedImageUrl } from '../utils/imageUrl';
import type { ShopOrder } from '../utils/shopOrders';
import type { MarketShopOrdersStyles } from '../styles/MarketShopOrders.styles';

interface Props {
  order: ShopOrder;
  listings?: ReadonlyMap<string, OrderListingPreview>;
  buyerName: string;
  buyerPicture?: string;
  styles: MarketShopOrdersStyles;
  onPress: (order: ShopOrder) => void;
  /** Extension slot under the items, e.g. a status chip or a "Send invoice"
   * action. */
  accessory?: React.ReactNode;
}

/** Locale-formatted date + time, e.g. "14 Oct, 21:05" (Intl only: no
 * hard-coded English "Today"). */
function orderTime(seconds: number, locale: string): string {
  const d = new Date(seconds * 1000);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = d.toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${date}, ${d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}`;
}

/** One incoming order: buyer, what they ordered and when. Tapping opens the
 * shop order detail. */
function ShopOrderRow({
  order,
  buyerName,
  buyerPicture,
  styles,
  onPress,
  accessory,
  listings,
}: Props) {
  const previews = useMemo(
    () => distinctOrderItems(order.lines, listings),
    [order.lines, listings],
  );
  const { t, formatLocale } = useLocale();
  const [imageFailed, setImageFailed] = useState(false);
  const items = order.lines
    .map((line) => t('market.sell.orders.line', { title: line.title, quantity: line.quantity }))
    .join(', ');
  const time = orderTime(order.createdAt, formatLocale);
  const showImage = !!buyerPicture && !imageFailed && isSupportedImageUrl(buyerPicture);
  return (
    <TouchableOpacity
      style={styles.row}
      onPress={() => onPress(order)}
      accessibilityRole="button"
      accessibilityLabel={t('market.sell.orders.rowAccessibility', {
        name: buyerName,
        items,
        time,
      })}
      testID={`shop-order-${order.orderId}`}
    >
      <View style={styles.avatar}>
        {showImage ? (
          <Image
            source={{ uri: buyerPicture }}
            style={styles.avatarImage}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={buyerPicture}
            onError={() => setImageFailed(true)}
          />
        ) : (
          <Text style={styles.avatarInitial}>{buyerName.charAt(0).toUpperCase()}</Text>
        )}
      </View>
      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text style={styles.name} numberOfLines={1}>
            {buyerName}
          </Text>
          <Text style={styles.time}>{time}</Text>
        </View>
        <Text style={styles.items} numberOfLines={2}>
          {items}
        </Text>
        <OrderItemThumbnails items={previews} orderId={order.orderId} />
        {accessory ? <View style={styles.accessory}>{accessory}</View> : null}
      </View>
    </TouchableOpacity>
  );
}

export default React.memo(ShopOrderRow);
