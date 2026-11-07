import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { LnurlWithdrawHost, openLnurlWithdrawSheet } from './LnurlWithdrawSheet';
import { LnurlWithdrawError } from '../services/lnurlWithdrawService';

let mockDismiss: (() => void) | null = null;
jest.mock('@gorhom/bottom-sheet', () => {
  const R = jest.requireActual('react');
  const RN = jest.requireActual('react-native');
  return {
    BottomSheetModal: R.forwardRef(function Modal(
      { children, onDismiss }: { children: React.ReactNode; onDismiss: () => void },
      ref: React.Ref<unknown>,
    ) {
      mockDismiss = onDismiss;
      R.useImperativeHandle(ref, () => ({ present: jest.fn(), dismiss: jest.fn() }));
      return R.createElement(RN.View, null, children);
    }),
    BottomSheetScrollView: RN.View,
    BottomSheetTextInput: RN.TextInput,
    BottomSheetBackdrop: () => null,
  };
});
jest.mock('lucide-react-native', () => ({ Gift: () => null, PartyPopper: () => null }));
jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () =>
  (() => {
    const context = { useTranslation: () => (key: string) => key };
    return {
      ...context,
      useLocale: () => ({ t: context.useTranslation(), locale: 'en', formatLocale: 'en' }),
    };
  })(),
);
jest.mock('../styles/LnurlWithdrawSheet.styles', () => ({
  createLnurlWithdrawSheetStyles: () => ({}),
}));
const mockWallets = [
  { id: 'first', walletType: 'nwc' },
  { id: 'active', walletType: 'nwc' },
];
const mockMakeInvoice = jest.fn(async () => 'lnbcfixture');
jest.mock('../contexts/WalletContext', () => ({
  useWallet: () => ({
    wallets: mockWallets,
    activeWalletId: 'active',
    makeInvoiceForWallet: mockMakeInvoice,
    expectPayment: jest.fn(),
    currency: 'GBP',
  }),
  useWalletLive: () => ({ btcPrice: null, lastIncomingPayment: null }),
}));
const mockResolve = jest.fn();
const mockClaim = jest.fn(async (_params, makeInvoice) => ({
  sats: 21,
  bolt11: await makeInvoice(21, 'Voucher'),
}));
jest.mock('../services/lnurlWithdrawService', () => ({
  ...jest.requireActual('../services/lnurlWithdrawService'),
  resolveLnurlWithdraw: (...args: unknown[]) => mockResolve(...args),
  claimLnurlWithdraw: (...args: Parameters<typeof mockClaim>) => mockClaim(...args),
}));
jest.mock('../services/claimHistoryService', () => ({ recordClaim: jest.fn() }));
jest.mock('../utils/bolt11', () => ({ paymentHashFromBolt11: () => 'fixture-hash' }));
jest.mock('../utils/fiat', () => ({ formatFiatApprox: () => '' }));
jest.mock('./AmountSlider', () => ({ AmountSlider: () => null }));
jest.mock('./PrizeWalletPicker', () => () => null);
jest.mock('./AddWalletWizard', () => () => null);

beforeEach(() => {
  jest.clearAllMocks();
  mockResolve.mockResolvedValue({
    callback: 'https://example.com/callback',
    k1: 'fixture',
    defaultDescription: 'Voucher',
    minWithdrawable: 21000,
    maxWithdrawable: 21000,
  });
});

it('requires redemption after scanning a fixed voucher and invoices the chosen wallet', async () => {
  render(<LnurlWithdrawHost />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurlw://example.com/voucher', 'first', true);
  });
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockMakeInvoice).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(mockResolve).toHaveBeenCalledTimes(1);
  expect(mockClaim).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.press(screen.getByTestId('lnurl-withdraw-claim-button'));
  });
  expect(mockMakeInvoice).toHaveBeenCalledWith('first', 21, 'Voucher');
});

it('defaults deep-link claims to the active Lightning wallet', async () => {
  render(<LnurlWithdrawHost />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurlw://example.com/voucher');
  });
  expect(mockMakeInvoice).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(mockMakeInvoice).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-claim-button')));
  expect(mockMakeInvoice).toHaveBeenCalledWith('active', 21, 'Voucher');
});

it('does not mint an invoice when a scanned voucher cannot resolve', async () => {
  mockResolve.mockRejectedValue(new Error('Expired voucher'));
  render(<LnurlWithdrawHost />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurlw://example.com/expired', 'first', true);
  });
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(mockMakeInvoice).not.toHaveBeenCalled();
  expect(mockClaim).not.toHaveBeenCalled();
  expect(screen.queryByTestId('lnurl-withdraw-claim-button')).toBeNull();
});

it('resolves the same voucher again after dismissing and reopening, with confirmation reset', async () => {
  render(<LnurlWithdrawHost />);
  const voucher = 'lnurlw://example.com/voucher';
  await act(async () => {
    openLnurlWithdrawSheet(voucher, 'first', true);
  });
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(screen.getByTestId('lnurl-withdraw-claim-button')).toBeTruthy();
  act(() => mockDismiss!());
  expect(screen.queryByTestId('lnurl-withdraw-claim-button')).toBeNull();
  await act(async () => {
    openLnurlWithdrawSheet(voucher, 'active', true);
  });
  expect(mockResolve).toHaveBeenCalledTimes(1);
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(mockResolve).toHaveBeenCalledTimes(2);
  expect(mockClaim).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-claim-button')));
  expect(mockMakeInvoice).toHaveBeenCalledWith('active', 21, 'Voucher');
});

it('dismisses an unopened voucher without any resolution or invoice creation', async () => {
  render(<LnurlWithdrawHost />);
  act(() => openLnurlWithdrawSheet('lnurlw://example.com/voucher', 'first'));
  expect(mockResolve).not.toHaveBeenCalled();
  act(() => mockDismiss!());
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockMakeInvoice).not.toHaveBeenCalled();
});

it('skips only the host step for an already-consented caller; the claim tap stays mandatory', async () => {
  render(<LnurlWithdrawHost />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurlw://example.com/voucher', 'first', false);
  });
  // No duplicate consent prompt — the caller (App deep-link router) already
  // showed the host — but the endpoint is only resolved, never claimed.
  expect(screen.queryByTestId('lnurl-withdraw-resolve-button')).toBeNull();
  expect(mockResolve).toHaveBeenCalledTimes(1);
  expect(screen.getByText('linkAction.withdraw')).toBeTruthy();
  expect(screen.getByTestId('lnurl-withdraw-amount-input').props.value).toBe('21');
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockMakeInvoice).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-claim-button')));
  expect(mockClaim).toHaveBeenCalledTimes(1);
});

it('hands a pay link to the Send sheet only after the neutral consent tap', async () => {
  mockResolve.mockRejectedValue(
    new LnurlWithdrawError('LNURL endpoint is not a withdrawRequest (LUD-03)', 'pay-request'),
  );
  const onPayLink = jest.fn();
  render(<LnurlWithdrawHost onPayLink={onPayLink} />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurl://example.com/pay', undefined, true);
  });
  // Direction is unknown until resolved, so the consent doesn't say "Withdraw".
  expect(screen.getByText('linkAction.open')).toBeTruthy();
  expect(screen.queryByText('linkAction.withdraw')).toBeNull();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(onPayLink).not.toHaveBeenCalled();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(onPayLink).toHaveBeenCalledWith('https://example.com/pay');
  expect(mockClaim).not.toHaveBeenCalled();
  expect(mockMakeInvoice).not.toHaveBeenCalled();
  expect(screen.queryByText(/withdrawRequest/)).toBeNull();
});

it('shows friendly copy, not the raw protocol error, for a non-voucher link', async () => {
  mockResolve.mockRejectedValue(
    new LnurlWithdrawError('LNURL endpoint is not a withdrawRequest (LUD-03)', 'not-withdraw'),
  );
  const onPayLink = jest.fn();
  render(<LnurlWithdrawHost onPayLink={onPayLink} />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurlw://example.com/odd', 'first', true);
  });
  expect(screen.getByText('linkAction.withdraw')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(onPayLink).not.toHaveBeenCalled();
  expect(screen.getByText('lnurlWithdrawSheet.notAVoucher')).toBeTruthy();
  expect(screen.queryByText(/withdrawRequest/)).toBeNull();
});

it('falls back to the friendly error for a pay link when no Send hand-off is wired', async () => {
  mockResolve.mockRejectedValue(
    new LnurlWithdrawError('LNURL endpoint is not a withdrawRequest (LUD-03)', 'pay-request'),
  );
  render(<LnurlWithdrawHost />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurl://example.com/pay', 'first', true);
  });
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(screen.getByText('lnurlWithdrawSheet.notAVoucher')).toBeTruthy();
});

it('still shows an issuer-sent reason as-is', async () => {
  mockResolve.mockRejectedValue(new LnurlWithdrawError('Voucher already spent'));
  render(<LnurlWithdrawHost />);
  await act(async () => {
    openLnurlWithdrawSheet('lnurlw://example.com/spent', 'first', true);
  });
  await act(async () => fireEvent.press(screen.getByTestId('lnurl-withdraw-resolve-button')));
  expect(screen.getByText('Voucher already spent')).toBeTruthy();
});
