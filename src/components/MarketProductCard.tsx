import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Image } from 'expo-image';
import { Zap } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createMarketProductCardStyles } from '../styles/MarketProductCard.styles';
import { usePubkeyProfile } from '../hooks/usePubkeyProfile';
import VendorAvatar from './VendorAvatar';
import MarketPrice from './MarketPrice';
import { formatPrimaryPrice, marketPriceOf } from '../utils/marketPrice';
import type { MarketProduct } from '../data/marketProducts';
import type { MarketVendor } from '../data/marketVendors';
import { titleInitial } from '../utils/titleInitial';

interface Props {
  product: MarketProduct;
  /** Display name of the seller/shop the product comes from (resolved by
   * the caller from the vendor directory; falls back to `sellerName`). */
  sellerName: string;
  /** The resolved seller, when known — drives the merchant avatar (its Nostr
   * kind-0 picture, with the curated logo as fallback). Omitted when the
   * caller can't resolve the vendor; the row then shows just the name. */
  vendor?: MarketVendor;
  /** Tapped to open the product / "Buy" link. Receives the product so callers
   * can pass ONE stable callback (the card is memoised — a per-row closure
   * would defeat that and re-render every tile on any parent update). */
  onPress: (product: MarketProduct) => void;
  /**
   * `rail` — fixed-width vertical card for the Explore horizontal rail.
   * `list` — full-width card for the Market screen list.
   * `grid` — roughly-square tile for the Market screen 2-column grid (the
   *   caller sizes the tile via a fixed-width wrapper; the card fills it).
   */
  variant: 'rail' | 'list' | 'grid';
  /** testID base, e.g. `market-product-card-<id>`. */
  testID?: string;
  /** The seller publishes no usable shipping info (Ships-to filter): show
   * "Shipping: ask the seller". */
  shippingUnknown?: boolean;
  /** Chat embeds require explicit consent for untrusted remote images. */
  autoLoadMedia?: boolean;
}

/**
 * Reusable Market PRODUCT card, shared by the Explore "Market" rail and the
 * full Market screen. Leads with the product image, then shows the title,
 * price (with its conversion into the user's currency), and the seller/shop
 * it comes from — mirroring the product grid on lightningpiggy.com/market/.
 */
const MarketProductCard: React.FC<Props> = ({
  product,
  sellerName,
  vendor,
  onPress,
  variant,
  testID,
  shippingUnknown = false,
  autoLoadMedia = true,
}) => {
  // Shares the avatar's in-flight lookup and kind-0 cache; no extra relay query.
  const sellerProfile = usePubkeyProfile(product.listing?.event.pubkey ?? null);
  const displaySellerName = sellerProfile.name || sellerName;
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createMarketProductCardStyles(colors), [colors]);
  const listingPriceLabel = useMemo(
    () =>
      formatPrimaryPrice(
        marketPriceOf(product),
        (amount) => t('market.sats', { amount }),
        formatLocale,
      ),
    [product, t, formatLocale],
  );
  // Fall back to a branded placeholder tile if the image 404s / dead host.
  const [imageFailed, setImageFailed] = useState(false);
  const [revealedImage, setRevealedImage] = useState<string | null>(null);
  const canLoadImage = autoLoadMedia || revealedImage === product.image;
  const hasImage = product.image.length > 0 && !imageFailed;

  const isGrid = variant === 'grid';
  const cardStyle =
    variant === 'rail' ? styles.railCard : isGrid ? styles.gridCard : styles.listCard;

  const image = (
    <View style={isGrid ? styles.gridImageWrap : styles.imageWrap}>
      {hasImage && !canLoadImage ? (
        <TouchableOpacity
          style={styles.imageFallback}
          onPress={(event) => {
            event.stopPropagation();
            setRevealedImage(product.image);
          }}
          accessibilityRole="button"
          accessibilityLabel={t('messageBubble.tapToLoadImage')}
          testID={testID ? `${testID}-load-image` : undefined}
        >
          <Text style={styles.description}>{t('messageBubble.tapToLoadImage')}</Text>
        </TouchableOpacity>
      ) : hasImage ? (
        <Image
          source={{ uri: product.image }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory-disk"
          // Stable key so recycled grid tiles don't briefly show the previous
          // tile's image while scrolling the virtualized list.
          recyclingKey={product.image}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <View style={styles.imageFallback}>
          <Text style={styles.imageFallbackText}>{titleInitial(product.title)}</Text>
        </View>
      )}
      {product.featured ? (
        <View style={styles.featuredBadge} testID={testID ? `${testID}-featured` : undefined}>
          <Zap size={9} color={colors.zapYellowInk} strokeWidth={2.5} fill={colors.zapYellowInk} />
          <Text style={styles.featuredText}>{t('market.card.featured')}</Text>
        </View>
      ) : null}
    </View>
  );

  return (
    <TouchableOpacity
      style={cardStyle}
      onPress={() => onPress(product)}
      accessibilityRole="button"
      accessibilityLabel={
        product.listing
          ? `${product.title}, ${listingPriceLabel}, ${displaySellerName}`
          : t('market.card.accessibility', {
              title: product.title,
              amount: product.priceSats.toLocaleString(formatLocale),
              seller: displaySellerName,
            })
      }
      testID={testID}
      activeOpacity={0.8}
    >
      {image}
      <View style={isGrid ? styles.gridBody : styles.body}>
        <Text style={[styles.title, isGrid && styles.gridTitle]} numberOfLines={2}>
          {product.title}
        </Text>
        <MarketPrice
          product={product}
          variant="compact"
          testIDPrefix={testID ? `${testID}-price` : undefined}
        />
        <View style={styles.sellerRow}>
          {vendor ? (
            <VendorAvatar
              vendor={vendor}
              size={isGrid ? 16 : 20}
              testID={testID ? `${testID}-vendor-avatar` : undefined}
            />
          ) : null}
          <Text style={styles.seller} numberOfLines={1}>
            {t('market.fromSeller', { seller: displaySellerName })}
          </Text>
        </View>
        {shippingUnknown ? (
          <Text
            style={styles.shippingUnknown}
            numberOfLines={1}
            testID={testID ? `${testID}-shipping-unknown` : undefined}
          >
            {t('market.sell.detail.shippingNone')}
          </Text>
        ) : null}
        {variant === 'list' ? (
          <Text style={styles.description} numberOfLines={2}>
            {product.description}
          </Text>
        ) : null}
      </View>
    </TouchableOpacity>
  );
};

// Memoised: grid/rail rows must not re-render (and re-run their vendor-profile
// lookups) when the parent re-renders for unrelated state such as the filter
// panel opening (see CLAUDE.md "List rows are React.memo'd").
export default React.memo(MarketProductCard);
