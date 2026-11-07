import React, { useCallback, useMemo, useState } from 'react';
import { Linking, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Play } from 'lucide-react-native';
import FullscreenImageModal from '../FullscreenImageModal';
import MentionChip from './MentionChip';
import EmbeddedEventCard from './EmbeddedEventCard';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import {
  createNostrContentStyles,
  type NostrContentStyles,
} from '../../styles/NostrContent.styles';
import { parseNostrContent, embedKey } from '../../utils/nip27';
import {
  groupContentBlocks,
  type ContentBlock,
  type BlockLimits,
} from '../../utils/nostrContentBlocks';
import { isSupportedImageUrl } from '../../utils/imageUrl';
import { checkRemoteUrl, MEDIA_MAX_BYTES } from '../../utils/remoteUrlPolicy';
import { useRemoteMediaWithAutoRetry } from '../../hooks/useRemoteMediaUri';
import type { NoteMediaItem } from '../../utils/noteMedia';
import { useIsTrustedAuthor } from '../../hooks/useFollowedPubkeys';
import { useTapToReveal } from '../../hooks/useTapToReveal';
import TapToLoadMedia from '../TapToLoadMedia';
import MediaStatusBox from '../MediaStatusBox';

interface Props {
  content: string;
  /** testID prefix for the body (`<testID>` on the container). */
  testID?: string;
  /** Called with an image URL on thumbnail tap. When omitted, NostrContent
   * opens its own full-screen viewer. Lists pass one shared handler so they
   * don't mount a viewer per row. */
  onImagePress?: (url: string) => void;
  /** Override the per-body caps on embedded cards and thumbnails. */
  limits?: BlockLimits;
  /** Who wrote `content` (#1338). Images auto-load only when that's me or
   * someone I follow, and only from public hosts; otherwise each thumbnail
   * is "tap to load". Omitted = untrusted (fail closed). */
  authorPubkey?: string | null;
}

function openUrl(url: string): void {
  // Only http(s) — the parser never emits anything else, but stay defensive.
  if (!/^https?:\/\//i.test(url)) return;
  Linking.openURL(url).catch(() => {
    // No handler — nothing to surface.
  });
}

/**
 * Reusable NIP-27 renderer for note / bio / message text (#1332): `nostr:`
 * profile mentions become tappable `@Name` chips, `note` / `nevent` / `naddr`
 * references become embedded cards, image / video URLs become thumbnails,
 * and other URLs become links. Built for the profile page first and meant
 * for chat next (#1295 @mentions). Parsing is memoised per `content`.
 */
const NostrContent: React.FC<Props> = ({ content, testID, onImagePress, limits, authorPubkey }) => {
  const colors = useThemeColors();
  const autoLoad = useIsTrustedAuthor(authorPubkey);
  const styles = useMemo(() => createNostrContentStyles(colors), [colors]);
  const blocks = useMemo(
    () => groupContentBlocks(parseNostrContent(content), limits),
    [content, limits],
  );
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const openImage = useCallback(
    (url: string) => (onImagePress ? onImagePress(url) : setViewerUrl(url)),
    [onImagePress],
  );

  if (blocks.length === 0) return null;
  return (
    <View style={styles.container} testID={testID}>
      {blocks.map((block, i) => (
        <Block
          key={blockKey(block, i)}
          block={block}
          styles={styles}
          onImagePress={openImage}
          autoLoad={autoLoad}
        />
      ))}
      {viewerUrl ? (
        <FullscreenImageModal url={viewerUrl} onClose={() => setViewerUrl(null)} />
      ) : null}
    </View>
  );
};

function blockKey(block: ContentBlock, index: number): string {
  if (block.type === 'embed') return `${index}-${embedKey(block.token)}`;
  return `${index}-${block.type}`;
}

const Block: React.FC<{
  block: ContentBlock;
  styles: NostrContentStyles;
  onImagePress: (url: string) => void;
  autoLoad: boolean;
}> = ({ block, styles, onImagePress, autoLoad }) => {
  if (block.type === 'embed') return <EmbeddedEventCard token={block.token} styles={styles} />;
  if (block.type === 'media') {
    const single = block.items.length === 1;
    return (
      <View style={styles.mediaRow}>
        {block.items.map((item, i) => (
          <MediaThumb
            key={`${i}-${item.url}`}
            item={item}
            index={i}
            single={single}
            styles={styles}
            onImagePress={onImagePress}
            autoLoad={autoLoad}
          />
        ))}
      </View>
    );
  }
  return (
    <Text style={styles.text}>
      {block.tokens.map((token, i) => {
        if (token.type === 'profile') {
          return <MentionChip key={`${i}-${token.pubkey}`} pubkey={token.pubkey} styles={styles} />;
        }
        if (token.type === 'link') {
          return (
            <Text
              key={`${i}-link`}
              style={styles.link}
              onPress={() => openUrl(token.url)}
              accessibilityRole="link"
            >
              {token.url.replace(/^https?:\/\//i, '')}
            </Text>
          );
        }
        return token.text;
      })}
    </Text>
  );
};

/** One inline image / video thumbnail. Its own component so the tap-to-load
 * state (#1338) can live in a hook per item. */
const MediaThumb: React.FC<{
  item: NoteMediaItem;
  index: number;
  single: boolean;
  styles: NostrContentStyles;
  onImagePress: (url: string) => void;
  autoLoad: boolean;
}> = ({ item, index, single, styles, onImagePress, autoLoad }) => {
  const t = useTranslation();
  const colors = useThemeColors();
  const isVideo = item.type === 'video';
  const isImage = !isVideo && isSupportedImageUrl(item.url);
  const [loadAllowed, reveal] = useTapToReveal(
    `nostr-image:${item.url}`,
    autoLoad && checkRemoteUrl(item.url, { kind: 'media' }).ok,
  );
  const safe = checkRemoteUrl(item.url, { kind: 'media' }).ok;
  const { uri, failed, retry } = useRemoteMediaWithAutoRetry(
    isImage && loadAllowed && safe ? item.url : null,
    MEDIA_MAX_BYTES,
  );
  const gated = isImage && (!loadAllowed || !safe);
  // A download in flight shows a spinner; a failed one (after one automatic
  // retry) says so and retries on tap, instead of a silent empty box.
  const loading = isImage && !gated && !uri && !failed;
  const loadFailed = isImage && !gated && failed;
  const onPress = () => {
    if (!safe) return;
    if (gated) reveal();
    else if (loadFailed) retry();
    else if (isVideo || !isImage) openUrl(item.url);
    else if (uri) onImagePress(uri);
  };
  return (
    <TouchableOpacity
      style={[styles.thumb, single && styles.thumbSingle]}
      onPress={onPress}
      accessibilityRole={isVideo ? 'button' : gated ? 'button' : 'imagebutton'}
      accessibilityLabel={
        isVideo
          ? t('nostrContent.playVideo')
          : gated
            ? t('messageBubble.tapToLoadImage')
            : loadFailed
              ? `${t('messageBubble.imageLoadFailed')}. ${t('messageBubble.tapToRetry')}`
              : t('nostrContent.viewImage')
      }
      testID={`nostr-inline-${item.type}-${index}`}
      activeOpacity={0.85}
    >
      {isImage && uri ? (
        <Image
          source={{ uri }}
          style={styles.thumbImage}
          contentFit="cover"
          cachePolicy="memory-disk"
          recyclingKey={item.url}
          autoplay={false}
        />
      ) : null}
      {loading ? (
        <MediaStatusBox
          status="loading"
          style={styles.thumbStatus}
          testID={`nostr-inline-image-loading-${index}`}
        />
      ) : null}
      {loadFailed ? (
        <MediaStatusBox
          status="failed"
          label={t('messageBubble.imageLoadFailed')}
          style={styles.thumbStatus}
          testID={`nostr-inline-image-failed-${index}`}
        />
      ) : null}
      {gated ? (
        <TapToLoadMedia
          variant="thumb"
          url={item.url}
          fromMe={false}
          testID={`nostr-inline-image-placeholder-${index}`}
        />
      ) : null}
      {isVideo ? (
        <View style={styles.playBadge}>
          <Play size={18} color={colors.white} fill={colors.white} />
        </View>
      ) : null}
    </TouchableOpacity>
  );
};

export default React.memo(NostrContent);
