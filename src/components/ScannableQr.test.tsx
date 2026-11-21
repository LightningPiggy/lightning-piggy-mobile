import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ScannableQr from './ScannableQr';

jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));

const mockSizes: number[] = [];
jest.mock('react-native-qrcode-svg', () => {
  const { Text } = jest.requireActual('react-native');
  return function MockQrCode({ value, size }: { value: string; size: number }) {
    mockSizes.push(size);
    return <Text>{value}</Text>;
  };
});

const invoice = 'lnbc210n1p4sqttmpp5sal3pcf68aat';

beforeEach(() => {
  mockSizes.length = 0;
});

it('opens the code full screen on tap, larger than the inline code, and closes on tap', () => {
  const view = render(<ScannableQr value={invoice} size={200} testID="pay" />);
  expect(view.queryByTestId('qr-fullscreen')).toBeNull();
  fireEvent.press(view.getByTestId('pay-expand'));
  expect(view.getByTestId('qr-fullscreen')).toBeTruthy();
  expect(Math.max(...mockSizes)).toBeGreaterThan(200);
  expect(view.getAllByText(invoice.toUpperCase())).toHaveLength(2);
  fireEvent.press(view.getByTestId('qr-fullscreen'));
  expect(view.queryByTestId('qr-fullscreen')).toBeNull();
});

it('renders a plain code when not expandable', () => {
  const view = render(<ScannableQr value={invoice} size={200} expandable={false} />);
  expect(view.queryByTestId('qr-expand')).toBeNull();
});
