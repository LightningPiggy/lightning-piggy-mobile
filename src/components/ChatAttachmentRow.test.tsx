import React from 'react';
import ChatAttachmentRow from './ChatAttachmentRow';
import { act, render, waitFor, fireEvent } from '@testing-library/react-native';
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
  'clears and never opens the previous account attachment (encrypted=%s)',
  async (encrypted) => {
    const resolve = jest.mocked(encrypted ? resolveDecryptedMedia : resolveRemoteMedia);
    let finish!: (uri: string) => void;
    resolve.mockResolvedValueOnce('file:///alice/image').mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = done;
        }),
    );
    const onOpen = jest.fn();
    const item = {
      id: 'image',
      messageId: 'message',
      createdAt: 1,
      tab: 'media' as const,
      kind: 'image' as const,
      label: 'image',
      url: 'https://example.com/image',
      image: {
        url: 'https://example.com/image',
        mime: 'image/png',
        encrypted,
        keyHex: 'key',
        nonceHex: 'nonce',
      },
    };
    const view = render(
      <ChatAttachmentRow item={item} autoLoad onOpen={onOpen} onJump={jest.fn()} />,
    );
    await waitFor(() =>
      expect(view.UNSAFE_getByType(Image).props.source.uri).toBe('file:///alice/image'),
    );
    act(() => setActivePubkeyForWalletStorage('bob'));
    expect(view.UNSAFE_queryByType(Image)).toBeNull();
    fireEvent.press(view.getByTestId('chat-attachment-image'));
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => finish('file:///bob/image'));
    fireEvent.press(view.getByTestId('chat-attachment-image'));
    expect(onOpen).toHaveBeenCalledWith('file:///bob/image');
  },
);
