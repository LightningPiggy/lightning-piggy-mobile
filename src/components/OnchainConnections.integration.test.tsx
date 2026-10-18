import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import OnChainScreen from '../screens/account/OnChainScreen';
import SwapBackendSettings from './SwapBackendSettings';

jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => jest.requireActual('../styles/palettes').lightPalette,
}));
jest.mock('../contexts/LocaleContext', () => {
  const translate = (key: string) => key;
  return { useTranslation: () => translate };
});
jest.mock('../contexts/WalletContext', () => ({ useWallet: () => ({ wallets: [] }) }));
jest.mock('../screens/account/AccountScreenLayout', () => {
  const { View } = jest.requireActual('react-native');
  return function TestAccountLayout({ children }: { children: React.ReactNode }) {
    return <View>{children}</View>;
  };
});
const mockSaveElectrum = jest.fn(async (..._args: unknown[]) => 'electrum.example:50002:s');
const mockCheckElectrum = jest.fn(async (..._args: unknown[]) => 1000000);
jest.mock('../services/onchainConnectionService', () => ({
  checkAndSaveElectrumServer: (...args: unknown[]) => mockSaveElectrum(...args),
  electrumSaveErrorKey: () => 'onChainScreen.errorUnreachable',
  checkElectrumConnection: (...args: unknown[]) => mockCheckElectrum(...args),
}));
const mockGetElectrum = jest.fn(async () => 'electrum.example:50002:s');
jest.mock('../services/walletStorageService', () => ({
  getElectrumServer: () => mockGetElectrum(),
  getDefaultOnchainWalletId: async () => null,
  setDefaultOnchainWalletId: jest.fn(),
}));
const mockCheckBoltz = jest.fn(async (..._args: unknown[]) => 'https://example.com/v2');
const mockSaveBoltz = jest.fn(async (..._args: unknown[]) => 'https://example.com/v2');
jest.mock('../services/swapBackendService', () => ({
  DEFAULT_SWAP_BACKEND: 'https://example.com/v2',
  getSwapBackend: async () => 'https://example.com/v2',
  checkSwapBackend: (...args: unknown[]) => mockCheckBoltz(...args),
  checkAndSaveSwapBackend: (...args: unknown[]) => mockSaveBoltz(...args),
  swapBackendSaveErrorKey: () => 'swapBackend.saveError',
}));
beforeEach(() => {
  jest.clearAllMocks();
});

test('Electrum tests the edited endpoint and clears the green result on SSL change', async () => {
  render(<OnChainScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('electrum-server-input').props.editable).toBe(true),
  );
  fireEvent.changeText(screen.getByTestId('electrum-server-input'), 'new.example:50002');
  await act(async () => fireEvent.press(screen.getByTestId('electrum-connection-test')));
  expect(mockCheckElectrum).toHaveBeenCalledWith(
    'new.example:50002',
    true,
    expect.any(AbortSignal),
  );
  expect(screen.getByTestId('electrum-connection-success')).toBeTruthy();
  await act(async () => fireEvent.press(screen.getByTestId('electrum-ssl-toggle')));
  expect(screen.queryByTestId('electrum-connection-success')).toBeNull();
  // Neither the SSL toggle nor leaving the field saves anything any more.
  fireEvent(screen.getByTestId('electrum-server-input'), 'blur');
  expect(mockSaveElectrum).not.toHaveBeenCalled();
});

test('Electrum saves only via its own button and shows the result under it', async () => {
  render(<OnChainScreen />);
  await waitFor(() =>
    expect(screen.getByTestId('electrum-server-input').props.editable).toBe(true),
  );
  fireEvent.changeText(screen.getByTestId('electrum-server-input'), 'mine.example:50002');
  await act(async () => fireEvent.press(screen.getByTestId('electrum-save')));
  expect(mockSaveElectrum).toHaveBeenCalledWith('mine.example:50002', true);
  expect(screen.getByText('onChainScreen.saved')).toBeTruthy();
  mockSaveElectrum.mockRejectedValueOnce(new Error('Electrum client error: timed out'));
  await act(async () => fireEvent.press(screen.getByTestId('electrum-save')));
  expect(screen.getByTestId('electrum-save-message')).toBeTruthy();
  expect(screen.getByText('onChainScreen.errorUnreachable')).toBeTruthy();
  expect(screen.queryByText(/timed out/)).toBeNull();
});

test('Boltz Test checks the unsaved draft without choosing it as the backend', async () => {
  render(<SwapBackendSettings />);
  await waitFor(() => expect(screen.getByTestId('swap-backend-url').props.editable).toBe(true));
  fireEvent.changeText(screen.getByTestId('swap-backend-url'), 'https://draft.example/v2');
  await act(async () => fireEvent.press(screen.getByTestId('boltz-connection-test')));
  expect(mockCheckBoltz).toHaveBeenCalledWith('https://draft.example/v2', expect.any(AbortSignal));
  expect(mockSaveBoltz).not.toHaveBeenCalled();
  expect(screen.getByTestId('boltz-connection-success')).toBeTruthy();
  fireEvent.changeText(screen.getByTestId('swap-backend-url'), 'https://other.example/v2');
  expect(screen.queryByTestId('boltz-connection-success')).toBeNull();
  await act(async () => fireEvent.press(screen.getByTestId('swap-backend-save')));
  expect(mockSaveBoltz).toHaveBeenCalledWith('https://other.example/v2');
});

test('failed Electrum settings load cannot silently save or test the public default', async () => {
  mockGetElectrum.mockRejectedValueOnce(new Error('storage unavailable'));
  render(<OnChainScreen />);
  await waitFor(() => expect(screen.getByTestId('electrum-settings-error')).toBeTruthy());
  expect(screen.getByTestId('electrum-connection-test').props.accessibilityState.disabled).toBe(
    true,
  );
  expect(screen.getByTestId('electrum-save').props.accessibilityState.disabled).toBe(true);
  await act(async () => {
    fireEvent.press(screen.getByTestId('electrum-save'));
    fireEvent.press(screen.getByTestId('electrum-connection-test'));
  });
  expect(mockSaveElectrum).not.toHaveBeenCalled();
  expect(mockCheckElectrum).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByTestId('electrum-server-input'), 'intended.example:50002');
  await act(async () => fireEvent.press(screen.getByTestId('electrum-connection-test')));
  expect(mockCheckElectrum).toHaveBeenCalledWith(
    'intended.example:50002',
    true,
    expect.any(AbortSignal),
  );
});
