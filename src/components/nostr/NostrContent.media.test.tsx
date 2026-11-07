import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import { fetch as expoFetch } from 'expo/fetch';
import { setRemoteMediaOwner } from '../../services/remoteMediaCache';
import NostrContent from './NostrContent';

jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));
jest.mock('expo-image', () => ({ Image: jest.requireActual('react-native').View }));
jest.mock('../../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../../styles/palettes').lightPalette,
}));
jest.mock('../../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key }),
  useTranslation: () => (key: string) => key,
}));
jest.mock('../../hooks/useFollowedPubkeys', () => ({ useIsTrustedAuthor: () => true }));
jest.mock('../../hooks/useTapToReveal', () => ({ useTapToReveal: () => [true, jest.fn()] }));
jest.mock('../../hooks/useActivePubkey', () => ({ useActivePubkey: () => 'reader' }));
jest.mock('./MentionChip', () => () => null);
jest.mock('./EmbeddedEventCard', () => () => null);
jest.mock('../FullscreenImageModal', () => () => null);
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
// One URL per test: the media cache dedupes in-flight downloads by URL at module level.
const IMAGE = 'https://image.example.com/photo.jpg';
const SLOW_IMAGE = 'https://image.example.com/slow.jpg';
const ok = () => {
  let sent = false;
  return {
    status: 200,
    ok: true,
    redirected: false,
    url: IMAGE,
    headers: new Headers({ 'content-length': '3' }),
    body: {
      getReader: () => ({
        read: async () =>
          sent
            ? { done: true, value: undefined }
            : ((sent = true), { done: false, value: new Uint8Array([1, 2, 3]) }),
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
};
const settle = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {});
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  setRemoteMediaOwner('reader');
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('shows a spinner while an inline image downloads', async () => {
  mockFetch.mockReturnValue(new Promise(() => undefined));
  const view = render(<NostrContent content={SLOW_IMAGE} authorPubkey="author" />);
  await settle();
  expect(view.getByTestId('nostr-inline-image-loading-0')).toBeTruthy();
  expect(view.queryByTestId('nostr-inline-image-failed-0')).toBeNull();
  // Screen readers hear that it's loading, and it isn't actionable yet.
  const tile = view.getByTestId('nostr-inline-image-0');
  expect(tile.props.accessibilityLabel).toBe('messageBubble.loading');
  expect(tile.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
});

it('retries a failed inline image once by itself, then offers tap to retry', async () => {
  // First download fails; the automatic retry's download is held open so
  // the moment it starts can be checked, then it fails too.
  let failRetry: (e: Error) => void = () => {};
  mockFetch
    .mockRejectedValueOnce(new Error('network down'))
    .mockReturnValueOnce(new Promise((_, reject) => (failRetry = reject)))
    .mockRejectedValue(new Error('network down'));
  const view = render(<NostrContent content={IMAGE} authorPubkey="author" />);
  await settle();
  expect(mockFetch).toHaveBeenCalledTimes(1);
  // During the pause before the automatic retry it still reads as loading.
  expect(view.getByTestId('nostr-inline-image-loading-0')).toBeTruthy();
  expect(view.queryByTestId('nostr-inline-image-failed-0')).toBeNull();
  // One automatic retry after a short pause.
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  // While the automatic retry is in flight, the old failure must not show.
  expect(mockFetch).toHaveBeenCalledTimes(2);
  expect(view.queryByTestId('nostr-inline-image-failed-0')).toBeNull();
  expect(view.getByTestId('nostr-inline-image-loading-0')).toBeTruthy();
  await act(async () => failRetry(new Error('network down')));
  await settle();
  expect(mockFetch).toHaveBeenCalledTimes(2);
  // Still failing: say so instead of a silent empty box, and stop retrying.
  expect(view.getByTestId('nostr-inline-image-failed-0')).toBeTruthy();
  await act(async () => {
    jest.advanceTimersByTime(10_000);
  });
  await settle();
  expect(mockFetch).toHaveBeenCalledTimes(2);
  // A tap retries; this time it loads.
  mockFetch.mockResolvedValue(ok());
  fireEvent.press(view.getByTestId('nostr-inline-image-0'));
  // Download, cache write and render take several ticks: wait for the box to clear.
  const busy = () =>
    view.queryByTestId('nostr-inline-image-failed-0') ||
    view.queryByTestId('nostr-inline-image-loading-0');
  for (let i = 0; i < 20 && busy(); i++) await settle();
  expect(mockFetch).toHaveBeenCalledTimes(3);
  expect(view.queryByTestId('nostr-inline-image-failed-0')).toBeNull();
  expect(view.queryByTestId('nostr-inline-image-loading-0')).toBeNull();
});
