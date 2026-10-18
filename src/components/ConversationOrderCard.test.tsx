import React from 'react';
import { render } from '@testing-library/react-native';
import ConversationOrderCard from './ConversationOrderCard';
import { buildMarketOrder } from '../utils/marketOrder';
import { parseOrderEvent, type OrderEventType } from '../utils/orderEvents';

jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({
  useLocale: () => ({ t: (key: string) => key, formatLocale: 'en' }),
}));
jest.mock('../services/boltzService', () => ({ isBitcoinAddress: () => false }));
jest.mock('./FiatAmount', () => () => null);
jest.mock('./OrderPaymentActions', () => () => null);

const checkout = (note?: string) =>
  buildMarketOrder({
    buyerPubkey: 'buyer',
    vendorPubkey: 'seller',
    orderId: '1234',
    lines: [{ merchantPubkey: 'seller', dTag: 'mug', quantity: 2, priceSats: 2100 }],
    shipping: { coordinate: '30406:seller:post', costSats: 100, title: 'Tracked' },
    note,
  }).rumor;

function card(message: string, type: OrderEventType = 'order', fromMe = true) {
  const order = { ...parseOrderEvent(checkout())!, type, message };
  const item = { kind: 'order' as const, id: 'test', fromMe, createdAt: 1, order };
  return { order, ui: render(<ConversationOrderCard item={item} onPayInvoice={jest.fn()} />) };
}

test.each(['order', 'payment'] as const)(
  '%s cards omit generated totals and an empty note, preserving the source message',
  (type) => {
    const original = checkout().content;
    const { order, ui } = card(original, type);
    expect(ui.queryByText(/Subtotal:|Shipping \(|Total:/)).toBeNull();
    expect(ui.queryByText(/sellerOrders.buyerNote/)).toBeNull();
    expect(ui.queryByTestId('conversation-order-note-test')).toBeNull();
    expect(ui.getByText('4,300 sats')).toBeTruthy();
    expect(order.message).toBe(original);
  },
);

test.each([true, false])('preserves and labels the buyer note (fromMe=%s)', (fromMe) => {
  const { ui } = card(checkout('Leave at the door.\nThanks!').content, 'order', fromMe);
  expect(ui.getByTestId('conversation-order-note-test')).toHaveTextContent(
    'sellerOrders.buyerNote: Leave at the door. Thanks!',
  );
  expect(ui.queryByText(/Subtotal:|Shipping \(|Total:/)).toBeNull();
});

test('retains seller payment instructions without calling them a buyer note', () => {
  const { ui } = card('Please pay within 24 hours.', 'payment', false);
  expect(ui.getByText('Please pay within 24 hours.')).toBeTruthy();
  expect(ui.queryByText(/sellerOrders.buyerNote/)).toBeNull();
});

test.each(['', ' \n ', 'Subtotal: please confirm shipping'])('handles plain content %p', (text) => {
  const { ui } = card(text);
  if (text.trim()) {
    expect(ui.getByTestId('conversation-order-note-test')).toHaveTextContent(
      `sellerOrders.buyerNote: ${text}`,
    );
  } else {
    expect(ui.queryByTestId('conversation-order-note-test')).toBeNull();
  }
});
