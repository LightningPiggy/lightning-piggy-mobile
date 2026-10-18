import React from 'react';
import { act, fireEvent, render } from '@testing-library/react-native';
import ShopReceiveWalletSetting from './ShopReceiveWalletSetting';
import { useInvoiceWallets } from '../hooks/useInvoiceWallets';
import { loadSellerReceiveWallet, saveSellerReceiveWallet } from '../services/sellerReceiveWallet';

jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ pubkey: 'a'.repeat(64) }) }));
jest.mock('../hooks/useInvoiceWallets', () => ({ useInvoiceWallets: jest.fn() }));
jest.mock('../services/sellerReceiveWallet', () => ({
  loadSellerReceiveWallet: jest.fn(),
  saveSellerReceiveWallet: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));

const wallet = (id: string) => ({ id, alias: id, walletType: 'nwc' as const, isConnected: true });

it('lists only receive-capable wallets and saves the pick for this account', async () => {
  (useInvoiceWallets as jest.Mock).mockReturnValue([
    { wallet: wallet('alpha'), capability: 'yes' },
  ]);
  (loadSellerReceiveWallet as jest.Mock).mockResolvedValue(null);
  const ui = render(<ShopReceiveWalletSetting />);
  await act(async () => {});
  expect(ui.getByTestId('shop-receive-wallet-picker')).toBeTruthy();
  fireEvent.press(ui.getByTestId('shop-receive-wallet-alpha'));
  expect(saveSellerReceiveWallet).toHaveBeenCalledWith('a'.repeat(64), 'alpha');
});

it('explains when no wallet can create invoices', async () => {
  (useInvoiceWallets as jest.Mock).mockReturnValue([]);
  (loadSellerReceiveWallet as jest.Mock).mockResolvedValue(null);
  const ui = render(<ShopReceiveWalletSetting />);
  await act(async () => {});
  expect(ui.getByTestId('shop-receive-wallet-empty')).toBeTruthy();
});
