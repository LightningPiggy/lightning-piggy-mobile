import { setRemoteMediaOwner } from '../services/remoteMediaCache';
import { setDecryptedMediaOwner } from '../services/decryptedMediaCache';
import { setActivePubkeyForWalletStorage } from '../services/walletStorageService';
import React from 'react';
import { act, render } from '@testing-library/react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { useAudioPlayer } from 'expo-audio';
import DecryptedImage from './DecryptedImage';
import VoiceNotePlayer from './VoiceNotePlayer';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-image', () => ({ Image: jest.requireActual('react-native').View }));
jest.mock('expo-audio', () => ({
  useAudioPlayer: jest.fn(() => ({ play: jest.fn(), pause: jest.fn(), seekTo: jest.fn() })),
  useAudioPlayerStatus: () => ({}),
  setAudioModeAsync: jest.fn(),
}));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
  useTranslation: () => (key: string) => key,
}));
jest.mock('../hooks/useTapToReveal', () => ({ useTapToReveal: () => [true, jest.fn()] }));
jest.mock('../utils/messageContent', () => ({ formatTime: () => '00:00' }));
jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  makeDirectoryAsync: jest.fn(async () => {}),
  moveAsync: jest.fn(async () => {}),
  deleteAsync: jest.fn(async () => {}),
  readDirectoryAsync: jest.fn(async () => []),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
  writeAsStringAsync: jest.fn(async () => {}),
}));
const mockFetch = expoFetch as unknown as jest.Mock;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  // Match NostrContext's account publication and media-cache layout effects.
  setActivePubkeyForWalletStorage('reader');
  setDecryptedMediaOwner('reader');
  setRemoteMediaOwner('reader');
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it.each([false, true])(
  'blocked image renders a placeholder without fetching (encrypted=%s)',
  async (encrypted) => {
    const view = render(
      <DecryptedImage
        url="https://127.0.0.1/image.jpg"
        encrypted={encrypted}
        keyHex="a"
        nonceHex="b"
      />,
    );
    await act(async () => {});
    expect(view.getByText('messageBubble.blockedLink')).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  'blocked voice never fetches or reaches the native player (encrypted=%s)',
  async (encrypted) => {
    const view = render(
      <VoiceNotePlayer
        url="https://127.0.0.1/voice.mp4"
        encrypted={encrypted}
        fromMe={false}
        createdAt={0}
        autoLoad
      />,
    );
    await act(async () => {});
    expect(view.getByText('messageBubble.blockedLink')).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(useAudioPlayer).toHaveBeenCalledWith(undefined);
  },
);
it('accepted plain images are fetched with the shared policy and render a local URI', async () => {
  let sent = false;
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          if (sent) return { done: true };
          sent = true;
          return { done: false, value: new Uint8Array([1, 2, 3]) };
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  });
  const onResolved = jest.fn();
  const view = render(
    <DecryptedImage
      url="https://example.com/image.jpg"
      encrypted={false}
      onResolved={onResolved}
      accessibilityLabel="Downloaded image"
    />,
  );
  await act(async () => {});
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(onResolved).toHaveBeenCalledWith(
    expect.stringMatching(/^file:\/\/\/cache\/remote-media-/),
  );
  expect(view.getByLabelText('Downloaded image').props.source.uri).toBe(
    onResolved.mock.calls[0][0],
  );
  expect(view.getByLabelText('Downloaded image').props.cachePolicy).toBe('memory');
});
