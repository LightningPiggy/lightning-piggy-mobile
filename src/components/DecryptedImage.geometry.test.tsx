import React from 'react';
import { render } from '@testing-library/react-native';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import DecryptedImage from './DecryptedImage';
import { useImageMediaUri } from '../hooks/useImageMediaUri';

jest.mock('../hooks/useImageMediaUri', () => ({ useImageMediaUri: jest.fn() }));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
  useTranslation: () => (key: string) => key,
}));
jest.mock('expo-image', () => ({
  Image: (props: object) =>
    jest.requireActual('react').createElement(jest.requireActual('react-native').View, props),
}));

it.each([
  ['blocked', 'file:///blocked', null, false],
  ['loading', 'https://example.com/image', null, false],
  ['failed', 'https://example.com/image', null, true],
  ['loaded', 'https://example.com/image', 'file:///cached', false],
] as const)('preserves the supplied image footprint when %s', (_state, url, uri, failed) => {
  jest.mocked(useImageMediaUri).mockReturnValue({ uri, failed });
  const footprint = { width: '100%' as const, aspectRatio: 1.5 };
  const ui = render(<DecryptedImage url={url} encrypted={false} style={footprint} />);
  const media = uri ? ui.UNSAFE_getByType(Image) : ui.UNSAFE_getAllByType(View)[0];
  expect(StyleSheet.flatten(media.props.style)).toEqual(expect.objectContaining(footprint));
});
