import BrandedSpinner from '../BrandedSpinner';
import React from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Play } from 'lucide-react-native';
import NostrContent from '../nostr/NostrContent';
import MarketProductCard from '../MarketProductCard';
import ReplyContext from './ReplyContext';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import { relativeTime } from '../../utils/relativeTime';
import { isSupportedImageUrl } from '../../utils/imageUrl';
import { isPublicHttpUrl } from '../../utils/publicUrl';
import { useIsTrustedAuthor } from '../../hooks/useFollowedPubkeys';
import { useTapToReveal } from '../../hooks/useTapToReveal';
import TapToLoadMedia from '../TapToLoadMedia';
import {
  MEDIA_COLUMNS,
  type MediaTile,
  type ProfileRow,
  type ProfileStatus,
} from '../../utils/profileFeedRows';
import type { MarketProduct } from '../../data/marketProducts';
import type { ProfileTabsStyles } from '../../styles/ProfileTabs.styles';

interface Props {
  row: ProfileRow;
  styles: ProfileTabsStyles;
  onOpenImage: (url: string) => void;
  onOpenProduct: (product: MarketProduct) => void;
}

const STATUS_KEYS: Record<Exclude<ProfileStatus, 'loading'>, string> = {
  emptyPosts: 'friendNoteFeed.noPostsYet',
  onlyReplies: 'profileTabs.onlyReplies',
  emptyMedia: 'profileTabs.noMedia',
  emptyShop: 'profileTabs.noShopItems',
  shopUnavailable: 'profileTabs.shopUnavailable',
  feedUnavailable: 'profileTabs.feedUnavailable',
};

/**
 * One row of the profile page's list: a post card, a row of media tiles, a
 * row of product cards, or a loading / empty status. Memoised with stable
 * props (rows are rebuilt only when the feed commits), per CLAUDE.md.
 */
const ProfileFeedRow: React.FC<Props> = ({ row, styles, onOpenImage, onOpenProduct }) => {
  const t = useTranslation();
  switch (row.type) {
    case 'post':
      return (
        <View
          style={styles.postCard}
          testID={`contact-profile-note-card-${row.event.id.slice(0, 12)}`}
        >
          <Text style={styles.postTime}>{relativeTime(row.event.created_at)}</Text>
          {row.reply ? (
            <ReplyContext
              reply={row.reply}
              testID={`profile-reply-context-${row.event.id.slice(0, 12)}`}
            />
          ) : null}
          <NostrContent
            content={row.event.content}
            onImagePress={onOpenImage}
            authorPubkey={row.event.pubkey}
          />
        </View>
      );
    case 'media':
      return (
        <View style={styles.gridRow}>
          {row.tiles.map((tile) => (
            <MediaTileView key={tile.key} tile={tile} styles={styles} onOpenImage={onOpenImage} />
          ))}
          {/* Keep a short last row's tiles the same size as full rows. */}
          {Array.from({ length: MEDIA_COLUMNS - row.tiles.length }, (_, i) => (
            <View key={`spacer-${i}`} style={styles.mediaSpacer} />
          ))}
        </View>
      );
    case 'products':
      return (
        <View style={styles.productRow}>
          {row.products.map((product) => (
            <View key={product.id} style={styles.productCell}>
              <MarketProductCard
                product={product}
                sellerName={product.sellerName}
                onPress={onOpenProduct}
                variant="grid"
                testID={`profile-shop-item-${product.id}`}
              />
            </View>
          ))}
          {row.products.length === 1 ? <View style={styles.productCell} /> : null}
        </View>
      );
    case 'status':
      return (
        <View style={styles.statusRow} testID={`profile-status-${row.status}`}>
          {row.status === 'loading' ? (
            <BrandedSpinner size="small" />
          ) : (
            <Text
              style={styles.statusText}
              testID={row.status === 'emptyPosts' ? 'contact-profile-feed-empty' : undefined}
            >
              {t(STATUS_KEYS[row.status])}
            </Text>
          )}
        </View>
      );
  }
};

const MediaTileView: React.FC<{
  tile: MediaTile;
  styles: ProfileTabsStyles;
  onOpenImage: (url: string) => void;
}> = ({ tile, styles, onOpenImage }) => {
  const t = useTranslation();
  const colors = useThemeColors();
  const { item } = tile;
  const isVideo = item.type === 'video';
  // A video shows its poster (imeta `image`) when the author gave one.
  const preview = isVideo ? item.thumb : item.url;
  const hasImage = !!preview && isSupportedImageUrl(preview);
  // Tiles are the profile owner's media: auto-load only for me / people I
  // follow, from public hosts; otherwise tap to load (#1338).
  const trusted = useIsTrustedAuthor(tile.authorPubkey);
  const [loadAllowed, reveal] = useTapToReveal(
    `nostr-image:${preview ?? ''}`,
    trusted && !!preview && isPublicHttpUrl(preview),
  );
  const showImage = hasImage && loadAllowed;
  const gated = hasImage && !loadAllowed;
  const open = () => {
    if (gated) {
      reveal();
    } else if (isVideo || !showImage) {
      Linking.openURL(item.url).catch(() => {
        // No player / browser — nothing to surface.
      });
    } else {
      onOpenImage(item.url);
    }
  };
  return (
    <TouchableOpacity
      style={styles.mediaTile}
      onPress={open}
      accessibilityRole={isVideo ? 'button' : 'imagebutton'}
      accessibilityLabel={
        item.alt || (isVideo ? t('nostrContent.playVideo') : t('nostrContent.viewImage'))
      }
      testID={`profile-media-tile-${tile.eventId.slice(0, 12)}`}
      activeOpacity={0.85}
    >
      {showImage ? (
        <Image
          source={{ uri: preview }}
          placeholder={item.blurhash ? { blurhash: item.blurhash } : undefined}
          style={styles.mediaImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={preview}
          autoplay={false}
        />
      ) : null}
      {gated ? (
        <TapToLoadMedia
          variant="thumb"
          url={preview ?? item.url}
          fromMe={false}
          testID={`profile-media-placeholder-${tile.eventId.slice(0, 12)}`}
        />
      ) : null}
      {isVideo ? (
        <View style={styles.playBadge}>
          <Play size={16} color={colors.white} fill={colors.white} />
        </View>
      ) : null}
    </TouchableOpacity>
  );
};

export default React.memo(ProfileFeedRow);
