import type { ListViewToken as ViewToken } from 'react-native';
import { act, renderHook } from '@testing-library/react-native';
import type { FlatList, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { WalletState } from '../types/wallet';
import { useWalletCarousel, type CarouselItem } from './useWalletCarousel';
import { CAROUSEL_INTERVAL } from '../styles/WalletCarousel.styles';

jest.mock('../utils/walletSwipeTiming', () => ({
  markWalletSwipeSettled: jest.fn(),
  markWalletSwitchRequested: jest.fn(),
}));

const wallets = ['first', 'second', 'third', 'fourth'].map(
  (id) => ({ id, balance: 0 }) as WalletState,
);
const visible = (index: number) => ({ viewableItems: [{ index, isViewable: true } as ViewToken] });

it('keeps a programmatic jump destination selected while intermediate cards pass, then resumes swipes', () => {
  const change = jest.fn();
  const { result } = renderHook(() => useWalletCarousel(wallets, 'first', change));
  act(() => result.current.scrollToIndex(3));
  act(() => result.current.onViewableItemsChanged(visible(1)));
  expect(result.current.currentIndex).toBe(3);
  expect(change.mock.calls).toEqual([['fourth']]);
  act(() =>
    result.current.onMomentumScrollEnd({
      nativeEvent: { contentOffset: { x: CAROUSEL_INTERVAL } },
    } as NativeSyntheticEvent<NativeScrollEvent>),
  );
  expect(result.current.currentIndex).toBe(3);
  act(() => result.current.onViewableItemsChanged(visible(3)));
  expect(change).toHaveBeenCalledTimes(1);
  act(() => result.current.onScrollBeginDrag());
  act(() => result.current.onViewableItemsChanged(visible(2)));
  expect(result.current.currentIndex).toBe(3);
  act(() =>
    result.current.onMomentumScrollEnd({
      nativeEvent: { contentOffset: { x: CAROUSEL_INTERVAL * 2 } },
    } as NativeSyntheticEvent<NativeScrollEvent>),
  );
  expect(result.current.currentIndex).toBe(2);
  expect(change).toHaveBeenLastCalledWith('third');
});

it('preserves the add page and active wallet through balance updates', () => {
  const change = jest.fn();
  const addChange = jest.fn();
  const { result, rerender } = renderHook(
    ({ data }: { data: WalletState[] }) => useWalletCarousel(data, 'first', change, addChange),
    {
      initialProps: { data: wallets },
    },
  );
  act(() => result.current.scrollToIndex(4));
  rerender({ data: wallets.map((wallet) => ({ ...wallet, balance: 10 })) });
  expect(result.current.currentIndex).toBe(4);
  expect(change).not.toHaveBeenCalled();
  expect(addChange.mock.calls).toEqual([[true]]);
  act(() => result.current.scrollToIndex(0));
  expect(addChange).toHaveBeenLastCalledWith(false);
  expect(change).toHaveBeenLastCalledWith('first');
});

it('follows external selection and handles a wallet replacing the add page at the same index', () => {
  const change = jest.fn();
  const addChange = jest.fn();
  const { result, rerender } = renderHook(
    ({ data, active }: { data: WalletState[]; active: string }) =>
      useWalletCarousel(data, active, change, addChange),
    {
      initialProps: { data: wallets, active: 'first' },
    },
  );
  rerender({ data: wallets, active: 'third' });
  expect(result.current.currentIndex).toBe(2);
  act(() => result.current.scrollToIndex(4));
  rerender({ data: [...wallets, { id: 'new' } as WalletState], active: 'new' });
  expect(result.current.currentIndex).toBe(4);
  expect(addChange).toHaveBeenLastCalledWith(false);
  expect(change).toHaveBeenLastCalledWith('new');
});

it('returns to the active wallet when a wallet is removed from the add page', () => {
  const { result, rerender } = renderHook(
    ({ data }: { data: WalletState[] }) => useWalletCarousel(data, 'first', jest.fn()),
    { initialProps: { data: wallets } },
  );
  const scrollToOffset = jest.fn();
  result.current.flatListRef.current = { scrollToOffset } as unknown as FlatList<CarouselItem>;
  act(() => result.current.scrollToIndex(4));
  expect(scrollToOffset).toHaveBeenLastCalledWith({
    offset: 4 * CAROUSEL_INTERVAL,
    animated: true,
  });
  rerender({ data: wallets.slice(0, 3) });
  expect(result.current.currentIndex).toBe(0);
  expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: true });
});

it('selects an imported wallet that replaces the add page before context selection changes', () => {
  const change = jest.fn();
  const addChange = jest.fn();
  const { result, rerender } = renderHook(
    ({ data }: { data: WalletState[] }) => useWalletCarousel(data, 'first', change, addChange),
    { initialProps: { data: wallets } },
  );
  act(() => result.current.scrollToIndex(4));
  rerender({ data: [...wallets, { id: 'imported' } as WalletState] });
  expect(result.current.currentIndex).toBe(4);
  expect(change).toHaveBeenLastCalledWith('imported');
  expect(addChange).toHaveBeenLastCalledWith(false);
});

it('restores an active wallet after empty hydration without treating it as an import', () => {
  const change = jest.fn();
  const { result, rerender } = renderHook(
    ({ data, active }: { data: WalletState[]; active: string | null }) =>
      useWalletCarousel(data, active, change),
    { initialProps: { data: [] as WalletState[], active: null as string | null } },
  );
  rerender({ data: wallets, active: 'third' });
  expect(result.current.currentIndex).toBe(2);
  expect(change).toHaveBeenLastCalledWith('third');
});

it('keeps the committed wallet stable when a drag interrupts a programmatic jump', () => {
  const change = jest.fn();
  const { result } = renderHook(() => useWalletCarousel(wallets, 'first', change));
  act(() => result.current.scrollToIndex(3));
  act(() => result.current.onViewableItemsChanged(visible(1)));
  act(() => result.current.onScrollBeginDrag());
  expect(result.current.currentIndex).toBe(3);
  act(() =>
    result.current.onMomentumScrollEnd({
      nativeEvent: { contentOffset: { x: CAROUSEL_INTERVAL } },
    } as NativeSyntheticEvent<NativeScrollEvent>),
  );
  expect(result.current.currentIndex).toBe(1);
  expect(change).toHaveBeenLastCalledWith('second');
});

it('reports the initial card once so the parent clears a previously selected add page', () => {
  const change = jest.fn();
  const addChange = jest.fn();
  const { result } = renderHook(() => useWalletCarousel(wallets, 'first', change, addChange));
  act(() => result.current.onViewableItemsChanged(visible(0)));
  act(() => result.current.onViewableItemsChanged(visible(0)));
  expect(addChange.mock.calls).toEqual([[false]]);
  expect(change.mock.calls).toEqual([['first']]);
});

it('commits only the final wallet after a fling passes several cards', () => {
  const change = jest.fn();
  const { result } = renderHook(() => useWalletCarousel(wallets, 'first', change));
  act(() => result.current.onViewableItemsChanged(visible(0)));
  change.mockClear();
  act(() => result.current.onScrollBeginDrag());
  for (const index of [1, 2, 3]) {
    act(() => result.current.onViewableItemsChanged(visible(index)));
    expect(result.current.currentIndex).toBe(0);
  }
  expect(change).not.toHaveBeenCalled();
  act(() =>
    result.current.onMomentumScrollEnd({
      nativeEvent: { contentOffset: { x: CAROUSEL_INTERVAL * 3 } },
    }),
  );
  expect(result.current.currentIndex).toBe(3);
  expect(change.mock.calls).toEqual([['fourth']]);
});
