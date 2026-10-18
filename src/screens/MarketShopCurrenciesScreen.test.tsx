import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import MarketShopCurrenciesScreen from './MarketShopCurrenciesScreen';
import { saveSellerCurrency } from '../services/sellerPreferences';
import { Toast } from '../components/BrandedToast';

jest.mock('../components/ShopReceiveWalletSetting', () => () => null);

jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => new Proxy({}, { get: () => '#000' }),
}));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../hooks/useSellerShop', () => ({
  useSellerShop: () => ({ pubkey: 'seller', defaultCurrency: 'SATS' }),
}));
jest.mock('../services/sellerPreferences', () => ({ saveSellerCurrency: jest.fn() }));
jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('../components/MarketSellerHeader', () => () => null);

const navigation = { goBack: jest.fn() };
const checked = (screen: ReturnType<typeof render>, code: string) =>
  screen.getByTestId(`shop-currency-option-${code}`).props.accessibilityState.checked;

beforeEach(() => jest.clearAllMocks());

it('marks the current default and saves a new choice on this device', async () => {
  (saveSellerCurrency as jest.Mock).mockResolvedValue(undefined);
  const screen = render(<MarketShopCurrenciesScreen navigation={navigation as never} />);
  expect(checked(screen, 'SATS')).toBe(true);
  await act(async () => fireEvent.press(screen.getByTestId('shop-currency-option-USD')));
  expect(saveSellerCurrency).toHaveBeenCalledWith('seller', 'USD');
  expect(checked(screen, 'USD')).toBe(true);
  expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
});

it('reverts the choice when saving fails', async () => {
  (saveSellerCurrency as jest.Mock).mockRejectedValue(new Error('disk full'));
  const screen = render(<MarketShopCurrenciesScreen navigation={navigation as never} />);
  await act(async () => fireEvent.press(screen.getByTestId('shop-currency-option-USD')));
  expect(checked(screen, 'SATS')).toBe(true);
  expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
});
