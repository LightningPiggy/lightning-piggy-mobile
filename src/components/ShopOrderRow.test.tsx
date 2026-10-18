/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ShopOrderRow from './ShopOrderRow';
import { createMarketShopOrdersStyles } from '../styles/MarketShopOrders.styles';

jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => {
  const t = (key: string) => key;
  return { useTranslation: () => t, useLocale: () => ({ t, formatLocale: 'en' }) };
});
jest.mock('expo-image', () => ({ Image: require('react-native').Image }));

it('renders the order with its status chip and opens it', () => {
  const onPress = jest.fn();
  const ui = render(
    <ShopOrderRow
      order={{
        key: 'buyer:abcd1234-5678',
        orderId: 'abcd1234-5678',
        eventId: 'wrap',
        buyer: 'buyer',
        createdAt: 1,
        lines: [{ ref: 'ref', dTag: 'mug', title: 'Mug', quantity: 2 }],
        invoiceSent: false,
      }}
      styles={createMarketShopOrdersStyles(
        {} as Parameters<typeof createMarketShopOrdersStyles>[0],
      )}
      accessory={<></>}
      buyerName="Jane"
      onPress={onPress}
    />,
  );
  fireEvent.press(ui.getByTestId('shop-order-abcd1234-5678'));
  expect(onPress).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'abcd1234-5678' }));
});
