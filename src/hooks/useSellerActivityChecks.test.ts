import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { checkSellerActivity } from '../services/sellerActivityService';
import { useSellerActivityChecks } from './useSellerActivityChecks';
const mockContacts: never[] = [];
const mockRelays = [{ url: 'wss://test', read: true, write: true }];
let mockPubkey: string | null = 'a'.repeat(64);
const mockT = (key: string) => key;
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockPubkey, relays: mockRelays }),
  useNostrContacts: () => ({ contacts: mockContacts }),
}));
jest.mock('../contexts/GroupsContext', () => ({
  useGroups: () => ({ effectiveWotTier: 'friends' }),
}));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => mockT }));
jest.mock('../services/nostrService', () => ({ DEFAULT_RELAYS: ['wss://fallback'] }));
jest.mock('../services/sellerActivityService', () => ({
  checkSellerActivity: jest.fn(async () => {}),
}));
let onChange: (state: AppStateStatus) => void;
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockPubkey = 'a'.repeat(64);
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, handler) => {
    onChange = handler;
    return { remove: jest.fn() };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
it('checks on Notifications focus and aborts on blur/unmount', () => {
  const { unmount } = renderHook(() => useSellerActivityChecks('focus'));
  expect(checkSellerActivity).toHaveBeenCalledTimes(1);
  const input = jest.mocked(checkSellerActivity).mock.calls[0][0];
  expect(input.onlyFriends).toBe(true);
  unmount();
  expect(input.signal.aborted).toBe(true);
});
it('staggered resume checks once, cancels bounces, and aborts in-flight work on background', () => {
  const { unmount } = renderHook(() => useSellerActivityChecks('resume'));
  expect(checkSellerActivity).not.toHaveBeenCalled();
  act(() => {
    onChange('active');
    jest.advanceTimersByTime(3000);
  });
  expect(checkSellerActivity).not.toHaveBeenCalled();
  act(() => {
    onChange('background');
    jest.advanceTimersByTime(500);
  });
  expect(checkSellerActivity).not.toHaveBeenCalled();
  act(() => {
    onChange('active');
    onChange('active');
    jest.advanceTimersByTime(3500);
  });
  expect(checkSellerActivity).toHaveBeenCalledTimes(1);
  const input = jest.mocked(checkSellerActivity).mock.calls[0][0];
  act(() => onChange('background'));
  expect(input.signal.aborted).toBe(true);
  act(() => onChange('active'));
  unmount();
  act(() => jest.advanceTimersByTime(3500));
  expect(checkSellerActivity).toHaveBeenCalledTimes(1);
});
it('drops scheduled work when accounts change and does not fetch while signed out', () => {
  const { rerender, unmount } = renderHook(() => useSellerActivityChecks('resume'));
  act(() => onChange('active'));
  mockPubkey = null;
  rerender({});
  act(() => jest.advanceTimersByTime(3500));
  expect(checkSellerActivity).not.toHaveBeenCalled();
  act(() => {
    onChange('active');
    jest.advanceTimersByTime(3500);
  });
  expect(checkSellerActivity).not.toHaveBeenCalled();
  unmount();
});
