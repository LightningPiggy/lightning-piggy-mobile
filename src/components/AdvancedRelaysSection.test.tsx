import React from 'react';
import { fireEvent, render, within } from '@testing-library/react-native';
import AdvancedRelaysSection from './AdvancedRelaysSection';
import { MARMOT_KEY_PACKAGE_RELAYS } from '../services/marmotKeyPackageRelays';
import { lightPalette as mockPalette } from '../styles/palettes';
import { TEST_RELAY_URL } from '../config/testRelayLockdown';

let mockLocked = false;
jest.mock('../config/testRelayLockdown', () => ({
  TEST_RELAY_URL: 'ws://test-relay:7777',
  isTestRelayLockdown: () => mockLocked,
  lockRelays: (urls: readonly string[]) => (mockLocked ? ['ws://test-relay:7777'] : urls),
}));
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ pubkey: 'account' }) }));
jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => mockPalette }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: jest.fn() }) }));
jest.mock('../services/nostrService', () => ({ DEFAULT_RELAYS: [] }));
jest.mock('./NetworkSectionHeading', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ title }: { title: string }) => <Text>{title}</Text>,
  };
});
jest.mock('./RelaySettingsRow', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    __esModule: true,
    default: ({ url }: { url: string }) => <Text>{url}</Text>,
  };
});

it.each([false, true])('lists Marmot relays with lockdown=%s', (locked) => {
  mockLocked = locked;
  const ui = render(
    <AdvancedRelaysSection
      connection={new Map()}
      deviceRelays={[]}
      onRemoveDeviceRelay={jest.fn()}
    />,
  );
  expect(ui.queryByTestId('marmot-relay-list')).toBeNull();
  fireEvent.press(ui.getByTestId('advanced-relays-toggle'));
  expect(ui.getByText('nostrScreen.marmotRelays')).toBeTruthy();
  const list = within(ui.getByTestId('marmot-relay-list'));
  expect(list.getAllByText(/^(wss?|ws):\/\//).map((row) => row.props.children)).toEqual(
    locked ? [TEST_RELAY_URL] : MARMOT_KEY_PACKAGE_RELAYS,
  );
});
