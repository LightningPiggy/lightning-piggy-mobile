import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { Image } from 'expo-image';
import { StyleSheet } from 'react-native';
import MessageImageBubble from './MessageImageBubble';
import { createMessageBubbleStyles } from '../styles/MessageBubble.styles';
import { lightPalette } from '../styles/palettes';
import { setActivePubkeyForWalletStorage } from '../services/walletStorageService';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import { __resetForTests } from '../services/mediaRevealStore';

// A distinct component (not the bare View) so UNSAFE_getByType finds only it.
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

const styles = createMessageBubbleStyles(lightPalette);
const image = (url: string) => ({ url, mime: 'image/png', encrypted: false });
const deferred = () => {
  let resolve!: (uri: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const bubble = (url: string, onOpen: jest.Mock) => (
  <MessageImageBubble
    styles={styles}
    image={image(url)}
    messageId="m1"
    testIdPrefix="conversation"
    fromMe={false}
    autoLoad
    senderLabel={null}
    onOpenImageFullscreen={onOpen}
    // Keeps the pressable enabled so the tap reaches the displayUri guard.
    onLongPress={jest.fn()}
    testID="bubble"
    footer={null}
  />
);

beforeEach(() => {
  jest.clearAllMocks();
  __resetForTests();
  setActivePubkeyForWalletStorage('alice');
});

it('never opens the previous image fullscreen while the next one is loading', async () => {
  const onOpen = jest.fn();
  const second = deferred();
  jest
    .mocked(resolveRemoteMedia)
    .mockResolvedValueOnce('file:///alice/a')
    .mockReturnValueOnce(second.promise);
  const view = render(bubble('https://example.com/a.png', onOpen));
  await waitFor(() =>
    expect(view.UNSAFE_getByType(Image).props.source.uri).toBe('file:///alice/a'),
  );
  fireEvent.press(view.getByTestId('bubble'));
  expect(onOpen).toHaveBeenCalledWith('file:///alice/a');
  onOpen.mockClear();

  view.rerender(bubble('https://example.com/b.png', onOpen));
  fireEvent.press(view.getByTestId('bubble'));
  expect(onOpen).not.toHaveBeenCalled();

  await act(async () => second.resolve('file:///alice/b'));
  fireEvent.press(view.getByTestId('bubble'));
  expect(onOpen).toHaveBeenCalledWith('file:///alice/b');
});

it('forgets the resolved URI when the account changes with unchanged props', async () => {
  const onOpen = jest.fn();
  jest
    .mocked(resolveRemoteMedia)
    .mockResolvedValueOnce('file:///alice/a')
    .mockReturnValueOnce(deferred().promise);
  const view = render(bubble('https://example.com/a.png', onOpen));
  await waitFor(() =>
    expect(view.UNSAFE_getByType(Image).props.source.uri).toBe('file:///alice/a'),
  );
  act(() => setActivePubkeyForWalletStorage('bob'));
  fireEvent.press(view.getByTestId('bubble'));
  expect(onOpen).not.toHaveBeenCalled();
});

it.each([
  ['1200x800', 1.5],
  ['1x1000000', 0.6],
  ['1000000x1', 1.8],
  [undefined, 1],
  ['0x100', 1],
] as const)(
  'keeps the full image footprint before and after reveal (dim=%s)',
  async (dim, aspect) => {
    const pending = deferred();
    jest.mocked(resolveRemoteMedia).mockReturnValueOnce(pending.promise);
    const ui = render(
      <MessageImageBubble
        {...bubble('https://example.com/landscape.png', jest.fn()).props}
        image={{ ...image('https://example.com/landscape.png'), dim }}
        autoLoad={false}
      />,
    );
    const footprint = { width: '100%' as const, aspectRatio: aspect };
    expect(ui.getByTestId('conversation-image-placeholder-m1')).toHaveStyle(footprint);
    expect(resolveRemoteMedia).not.toHaveBeenCalled();
    fireEvent.press(ui.getByTestId('bubble'));
    expect(ui.getByTestId('bubble')).toHaveStyle({ width: 320 });
    await act(async () => pending.resolve('file:///alice/landscape'));
    expect(StyleSheet.flatten(ui.UNSAFE_getByType(Image).props.style)).toEqual(
      expect.objectContaining(footprint),
    );
  },
);

it('keeps blocked images at the same full-width bounded footprint', () => {
  const ui = render(
    <MessageImageBubble
      {...bubble('file:///blocked.png', jest.fn()).props}
      image={{ ...image('file:///blocked.png'), dim: '1200x800' }}
      autoLoad={false}
    />,
  );
  expect(ui.getByTestId('conversation-image-placeholder-m1')).toHaveStyle({
    width: '100%',
    aspectRatio: 1.5,
  });
  expect(ui.getByText('messageBubble.blockedLink')).toBeTruthy();
  fireEvent.press(ui.getByTestId('bubble'));
  expect(resolveRemoteMedia).not.toHaveBeenCalled();
});
