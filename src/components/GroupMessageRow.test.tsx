import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { Image } from 'expo-image';
import GroupMessageRow from './GroupMessageRow';
import { useMentionProfile } from '../hooks/useMentionProfile';

jest.mock('../hooks/useMentionProfile', () => ({ useMentionProfile: jest.fn() }));

jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('./MessageBubble', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ id, senderName }: { id: string; senderName?: string | null }) => (
      <Text>{senderName ?? id}</Text>
    ),
  };
});
jest.mock('expo-image', () => ({ Image: jest.requireActual('react-native').Image }));

const props = {
  id: 'msg1',
  fromMe: false,
  createdAt: 1,
  content: { kind: 'text' as const, text: 'Hello' },
  autoLoadMedia: false,
  testIdPrefix: 'group-conversation',
  senderPubkey: 'a'.repeat(64),
  senderName: 'Curious Fox',
  senderPicture: null,
  showSender: true,
  onOpenSender: jest.fn(),
  onPayInvoice: jest.fn(),
  onPayLightningAddress: jest.fn(),
  onOpenContact: jest.fn(),
  onOpenLocation: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useMentionProfile).mockReturnValue({ name: null, picture: null });
});

test('avatar initials and name both open the sender profile', () => {
  const ui = render(<GroupMessageRow {...props} />);
  expect(ui.getByText('CF')).toBeTruthy();
  fireEvent.press(ui.getByTestId('group-msg-avatar-msg1'));
  fireEvent.press(ui.getByTestId('group-msg-sender-msg1'));
  expect(props.onOpenSender).toHaveBeenNthCalledWith(1, props.senderPubkey);
  expect(props.onOpenSender).toHaveBeenNthCalledWith(2, props.senderPubkey);
});

test.each([null, 'https://example.com/photo.svg'])(
  'uses a supported sender avatar when the resolved picture is %p, then initials on failure',
  (resolvedPicture) => {
    jest.mocked(useMentionProfile).mockReturnValue({ name: null, picture: resolvedPicture });
    const ui = render(<GroupMessageRow {...props} senderPicture="https://example.com/photo.png" />);
    const image = ui.UNSAFE_getByType(Image);
    expect(image.props.source).toEqual({ uri: 'https://example.com/photo.png' });
    expect(image.props.cachePolicy).toBe('memory-disk');
    expect(image.props.autoplay).toBe(false);
    fireEvent(image, 'error');
    expect(ui.getByText('CF')).toBeTruthy();
    expect(ui.UNSAFE_queryByType(Image)).toBeNull();
  },
);

test.each([{ showSender: false }, { fromMe: true }])(
  'omits sender controls for repeated or outgoing messages: %o',
  (overrides) => {
    const ui = render(<GroupMessageRow {...props} {...overrides} />);
    expect(ui.queryByTestId('group-msg-avatar-msg1')).toBeNull();
    expect(ui.queryByTestId('group-msg-sender-msg1')).toBeNull();
    expect(ui.getByText('msg1')).toBeTruthy();
  },
);

test('uses the shared resolver for a sender and updates an already-mounted label', () => {
  const ui = render(<GroupMessageRow {...props} senderName={undefined} />);
  expect(ui.getByTestId('group-msg-sender-msg1').props.accessibilityLabel).toMatch(/^npub1.*…/);
  expect(useMentionProfile).toHaveBeenCalledWith(props.senderPubkey, null, false);
  jest.mocked(useMentionProfile).mockReturnValue({ name: 'Resolved Fox', picture: null });
  ui.rerender(<GroupMessageRow {...props} senderName="Stale snapshot" />);
  expect(ui.getByText('Resolved Fox')).toBeTruthy();
});

test.each(['You', 'Tú', 'Ви'])(
  'preserves the supplied self label %s on outgoing unsupported notices',
  (senderName) => {
    jest.mocked(useMentionProfile).mockReturnValue({ name: 'Account name', picture: null });
    const ui = render(
      <GroupMessageRow
        {...props}
        fromMe
        senderName={senderName}
        content={{ kind: 'unsupported', rawKind: 999 }}
      />,
    );
    expect(ui.getByText(senderName)).toBeTruthy();
    expect(ui.queryByText('Account name')).toBeNull();
  },
);
