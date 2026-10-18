import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ConversationMessageRow, { type ConversationMessageRowProps } from './ConversationMessageRow';
import { createConversationScreenStyles } from '../styles/ConversationScreen.styles';
import { lightPalette } from '../styles/palettes';
import i18n from '../i18n';
import { buildMarketOrder } from '../utils/marketOrder';
import { parseOrderEvent, type OrderEventType } from '../utils/orderEvents';
import type MessageBubble from './MessageBubble';
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

// The seller panel (wallet + relay hooks) is covered by SellerOrderPanel.test.
jest.mock('./SellerOrderPanel', () => () => null);
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: jest.requireActual('../i18n').t, formatLocale: 'en' }),
}));
jest.mock('./MessageBubble', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ senderName }: React.ComponentProps<typeof MessageBubble>) => (
      <Text>{senderName ?? 'Unknown sender'}</Text>
    ),
  };
});
jest.mock('../contexts/WalletContext', () => ({
  useWallet: () => ({ currency: 'USD' }),
  useWalletLive: () => ({ btcPrice: null }),
}));
jest.mock('./OrderPaymentActions', () => () => null);
jest.mock('./NwcShareCard', () => () => null);
jest.mock('./MarmotInviteFailedNotice', () => () => null);
jest.mock('./DeviceNoticeLine', () => () => null);

const props: Omit<ConversationMessageRowProps, 'item'> = {
  styles: createConversationScreenStyles(lightPalette),
  colors: lightPalette,
  sharedProfiles: undefined,
  isInvoicePaid: undefined,
  onPayInvoice: jest.fn(),
  onOpenContact: jest.fn(),
  onOpenLocation: jest.fn(),
  onOpenGifFullscreen: undefined,
  onToggleSecretMode: undefined,
  pollAggregates: undefined,
  onVotePoll: undefined,
  onShowTxDetail: jest.fn(),
  liveLocationLatest: undefined,
  liveLocationStatus: undefined,
  liveLocationRemainingMs: undefined,
  onStopLiveLocation: undefined,
  myLat: undefined,
  myLon: undefined,
  myAccuracyMetres: undefined,
  myAvatarUri: undefined,
  peerAvatarUri: undefined,
  onOpenMap: undefined,
  onShowInfo: undefined,
  onLongPress: undefined,
  reactions: undefined,
  onToggleReaction: undefined,
  onAddNwc: jest.fn(),
  peerName: 'Curious Fox',
  peerMediaTrusted: false,
};

test.each([
  [true, 'en', 'You'],
  [true, 'es', 'Tú'],
  [false, 'en', 'Curious Fox'],
])('unsupported sender follows fromMe=%s in %s', (fromMe, locale, expected) => {
  i18n.locale = locale;
  try {
    const ui = render(
      <ConversationMessageRow
        {...props}
        item={{ kind: 'unsupported', id: 'other-device', fromMe, rawKind: 1234, createdAt: 1 }}
      />,
    );
    expect(ui.getByText(expected)).toBeTruthy();
  } finally {
    i18n.locale = 'en';
  }
});

it.each([false, true])(
  'opens the appropriate order detail without rendering contact fields (fromMe=%s)',
  (fromMe) => {
    const ui = render(
      <ConversationMessageRow
        {...props}
        peerPubkey="peer"
        item={{
          kind: 'order',
          id: 'order-row',
          fromMe,
          createdAt: 100,
          order: {
            kind: 16,
            type: 'order',
            orderId: 'order-1',
            items: [{ ref: 'product', quantity: 1 }],
            message: '',
            address: 'PRIVATE ADDRESS',
            email: 'PRIVATE EMAIL',
            phone: 'PRIVATE PHONE',
            contact: 'PRIVATE CONTACT',
          },
        }}
      />,
    );
    for (const value of ['PRIVATE ADDRESS', 'PRIVATE EMAIL', 'PRIVATE PHONE', 'PRIVATE CONTACT'])
      expect(ui.queryByText(value)).toBeNull();
    fireEvent.press(ui.getByTestId('conversation-order-view-order-row'));
    expect(mockNavigate).toHaveBeenLastCalledWith('Main', {
      screen: 'MainTabs',
      params: {
        screen: 'Explore',
        params: {
          state: {
            index: 2,
            routes: [
              { name: 'ExploreHome' },
              { name: fromMe ? 'MarketMyOrders' : 'MarketShopOrders' },
              {
                name: fromMe ? 'MarketMyOrders' : 'MarketShopOrders',
                params: fromMe
                  ? { orderId: 'order-1', sellerPubkey: 'peer' }
                  : { orderId: 'order-1', buyerPubkey: 'peer' },
              },
            ],
          },
        },
      },
    });
  },
);

// Exercise the chat row's real order renderer with the existing checkout shape.
test.each(['order', 'payment', 'status', 'shipping', 'receipt'] as const)(
  '%s chat rows strip checkout totals and preserve free text',
  (type: OrderEventType) => {
    for (const fromMe of [true, false]) {
      for (const note of ['', 'Please leave at the door.']) {
        const rumor = buildMarketOrder({
          buyerPubkey: 'buyer',
          vendorPubkey: 'seller',
          orderId: 'f68fb42a',
          lines: [{ merchantPubkey: 'seller', dTag: 'item', quantity: 1, priceSats: 21 }],
          shipping: {
            coordinate: '30406:seller:standard',
            costSats: 0,
            title: '[TEST] Standard (free)',
          },
          note,
        }).rumor;
        // Legacy stored rows may still contain the original generated suffix.
        const order = { ...parseOrderEvent(rumor)!, type, message: rumor.content };
        const ui = render(
          <ConversationMessageRow
            {...props}
            item={{ kind: 'order', id: 'checkout', fromMe, createdAt: 100, order }}
          />,
        );
        expect(ui.getByTestId('conversation-order-checkout')).toBeTruthy();
        expect(ui.getByText('21 sats')).toBeTruthy();
        expect(ui.queryByText(/Subtotal:|Shipping \(|Total:/)).toBeNull();
        if (note) {
          expect(ui.getByTestId('conversation-order-note-checkout')).toHaveTextContent(
            type === 'order' ? `${i18n.t('sellerOrders.buyerNote')}: ${note}` : note,
          );
        } else {
          expect(ui.queryByTestId('conversation-order-note-checkout')).toBeNull();
        }
        expect(order.message).toBe(rumor.content);
        ui.unmount();
      }
    }
  },
);
