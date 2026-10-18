import React from 'react';
import { render } from '@testing-library/react-native';
import MessageSharedListing from './MessageSharedListing';
import { useSharedListing } from '../hooks/useSharedListing';
import type { EmbedRef } from '../services/nostrEmbedCache';
import type { MarketProduct } from '../data/marketProducts';
jest.mock('../hooks/useSharedListing', () => ({ useSharedListing: jest.fn() }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ push: jest.fn() }) }));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('./MarketProductCard', () => ({
  __esModule: true,
  default: (props: { testID: string }) =>
    jest.requireActual('react').createElement(jest.requireActual('react-native').View, props),
}));
const token: EmbedRef = {
  type: 'address',
  kind: 30402,
  pubkey: 'a'.repeat(64),
  identifier: 'skull',
  relays: ['wss://hint'],
  raw: '',
};
beforeEach(() => jest.mocked(useSharedListing).mockReset());
it('keeps a titled product placeholder while loading or unavailable', () => {
  const ui = render(
    <MessageSharedListing token={token} title="[TEST] Bitcoin Satskull" autoLoadMedia={true} />,
  );
  expect(ui.getByTestId('message-shared-listing-placeholder')).toBeTruthy();
  expect(ui.getByText('[TEST] Bitcoin Satskull')).toBeTruthy();
  expect(ui.getByText('B')).toBeTruthy();
  expect(ui.getByText('market.share.marketListing')).toBeTruthy();
});
it.each([true, false])(
  'uses the product card and gates images and relay hints by sender trust (%s)',
  (trusted) => {
    jest
      .mocked(useSharedListing)
      .mockReturnValue({ id: 'skull', sellerName: 'Seller' } as MarketProduct);
    const ui = render(<MessageSharedListing token={token} autoLoadMedia={trusted} />);
    expect(useSharedListing).toHaveBeenCalledWith({
      ...token,
      relays: trusted ? token.relays : [],
    });
    expect(ui.getByTestId('message-shared-listing-product').props.autoLoadMedia).toBe(trusted);
  },
);
