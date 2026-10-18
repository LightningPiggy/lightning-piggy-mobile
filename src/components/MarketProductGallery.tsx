// Hero of the Market product page (#1531). One image (or none) renders the
// classic single hero at the image's real proportions; a listing with several
// images becomes a horizontally paged gallery with thumbnails and a
// "2 / 5" counter, and tapping any page opens the full-screen viewer there.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Image, type ImageLoadEventData } from 'expo-image';
import Animated, {
  runOnJS,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import FullscreenImageModal from './FullscreenImageModal';
import {
  createMarketProductGalleryStyles,
  type MarketProductGalleryStyles,
} from '../styles/MarketProductGallery.styles';
import { titleInitial } from '../utils/titleInitial';

interface Props {
  /** The product's main image (`''` when it has none). */
  image: string;
  /** Every image of a relay listing, in order; absent for curated products. */
  images?: readonly string[];
  /** Product title — its initial is the fallback when there's no image. */
  title: string;
}

// The gallery takes its height from the first image, clamped so one extreme
// first photo can't squash every page into a sliver or a skyscraper.
const MIN_GALLERY_ASPECT = 0.8;
const MAX_GALLERY_ASPECT = 2;

const aspectOf = (e: ImageLoadEventData): number | null => {
  const { width, height } = e.source ?? {};
  return width && height ? width / height : null;
};

const Fallback = ({ title, styles }: { title: string; styles: MarketProductGalleryStyles }) => (
  <View style={styles.imageFallback}>
    <Text style={styles.imageFallbackText}>{titleInitial(title)}</Text>
  </View>
);

/** The original single hero image, at its real aspect ratio once loaded. */
const SingleImage = ({
  image,
  title,
  styles,
}: {
  image: string | undefined;
  title: string;
  styles: MarketProductGalleryStyles;
}) => {
  const t = useTranslation();
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const onCloseViewer = useCallback(() => setViewerUrl(null), []);
  const [failed, setFailed] = useState(false);
  const [aspect, setAspect] = useState<number | null>(null);
  return (
    <View style={[styles.imageWrap, aspect ? { aspectRatio: aspect } : null]}>
      {image && !failed ? (
        <Pressable
          style={styles.image}
          onPress={() => setViewerUrl(image)}
          accessibilityRole="imagebutton"
          accessibilityLabel={t('imageGallery.open')}
          accessibilityHint={t('imageGallery.openHint')}
          testID="market-product-image-open"
        >
          <Image
            source={{ uri: image }}
            style={styles.image}
            contentFit="cover"
            cachePolicy="memory-disk"
            recyclingKey={image}
            onLoad={(e) => {
              const next = aspectOf(e);
              if (next) setAspect(next);
            }}
            onError={() => setFailed(true)}
          />
        </Pressable>
      ) : (
        <Fallback title={title} styles={styles} />
      )}
      <FullscreenImageModal url={viewerUrl} onClose={onCloseViewer} />
    </View>
  );
};

interface PageProps {
  url: string;
  index: number;
  total: number;
  width: number;
  height: number;
  title: string;
  styles: MarketProductGalleryStyles;
  onOpen: (index: number) => void;
  onLoad?: (e: ImageLoadEventData) => void;
}

const GalleryPage = React.memo(
  ({ url, index, total, width, height, title, styles, onOpen, onLoad }: PageProps) => {
    const t = useTranslation();
    const [failed, setFailed] = useState(false);
    return (
      <Pressable
        style={{ width, height }}
        onPress={() => onOpen(index)}
        disabled={failed}
        testID={`market-product-gallery-image-${index}`}
        accessibilityRole="imagebutton"
        accessibilityLabel={t('imageGallery.position', { current: index + 1, total })}
        accessibilityHint={t('imageGallery.openHint')}
      >
        {failed ? (
          <Fallback title={title} styles={styles} />
        ) : (
          <Image
            source={{ uri: url }}
            style={styles.image}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={url}
            onLoad={onLoad}
            onError={() => setFailed(true)}
          />
        )}
      </Pressable>
    );
  },
);

GalleryPage.displayName = 'GalleryPage';

interface ThumbnailProps {
  url: string;
  title: string;
  index: number;
  total: number;
  selected: boolean;
  activeColor: string;
  inactiveColor: string;
  scrollIndex: SharedValue<number>;
  styles: MarketProductGalleryStyles;
  onSelect: (index: number) => void;
}

// Highlight follows the scroll on the UI thread; React only commits settled pages.
const GalleryThumbnail = React.memo(
  ({
    url,
    title,
    index,
    total,
    selected,
    activeColor,
    inactiveColor,
    scrollIndex,
    styles,
    onSelect,
  }: ThumbnailProps) => {
    const t = useTranslation();
    const [failed, setFailed] = useState(false);
    const highlight = useAnimatedStyle(() => ({
      borderColor: scrollIndex.value === index ? activeColor : inactiveColor,
      borderWidth: scrollIndex.value === index ? 2 : styles.thumbnail.borderWidth,
    }));
    return (
      <Pressable
        onPress={() => onSelect(index)}
        testID={`market-product-gallery-thumb-${index}`}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={t('imageGallery.showImage', { current: index + 1, total })}
      >
        <Animated.View style={[styles.thumbnail, highlight]}>
          {failed ? (
            <View style={styles.imageFallback}>
              <Text style={styles.thumbnailFallbackText}>{title.charAt(0).toUpperCase()}</Text>
            </View>
          ) : (
            <Image
              source={{ uri: url }}
              style={styles.image}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={url}
              onError={() => setFailed(true)}
            />
          )}
        </Animated.View>
      </Pressable>
    );
  },
);
GalleryThumbnail.displayName = 'GalleryThumbnail';

const getThumbnailLayout = (_: ArrayLike<string> | null | undefined, index: number) => ({
  length: 56,
  offset: 16 + 64 * index,
  index,
});

const galleryKey = (url: string, index: number) => `${index}:${url}`;

const Gallery = ({
  images,
  title,
  styles,
}: {
  images: readonly string[];
  title: string;
  styles: MarketProductGalleryStyles;
}) => {
  const colors = useThemeColors();
  const { width } = useWindowDimensions();
  const galleryRef = useRef<FlatList<string>>(null);
  const thumbnailsRef = useRef<FlatList<string>>(null);
  const [aspect, setAspect] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const scrollIndex = useSharedValue(0);
  const total = images.length;
  const pageHeight = width / (aspect ?? 1);

  useEffect(() => {
    thumbnailsRef.current?.scrollToIndex({ index: current, viewPosition: 0.5, animated: true });
  }, [current]);
  const onSelect = useCallback(
    (index: number) => {
      galleryRef.current?.scrollToOffset({ offset: index * width, animated: true });
      setCurrent(index);
    },
    [width],
  );
  const renderThumbnail = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <GalleryThumbnail
        url={item}
        title={title}
        index={index}
        total={total}
        selected={index === current}
        activeColor={colors.brandPink}
        inactiveColor={colors.divider}
        scrollIndex={scrollIndex}
        styles={styles}
        onSelect={onSelect}
      />
    ),
    [title, total, current, colors.brandPink, colors.divider, scrollIndex, styles, onSelect],
  );

  const onFirstLoad = useCallback((e: ImageLoadEventData) => {
    const next = aspectOf(e);
    if (next) setAspect(Math.min(Math.max(next, MIN_GALLERY_ASPECT), MAX_GALLERY_ASPECT));
  }, []);
  const onOpen = useCallback((index: number) => setViewerUrl(images[index] ?? null), [images]);
  const onCloseViewer = useCallback(() => setViewerUrl(null), []);

  const settle = useCallback(
    (offsetX: number) => {
      setCurrent(Math.min(Math.max(Math.round(offsetX / width), 0), total - 1));
    },
    [width, total],
  );
  const onMomentumScrollEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => settle(e.nativeEvent.contentOffset.x),
    [settle],
  );
  const scrollHandler = useAnimatedScrollHandler({
    onScroll: (event) => {
      scrollIndex.value = Math.round(event.contentOffset.x / width);
    },
    onEndDrag: (event) => {
      // A slow drag can stop exactly on a page without a momentum phase.
      const offset = event.contentOffset.x;
      if (event.velocity?.x === 0 && Math.abs(offset - Math.round(offset / width) * width) < 0.5)
        runOnJS(settle)(offset);
    },
  });

  const getItemLayout = useCallback(
    (_: ArrayLike<string> | null | undefined, index: number) => ({
      length: width,
      offset: width * index,
      index,
    }),
    [width],
  );
  const renderItem = useCallback(
    ({ item, index }: { item: string; index: number }) => (
      <GalleryPage
        url={item}
        index={index}
        total={total}
        width={width}
        height={pageHeight}
        title={title}
        styles={styles}
        onOpen={onOpen}
        onLoad={index === 0 ? onFirstLoad : undefined}
      />
    ),
    [total, width, pageHeight, title, styles, onOpen, onFirstLoad],
  );

  return (
    <View testID="market-product-gallery">
      <View style={[styles.imageWrap, { aspectRatio: aspect ?? 1 }]}>
        <Animated.FlatList
          ref={galleryRef}
          testID="market-product-gallery-pages"
          data={images}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          keyExtractor={galleryKey}
          renderItem={renderItem}
          getItemLayout={getItemLayout}
          extraData={pageHeight}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
          windowSize={3}
          onScroll={scrollHandler}
          scrollEventThrottle={16}
          onMomentumScrollEnd={onMomentumScrollEnd}
        />
        <View style={styles.counter} pointerEvents="none">
          <Text style={styles.counterText} testID="market-product-gallery-counter">
            {current + 1} / {total}
          </Text>
        </View>
      </View>
      <FlatList
        ref={thumbnailsRef}
        data={images}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={galleryKey}
        getItemLayout={getThumbnailLayout}
        renderItem={renderThumbnail}
        extraData={current}
        contentContainerStyle={styles.thumbnails}
        testID="market-product-gallery-thumbnails"
      />
      <FullscreenImageModal url={viewerUrl} urls={images} onClose={onCloseViewer} />
    </View>
  );
};

const MarketProductGallery: React.FC<Props> = ({ image, images, title }) => {
  const colors = useThemeColors();
  const styles = useMemo(() => createMarketProductGalleryStyles(colors), [colors]);
  return images && images.length > 1 ? (
    // Keyed by the image set so a refreshed listing restarts at page one.
    <Gallery key={images.join('\n')} images={images} title={title} styles={styles} />
  ) : (
    <SingleImage key={image} image={image || undefined} title={title} styles={styles} />
  );
};

export default React.memo(MarketProductGallery);
