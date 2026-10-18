/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock factories must require lazily */
import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import SellerInvoiceSheet from './SellerInvoiceSheet';
import { useInvoiceWallets } from '../hooks/useInvoiceWallets';
import { loadSellerReceiveWallet } from '../services/sellerReceiveWallet';
import type { InvoiceWalletChoice } from '../utils/invoiceWallets';

jest.mock('@gorhom/bottom-sheet', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    BottomSheetModal: R.forwardRef(
      (props: { children: React.ReactNode }, ref: React.Ref<unknown>) => {
        R.useImperativeHandle(ref, () => ({ present: () => {}, dismiss: () => {} }));
        return R.createElement(View, null, props.children);
      },
    ),
    BottomSheetScrollView: (props: { children: React.ReactNode }) =>
      R.createElement(View, null, props.children),
    BottomSheetBackdrop: () => null,
  };
});
jest.mock('./AccessibleBottomSheetModal', () => {
  const R = require('react');
  const { View } = require('react-native');
  return {
    BottomSheetModal: R.forwardRef(
      (props: { children: React.ReactNode }, ref: React.Ref<unknown>) => {
        R.useImperativeHandle(ref, () => ({ present: () => {}, dismiss: () => {} }));
        return R.createElement(View, null, props.children);
      },
    ),
  };
});
jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => {
  const t = (key: string) => key;
  return { useTranslation: () => t, useLocale: () => ({ t, formatLocale: 'en' }) };
});
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ pubkey: 'a'.repeat(64) }) }));
jest.mock('../hooks/useInvoiceWallets', () => ({ useInvoiceWallets: jest.fn() }));
jest.mock('../services/sellerReceiveWallet', () => ({ loadSellerReceiveWallet: jest.fn() }));
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
jest.mock('./BrandedSpinner', () => () => null);

const wallet = (id: string) => ({ id, alias: id, walletType: 'nwc' as const, isConnected: true });
const choices: InvoiceWalletChoice[] = [
  { wallet: wallet('alpha'), capability: 'yes' },
  { wallet: wallet('beta'), capability: 'yes' },
  { wallet: wallet('gamma'), capability: 'unknown' },
];

function renderSheet(onConfirm = jest.fn().mockResolvedValue(undefined)) {
  const ui = render(
    <SellerInvoiceSheet
      visible
      onClose={jest.fn()}
      orderId="abcd1234-0000"
      totalSats={4200}
      fiatTotal={{ amount: 2.1, currency: 'GBP' }}
      buyerAmountSats={4000}
      onConfirm={onConfirm}
      error={null}
    />,
  );
  return { ui, onConfirm };
}

beforeEach(() => {
  jest.clearAllMocks();
  (useInvoiceWallets as jest.Mock).mockReturnValue(choices);
});

it('with no shop wallet set, nothing is pre-selected and Confirm is disabled until the seller picks', async () => {
  (loadSellerReceiveWallet as jest.Mock).mockResolvedValue(null);
  const { ui, onConfirm } = renderSheet();
  await act(async () => {});
  expect(ui.getByTestId('seller-invoice-mismatch')).toBeTruthy();
  fireEvent.press(ui.getByTestId('seller-invoice-confirm'));
  expect(onConfirm).not.toHaveBeenCalled();
  // A wallet still being checked can't be chosen.
  fireEvent.press(ui.getByTestId('seller-invoice-wallet-gamma'));
  fireEvent.press(ui.getByTestId('seller-invoice-confirm'));
  expect(onConfirm).not.toHaveBeenCalled();

  fireEvent.press(ui.getByTestId('seller-invoice-wallet-beta'));
  fireEvent.press(ui.getByTestId('seller-invoice-remember'));
  await act(async () => {
    fireEvent.press(ui.getByTestId('seller-invoice-confirm'));
  });
  expect(onConfirm).toHaveBeenCalledWith('beta', true);
});

it('pre-selects the shop "Receive payments to" wallet', async () => {
  (loadSellerReceiveWallet as jest.Mock).mockResolvedValue('alpha');
  const { ui, onConfirm } = renderSheet();
  await waitFor(() =>
    expect(ui.getByTestId('seller-invoice-wallet-alpha').props.accessibilityState).toMatchObject({
      selected: true,
    }),
  );
  // Already the shop wallet — no "remember" offer.
  expect(ui.queryByTestId('seller-invoice-remember')).toBeNull();
  await act(async () => {
    fireEvent.press(ui.getByTestId('seller-invoice-confirm'));
  });
  expect(onConfirm).toHaveBeenCalledWith('alpha', false);
});

it('a removed shop wallet counts as unset (no pre-selection)', async () => {
  (loadSellerReceiveWallet as jest.Mock).mockResolvedValue('deleted-wallet');
  const { ui, onConfirm } = renderSheet();
  await act(async () => {});
  for (const id of ['alpha', 'beta']) {
    expect(ui.getByTestId(`seller-invoice-wallet-${id}`).props.accessibilityState).toMatchObject({
      selected: false,
    });
  }
  fireEvent.press(ui.getByTestId('seller-invoice-confirm'));
  expect(onConfirm).not.toHaveBeenCalled();
});
