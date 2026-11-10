import type { ListViewToken as ViewToken } from 'react-native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlatList } from 'react-native';
import type { WalletState } from '../types/wallet';
import { CAROUSEL_INTERVAL } from '../styles/WalletCarousel.styles';
import { markWalletSwipeSettled, markWalletSwitchRequested } from '../utils/walletSwipeTiming';

export type CarouselItem = { type: 'wallet'; wallet: WalletState } | { type: 'add' };

export function useWalletCarousel(
  wallets: WalletState[],
  activeWalletId: string | null,
  onWalletChange: (id: string | null) => void,
  onAddCardActiveChange?: (active: boolean) => void,
) {
  const data = useMemo<CarouselItem[]>(
    () => [...wallets.map((wallet): CarouselItem => ({ type: 'wallet', wallet })), { type: 'add' }],
    [wallets],
  );
  const initialIndex = Math.max(
    0,
    wallets.findIndex((wallet) => wallet.id === activeWalletId),
  );
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const indexRef = useRef(initialIndex);
  const selectedKey = useRef(carouselItemKey(data[initialIndex]));
  const selectionReported = useRef(false);
  const walletOrder = useMemo(() => wallets.map((wallet) => wallet.id).join(','), [wallets]);
  const dragging = useRef(false);
  const pendingIndex = useRef<number | null>(null);
  const previousWalletCount = useRef(wallets.length);
  const flatListRef = useRef<FlatList<CarouselItem>>(null);
  // Native viewability requires a stable callback, with the latest wallet data.
  const latest = useRef({ data, onWalletChange, onAddCardActiveChange });
  latest.current = { data, onWalletChange, onAddCardActiveChange };

  const selectIndex = useCallback((index: number) => {
    const item = latest.current.data[index];
    if (
      !item ||
      (selectionReported.current &&
        indexRef.current === index &&
        selectedKey.current === carouselItemKey(item))
    )
      return;
    selectionReported.current = true;
    selectedKey.current = carouselItemKey(item);
    indexRef.current = index;
    setCurrentIndex(index);
    latest.current.onAddCardActiveChange?.(item.type === 'add');
    // The add page preserves the last wallet for Send / Receive (#166).
    if (item.type === 'wallet') {
      markWalletSwitchRequested(item.wallet.id);
      latest.current.onWalletChange(item.wallet.id);
    }
  }, []);

  // Programmatic jump (Add wallet, external selection, an import replacing the
  // add page). Commits the destination now so passing cards never select.
  const scrollToIndex = useCallback(
    (index: number) => {
      pendingIndex.current = index;
      selectIndex(index);
      flatListRef.current?.scrollToOffset({ offset: index * CAROUSEL_INTERVAL, animated: true });
    },
    [selectIndex],
  );

  const onViewableItemsChanged = useCallback(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const index = viewableItems.find((item) => item.isViewable)?.index;
      if (index == null) return;
      // Viewability is only for initial hydration. Never commit wallets mid-fling.
      if (dragging.current || selectionReported.current) return;
      // A programmatic jump can pass several wallets. Keep its destination selected.
      if (pendingIndex.current !== null && index !== pendingIndex.current) return;
      selectIndex(index);
    },
    [selectIndex],
  );

  const onScrollBeginDrag = useCallback(() => {
    pendingIndex.current = null;
    dragging.current = true;
  }, []);
  const onMomentumScrollEnd = useCallback(
    (event: { nativeEvent: { contentOffset: { x: number } } }) => {
      const index = Math.round(event.nativeEvent.contentOffset.x / CAROUSEL_INTERVAL);
      if (pendingIndex.current !== null && index !== pendingIndex.current) return;
      pendingIndex.current = null;
      dragging.current = false;
      selectIndex(index);
      const item = latest.current.data[index];
      if (item?.type === 'wallet') markWalletSwipeSettled(item.wallet.id);
    },
    [selectIndex],
  );

  // Wallets added, removed, reordered or selected outside the carousel also
  // move the card. A balance refresh alone never moves it off the add page.
  useEffect(() => {
    // Importing a wallet replaces the selected add page at the same offset.
    // Select it even when the wallet context still points at the previous one.
    const previousCount = previousWalletCount.current;
    previousWalletCount.current = wallets.length;
    if (
      previousCount > 0 &&
      wallets.length > previousCount &&
      selectedKey.current === 'add' &&
      latest.current.data[indexRef.current]?.type === 'wallet'
    ) {
      scrollToIndex(indexRef.current);
      return;
    }
    const index = latest.current.data.findIndex(
      (item) => item.type === 'wallet' && item.wallet.id === activeWalletId,
    );
    if (index >= 0 && (index !== indexRef.current || selectedKey.current !== activeWalletId))
      scrollToIndex(index);
  }, [walletOrder, wallets.length, activeWalletId, scrollToIndex]);

  const snapToOffsets = useMemo(
    () => Array.from({ length: wallets.length + 1 }, (_, index) => index * CAROUSEL_INTERVAL),
    [wallets.length],
  );
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  return {
    data,
    currentIndex,
    initialIndex,
    flatListRef,
    snapToOffsets,
    viewabilityConfig,
    scrollToIndex,
    onViewableItemsChanged,
    onScrollBeginDrag,
    onMomentumScrollEnd,
  };
}

export const carouselItemKey = (item: CarouselItem) =>
  item.type === 'wallet' ? item.wallet.id : 'add';
export const carouselItemLayout = (_: unknown, index: number) => ({
  length: CAROUSEL_INTERVAL,
  offset: CAROUSEL_INTERVAL * index,
  index,
});
