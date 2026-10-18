import React from 'react';
import { bech32 } from 'bech32';
import { fireEvent, render } from '@testing-library/react-native';
import OrderPaymentActions from './OrderPaymentActions';
import type { ParsedOrderEvent } from '../utils/orderEvents';

jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../styles/OrderPaymentActions.styles', () => ({
  createOrderPaymentActionsStyles: () => ({}),
}));
jest.mock('./BrandedToast', () => ({ show: jest.fn() }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('react-native-qrcode-svg', () => () => null);
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
// messageContent → boltzService pulls in ESM-only bitcoin deps; irrelevant here.
jest.mock('../services/boltzService', () => ({ isBitcoinAddress: () => false }));

// Real BOLT11 bech32 shape (same builder as orderInvoiceAmount.test.ts), so
// the amount check runs the production decoder. `lnbc1u` = 100 sats.
const NOW = 1_800_000_000;
beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000));
afterEach(() => jest.restoreAllMocks());

function invoice(hrp: string, timestamp = NOW): string {
  const timestampWords = Array.from(
    { length: 7 },
    (_, i) => Math.floor(timestamp / 32 ** (6 - i)) % 32,
  );
  return bech32.encode(
    hrp,
    [...timestampWords, 1, 1, 20, ...bech32.toWords(Buffer.alloc(32, 1)), ...Array(104).fill(0)],
    2000,
  );
}

function paymentRequest(bolt11: string): ParsedOrderEvent {
  return {
    kind: 16,
    type: 'payment',
    orderId: 'order-1',
    items: [],
    message: '',
    payment: { method: 'lightning', value: bolt11 },
  };
}

function receipt(amountSats: number): ParsedOrderEvent {
  return { kind: 17, type: 'receipt', orderId: 'order-1', amountSats, items: [], message: '' };
}

const payActions = ['pay', 'qr-toggle', 'copy', 'paid'].map((a) => `c-order-${a}-1`);

function renderActions(props: Partial<React.ComponentProps<typeof OrderPaymentActions>>) {
  const onPayInvoice = jest.fn();
  const ui = render(
    <OrderPaymentActions
      order={paymentRequest(invoice('lnbc1u'))}
      fromMe={false}
      onPayInvoice={onPayInvoice}
      isInvoicePaid={() => true}
      testIdPrefix="c"
      id="1"
      {...props}
    />,
  );
  return { ui, onPayInvoice };
}

describe('OrderPaymentActions payment boundary', () => {
  test('an unpaid invoice past its default expiry has no Pay button', () => {
    const { ui } = renderActions({
      order: paymentRequest(invoice('lnbc1u', NOW - 3601)),
      expectedAmountSats: 100,
      isInvoicePaid: () => false,
    });
    expect(ui.getByTestId('c-order-expired-1')).toBeTruthy();
    expect(ui.queryByTestId('c-order-pay-1')).toBeNull();
  });

  test('an invoice for exactly the approved total is payable', () => {
    const { ui, onPayInvoice } = renderActions({
      expectedAmountSats: 100,
      isInvoicePaid: () => false,
    });
    fireEvent.press(ui.getByTestId('c-order-pay-1'));
    expect(onPayInvoice).toHaveBeenCalledWith(invoice('lnbc1u'));
    expect(ui.queryByTestId('c-order-amount-error-1')).toBeNull();
  });

  test.each([
    ['a different amount', 'lnbc2u', 100],
    ['no approved order total', 'lnbc1u', undefined],
    ['an amountless invoice', 'lnbc', 100],
  ])('%s shows no Pay, QR, Copy or Paid affordance', (_label, hrp, expected) => {
    const { ui } = renderActions({
      order: paymentRequest(invoice(hrp)),
      expectedAmountSats: expected,
    });
    expect(ui.getByTestId('c-order-amount-error-1')).toBeTruthy();
    for (const id of payActions) expect(ui.queryByTestId(id)).toBeNull();
  });

  test('an undecodable invoice is not payable', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { ui } = renderActions({
      order: paymentRequest(`lnbc1u${'q'.repeat(80)}`),
      expectedAmountSats: 100,
    });
    expect(ui.getByTestId('c-order-amount-error-1')).toBeTruthy();
    for (const id of payActions) expect(ui.queryByTestId(id)).toBeNull();
  });

  test('a receipt without a matching order total is unverified, not paid', () => {
    const { ui } = renderActions({ order: receipt(100), expectedAmountSats: undefined });
    expect(ui.getByTestId('c-order-receipt-unverified-1')).toBeTruthy();
    expect(ui.queryByTestId('c-order-paid-1')).toBeNull();
    ui.rerender(
      <OrderPaymentActions
        order={receipt(100)}
        expectedAmountSats={250}
        fromMe={false}
        onPayInvoice={jest.fn()}
        testIdPrefix="c"
        id="1"
      />,
    );
    expect(ui.getByTestId('c-order-receipt-unverified-1')).toBeTruthy();
    expect(ui.queryByTestId('c-order-paid-1')).toBeNull();
  });

  test('a receipt bound to the approved total shows Paid', () => {
    const { ui } = renderActions({ order: receipt(100), expectedAmountSats: 100 });
    expect(ui.getByTestId('c-order-paid-1')).toBeTruthy();
  });
});
