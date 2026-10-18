import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { FlatList } from 'react-native';
import { Image } from 'expo-image';
import MarketProductGallery from './MarketProductGallery';
import FullscreenImageModal from './FullscreenImageModal';

jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => ({
  useTranslation: () => (key: string, params?: { current: number; total: number }) =>
    key === 'imageGallery.open'
      ? 'Open image'
      : key === 'imageGallery.showImage'
        ? `Show image ${params?.current} of ${params?.total}`
        : key,
}));
jest.mock('react-native-reanimated', () => ({
  __esModule: true,
  useSharedValue: (value: number) => ({ value }),
  useAnimatedStyle: (style: () => object) => style(),
  useAnimatedScrollHandler: (handlers: object) => handlers,
  runOnJS: (fn: unknown) => fn,
  default: {
    View: jest.requireActual<typeof import('react-native')>('react-native').View,
    FlatList: jest.requireActual<typeof import('react-native')>('react-native').FlatList,
  },
}));
jest.mock('./FullscreenImageModal', () => jest.fn(() => null));

beforeEach(() => jest.clearAllMocks());

it.each([undefined, ['https://example.com/product.jpg']])(
  'opens a lone product image in the zoomable single-image viewer (%j)',
  (images) => {
    const image = 'https://example.com/product.jpg';
    const view = render(<MarketProductGallery image={image} images={images} title="Piggy" />);
    expect(view.queryByTestId('market-product-gallery-thumbnails')).toBeNull();
    const hero = view.getByTestId('market-product-image-open');
    expect(hero.props.accessibilityRole).toBe('imagebutton');
    expect(hero.props.accessibilityLabel).toBe('Open image');
    fireEvent.press(hero);
    const props = jest.mocked(FullscreenImageModal).mock.calls.at(-1)![0];
    expect(props.url).toBe(image);
    expect(props.urls).toBeUndefined();
    fireEvent(view.UNSAFE_getByType(FullscreenImageModal), 'close');
    expect(jest.mocked(FullscreenImageModal).mock.calls.at(-1)![0].url).toBeNull();
  },
);

it('does not open a missing or failed image', () => {
  const view = render(<MarketProductGallery image="" title="Piggy" />);
  expect(view.queryByTestId('market-product-image-open')).toBeNull();
  view.rerender(<MarketProductGallery image="https://example.com/broken.jpg" title="Piggy" />);
  fireEvent(view.UNSAFE_getByType(Image), 'error');
  expect(view.queryByTestId('market-product-image-open')).toBeNull();
  expect(view.getByText('P')).toBeTruthy();
});

const images = ['https://example.com/first.jpg', 'https://example.com/second.jpg'];

it('renders thumbnails and selects the tapped image, updating the counter and both lists', () => {
  const scrollToOffset = jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation();
  const scrollToIndex = jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation();
  const view = render(<MarketProductGallery image={images[0]} images={images} title="Piggy" />);
  expect(view.getByText('1 / 2')).toBeTruthy();
  expect(view.getByTestId('market-product-gallery-thumb-0').props.accessibilityState.selected).toBe(
    true,
  );
  const second = view.getByTestId('market-product-gallery-thumb-1');
  expect(second.props.accessibilityRole).toBe('button');
  expect(second.props.accessibilityLabel).toBe('Show image 2 of 2');
  expect(second.props.accessibilityState.selected).toBe(false);
  fireEvent.press(second);
  expect(view.getByText('2 / 2')).toBeTruthy();
  expect(view.getByTestId('market-product-gallery-thumb-0').props.accessibilityState.selected).toBe(
    false,
  );
  expect(view.getByTestId('market-product-gallery-thumb-1').props.accessibilityState.selected).toBe(
    true,
  );
  expect(scrollToOffset).toHaveBeenCalledWith({ offset: expect.any(Number), animated: true });
  expect(scrollToIndex).toHaveBeenLastCalledWith({ index: 1, viewPosition: 0.5, animated: true });
  scrollToOffset.mockRestore();
  scrollToIndex.mockRestore();
});

it('updates thumbnail selection after swiping the main gallery', () => {
  const view = render(<MarketProductGallery image={images[0]} images={images} title="Piggy" />);
  const pages = view.getByTestId('market-product-gallery-pages');
  const width = pages.props.getItemLayout(images, 0).length;
  fireEvent(pages, 'momentumScrollEnd', { nativeEvent: { contentOffset: { x: width } } });
  expect(view.getByText('2 / 2')).toBeTruthy();
  expect(view.getByTestId('market-product-gallery-thumb-1').props.accessibilityState.selected).toBe(
    true,
  );
});

it('shows a miniature title initial when a thumbnail fails', () => {
  const view = render(<MarketProductGallery image={images[0]} images={images} title="Piggy" />);
  const thumb = view.getByTestId('market-product-gallery-thumb-1');
  fireEvent(thumb.findByType(Image), 'error');
  expect(view.getByText('P')).toBeTruthy();
  fireEvent.press(thumb);
  expect(view.getByText('2 / 2')).toBeTruthy();
});
