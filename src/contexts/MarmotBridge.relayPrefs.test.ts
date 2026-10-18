import { act, renderHook } from '@testing-library/react-native';
import { MarmotBridge } from './MarmotBridge';
import { MarmotSession } from '../services/marmotSession';
import {
  loadAppRelayPrefs,
  setAppRelayEnabled,
  forgetAppRelayPrefs,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';

const mockOwner = 'a'.repeat(64);
const mockRelays = [{ url: 'wss://personal.example', read: true, write: true }];
const mockRefresh = jest.fn();
const mockStart = jest.fn(async () => {});
const mockSession = { pubkey: mockOwner, start: mockStart, refreshRelaySubscriptions: mockRefresh };
let mockActive: typeof mockSession | null = null;
jest.mock('./NostrContext', () => ({
  useNostr: () => ({
    isLoggedIn: true,
    pubkey: mockOwner,
    signerType: 'nsec',
    relays: mockRelays,
  }),
}));
jest.mock('../services/marmotSession', () => ({
  MarmotSession: jest.fn(() => mockSession),
  getMarmotSession: () => mockActive,
  setMarmotSession: (session: typeof mockSession | null) => {
    mockActive = session;
  },
}));
jest.mock('../services/marmotPushRegistration', () => ({ startMarmotPushRegistration: jest.fn() }));
jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('../i18n', () => ({ t: (s: string) => s }));

it('refreshes existing group subscriptions after hydration or edits without restarting MLS', async () => {
  await forgetAppRelayPrefs(mockOwner);
  setCurrentUserPubkey(mockOwner);
  jest.useFakeTimers();
  const { unmount } = renderHook(() => MarmotBridge());
  await act(async () => {
    jest.advanceTimersByTime(3000);
  });
  expect(MarmotSession).toHaveBeenCalledTimes(1);
  await act(async () => loadAppRelayPrefs(mockOwner));
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  await act(async () => setAppRelayEnabled(mockOwner, 'marmot', 'wss://marmot.example', false));
  expect(mockRefresh).toHaveBeenCalledTimes(2);
  expect(MarmotSession).toHaveBeenCalledTimes(1);
  expect(mockStart).toHaveBeenCalledTimes(1);
  unmount();
  expect(mockActive).toBeNull();
  jest.useRealTimers();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(mockOwner);
});
