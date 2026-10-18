import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { LinearGradient } from 'expo-linear-gradient';
import MessageBubble from './MessageBubble';
import DecryptedImage from './DecryptedImage';
import { parseFileAttachment } from '../utils/fileAttachment';
import type { BubbleContent } from '../utils/messageContent';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import { __resetForTests } from '../services/mediaRevealStore';

jest.mock('../services/remoteMediaCache', () => ({ resolveRemoteMedia: jest.fn() }));

jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key, formatLocale: 'en' }),
  useTranslation: () => (key: string) => key,
}));
jest.mock('../services/boltzService', () => ({ isBitcoinAddress: () => false }));
jest.mock('./LinkifiedText', () => ({
  LinkifiedText: ({ text }: { text: string }) =>
    jest.requireActual('react').createElement(jest.requireActual('react-native').Text, null, text),
}));
jest.mock('./MessageSharedListing', () => ({
  __esModule: true,
  default: ({
    token,
    autoLoadMedia,
  }: {
    token: { identifier: string; relays: string[] };
    autoLoadMedia: boolean;
  }) =>
    jest.requireActual('react').createElement(jest.requireActual('react-native').View, {
      testID: `listing-${token.identifier}`,
      autoLoadMedia,
      relays: token.relays,
    }),
}));
jest.mock('./LibreMiniMap', () => () => null);
jest.mock('./MessageLinkPreview', () => () => null);
jest.mock('./MessageInvoiceActions', () => () => null);
jest.mock('expo-audio', () => ({
  useAudioPlayer: () => ({ play: jest.fn(), pause: jest.fn() }),
  useAudioPlayerStatus: () => ({ playing: false, duration: 10, currentTime: 0 }),
  setAudioModeAsync: jest.fn(),
}));
jest.mock('../services/decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
  resolveDecryptedMedia: jest.fn(),
}));
jest.mock('./DecryptedImage', () => () => null);

beforeEach(() => {
  __resetForTests();
  jest.mocked(resolveRemoteMedia).mockClear();
  jest.mocked(resolveRemoteMedia).mockResolvedValue('file:///cache/animation.gif');
});

const props = {
  id: 'msg',
  fromMe: true,
  createdAt: 1,
  autoLoadMedia: true,
  testIdPrefix: 'conversation',
  onPayInvoice: jest.fn(),
  onPayLightningAddress: jest.fn(),
  onOpenContact: jest.fn(),
  onOpenLocation: jest.fn(),
};
const variants: [string, BubbleContent][] = [
  ['text', { kind: 'text', text: 'Hello' }],
  [
    'invoice',
    { kind: 'text', text: 'lnbc10n1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' },
  ],
  ['secret card', { kind: 'text', text: 'secretthreewords' }],
  ['voice note', { kind: 'text', text: 'https://example.com/voice.m4a' }],
  ['image', { kind: 'text', text: 'https://example.com/photo.png' }],
  ['lightning address', { kind: 'text', text: 'lightning:sender@example.com' }],
  [
    'live location',
    {
      kind: 'liveLocationMarker',
      marker: {
        phase: 'start',
        sessionId: 'session',
        durationMs: 60000,
        startedAt: 1,
        location: { lat: 1, lon: 2, accuracyMeters: null },
      },
    },
  ],
  ['gif', { kind: 'gif', url: 'https://example.com/image.gif' }],
  [
    'poll',
    {
      kind: 'poll',
      poll: {
        question: 'Pick',
        options: [{ id: '1', label: 'One' }],
        pollType: 'singlechoice',
      },
    },
  ],
  ['location', { kind: 'location', location: { lat: 1, lon: 2, accuracyMeters: null } }],
];

test.each(variants)(
  'outgoing %s renders the default diagonal gradient',
  async (_label, content) => {
    const ui = render(<MessageBubble {...props} content={content} />);
    const gradient = ui.UNSAFE_getByType(LinearGradient);
    expect(gradient.props.colors).toEqual(['#EC008C', '#8B5CF6']);
    // Mostly pink: purple only towards the bottom-right corner.
    expect(gradient.props.locations).toEqual([0.55, 1]);
    expect(gradient.props.start).toEqual({ x: 0, y: 0 });
    expect(gradient.props.end).toEqual({ x: 1, y: 1 });
    await act(async () => {});
  },
);

test('received text keeps its plain surface; reaction pills still toggle', () => {
  const onToggleReaction = jest.fn();
  const ui = render(
    <MessageBubble
      {...props}
      fromMe={false}
      content={{ kind: 'text', text: 'Hi' }}
      reactions={{ byEmoji: { '❤': ['sender'] }, myReactions: {} }}
      onToggleReaction={onToggleReaction}
    />,
  );
  expect(ui.UNSAFE_queryByType(LinearGradient)).toBeNull();
  fireEvent.press(ui.getByTestId('conversation-reaction-msg-❤'));
  expect(onToggleReaction).toHaveBeenCalledWith('❤', null);
});

test.each([true, false])('file replies preserve their header and actions (fromMe=%s)', (fromMe) => {
  const onLongPress = jest.fn();
  const onToggleReaction = jest.fn();
  const ui = render(
    <MessageBubble
      {...props}
      fromMe={fromMe}
      senderName={fromMe ? undefined : 'Curious Fox'}
      content={{
        kind: 'file',
        file: parseFileAttachment(
          '[FILE]' +
            JSON.stringify({
              url: '',
              name: 'Invoice.pdf',
              mime: 'application/pdf',
              encrypted: true,
            }),
        )!,
      }}
      quote={{ text: 'Please send the invoice', fromMe: false, authorName: 'Parent author' }}
      onLongPress={onLongPress}
      reactions={{ byEmoji: { '❤': ['sender'] }, myReactions: {} }}
      onToggleReaction={onToggleReaction}
    />,
  );
  expect(ui.getByTestId('conversation-quote-msg')).toBeTruthy();
  expect(ui.getByText('Please send the invoice')).toBeTruthy();
  expect(ui.getByText('Parent author')).toBeTruthy();
  if (!fromMe) expect(ui.getByText('Curious Fox')).toBeTruthy();
  fireEvent(ui.getByTestId('chat-file-bubble-msg'), 'longPress');
  expect(onLongPress).toHaveBeenCalledTimes(1);
  fireEvent.press(ui.getByTestId('conversation-reaction-msg-❤'));
  expect(onToggleReaction).toHaveBeenCalledWith('❤', null);
});

test('an unfollowed sender GIF waits for the placeholder tap before downloading', async () => {
  const openFullscreen = jest.fn();
  const ui = render(
    <MessageBubble
      {...props}
      fromMe={false}
      autoLoadMedia={false}
      content={{ kind: 'gif', url: 'https://example.com/animation.gif' }}
      onOpenGifFullscreen={openFullscreen}
    />,
  );
  await act(async () => {});
  expect(ui.getByTestId('conversation-gif-tap-to-load-msg')).toBeTruthy();
  expect(resolveRemoteMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByTestId('conversation-gif-msg'));
  await waitFor(() => expect(ui.queryByTestId('conversation-gif-tap-to-load-msg')).toBeNull());
  await waitFor(() => expect(resolveRemoteMedia).toHaveBeenCalledTimes(1));
  expect(openFullscreen).not.toHaveBeenCalled();
  await act(async () => {});
  fireEvent.press(ui.getByTestId('conversation-gif-msg'));
  expect(openFullscreen).toHaveBeenCalledWith('file:///cache/animation.gif');
});

test.each([true, false])(
  'shared listings pass sender trust to the card (sender trust=%s)',
  (autoLoadMedia) => {
    const { naddrEncode } = jest.requireActual('nostr-tools/nip19');
    const hints = ['wss://sender-hint.example'];
    const ref = (identifier: string) =>
      naddrEncode({
        kind: 30402,
        pubkey: 'a'.repeat(64),
        identifier,
        relays: hints,
      });
    const ui = render(
      <MessageBubble
        {...props}
        autoLoadMedia={autoLoadMedia}
        content={{
          kind: 'text',
          text: `Scam warning\nSender title\nnostr:${ref('first')}\nDo not buy\nnostr:${ref('second')}\nAfterword`,
        }}
      />,
    );
    expect(ui.getByText('Scam warning\nSender title')).toBeTruthy();
    expect(ui.getByText('Do not buy')).toBeTruthy();
    expect(ui.getByText('Afterword')).toBeTruthy();
    expect(ui.getByTestId('listing-first').props.autoLoadMedia).toBe(autoLoadMedia);
    expect(ui.getByTestId('listing-second').props.autoLoadMedia).toBe(autoLoadMedia);
    expect(ui.getByTestId('listing-first').props.relays).toEqual(hints);
    expect(ui.getByTestId('listing-second').props.relays).toEqual(hints);
  },
);

test('an unfollowed sender photo waits for a tap before mounting the image loader', async () => {
  const ui = render(
    <MessageBubble
      {...props}
      fromMe={false}
      autoLoadMedia={false}
      content={{ kind: 'text', text: 'https://example.com/photo.png' }}
    />,
  );
  await act(async () => {});
  expect(ui.getByTestId('conversation-image-placeholder-msg')).toBeTruthy();
  expect(ui.UNSAFE_queryByType(DecryptedImage)).toBeNull();
  expect(resolveRemoteMedia).not.toHaveBeenCalled();
  fireEvent.press(ui.getByTestId('conversation-image-msg'));
  expect(ui.queryByTestId('conversation-image-placeholder-msg')).toBeNull();
  expect(ui.UNSAFE_getByType(DecryptedImage).props.url).toBe('https://example.com/photo.png');
});

test.each([undefined, { eventId: 'rumor', kind: 14, delivered: false, relayResults: {} }])(
  'a trailing listing renders immediately without delivery acknowledgement (%j)',
  (deliveryStatus) => {
    const { naddrEncode } = jest.requireActual('nostr-tools/nip19');
    const uri = naddrEncode({ kind: 30402, pubkey: 'a'.repeat(64), identifier: 'pending' });
    const ui = render(
      <MessageBubble
        {...props}
        deliveryStatus={deliveryStatus}
        content={{ kind: 'text', text: `Bitcoin Satskull nostr:${uri}` }}
      />,
    );
    expect(ui.getByTestId('conversation-listing-msg')).toBeTruthy();
    expect(ui.getByTestId('listing-pending')).toBeTruthy();
    expect(ui.getByText('Bitcoin Satskull')).toBeTruthy();
  },
);
