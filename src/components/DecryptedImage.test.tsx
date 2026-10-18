import React from 'react';
import DecryptedImage from './DecryptedImage';
import { act, render, waitFor } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { setActivePubkeyForWalletStorage } from '../services/walletStorageService';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import { resolveDecryptedMedia } from '../services/decryptedMediaCache';

jest.mock('expo-image', () => ({
  Image: (props: object) =>
    jest.requireActual('react').createElement(jest.requireActual('react-native').View, props),
}));
jest.mock('../services/remoteMediaCache', () => ({ resolveRemoteMedia: jest.fn() }));
jest.mock('../services/decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
  peekDecryptedMedia: jest.fn(() => null),
  resolveDecryptedMedia: jest.fn(),
  DecryptedMediaCancelledError: class extends Error {},
}));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
  useTranslation: () => (key: string) => key,
}));
beforeEach(() => {
  jest.clearAllMocks();
  setActivePubkeyForWalletStorage('alice');
});
it.each([false, true])(
  'clears the previous account image with unchanged props (encrypted=%s)',
  async (encrypted) => {
    const resolve = jest.mocked(encrypted ? resolveDecryptedMedia : resolveRemoteMedia);
    let finish!: (uri: string) => void;
    resolve.mockResolvedValueOnce('file:///alice/image').mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const view = render(
      <DecryptedImage
        url="https://example.com/image"
        encrypted={encrypted}
        keyHex="key"
        nonceHex="nonce"
      />,
    );
    await waitFor(() =>
      expect(view.UNSAFE_getByType(Image).props.source.uri).toBe('file:///alice/image'),
    );
    act(() => setActivePubkeyForWalletStorage('bob'));
    expect(view.UNSAFE_queryByType(Image)).toBeNull();
    await act(async () => finish('file:///bob/image'));
    expect(view.UNSAFE_getByType(Image).props.source.uri).toBe('file:///bob/image');
  },
);
