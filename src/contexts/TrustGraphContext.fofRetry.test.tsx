// #565 review: re-picking Friends of friends retries a failed build, even
// while the previous (stale) set is still in use — but never re-fetches a
// healthy set on an accidental re-tap.
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { TrustGraphProvider, useTrustGraph } from './TrustGraphContext';
import { liveNotificationAudience } from '../services/notificationAudience';
import { saveWotSettings } from '../services/wotSettingsService';

let mockTier = 'fof';
const mockL2 = {
  l2Follows: new Set(['a'.repeat(64)]) as ReadonlySet<string>,
  status: { building: false, progress: null, failed: false },
  enableFof: jest.fn(),
  cancelL2: jest.fn(),
  refreshL2: jest.fn(async () => {}),
};

jest.mock('./NostrContext', () => ({
  useNostr: () => ({ pubkey: 'big', relays: [] }),
  useNostrContacts: () => ({ contacts: [] }),
}));
jest.mock('../services/wotSettingsService', () => ({
  notificationTierFor: jest.requireActual('../services/wotSettingsService').notificationTierFor,
  peekWotSettings: () => ({ wotTier: mockTier }),
  loadWotSettings: () => new Promise(() => {}),
  saveWotSettings: jest.fn(async () => {}),
}));
jest.mock('./useTrustGraphL2', () => ({ useTrustGraphL2: () => mockL2 }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TrustGraphProvider>{children}</TrustGraphProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
  mockTier = 'fof';
  mockL2.status = { building: false, progress: null, failed: false };
});

it('does not re-fetch a healthy set when Friends of friends is tapped again', () => {
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  act(() => result.current.setWotTier('fof'));
  expect(mockL2.refreshL2).not.toHaveBeenCalled();
  expect(mockL2.enableFof).not.toHaveBeenCalled();
});

it('retries when the last build failed, even with a stale set in use', () => {
  mockL2.status = { building: false, progress: null, failed: true };
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  act(() => result.current.setWotTier('fof'));
  expect(mockL2.refreshL2).toHaveBeenCalledTimes(1);
});

it('does not start a second build while one is running', () => {
  mockL2.status = { building: true, progress: null, failed: true };
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  act(() => result.current.setWotTier('fof'));
  expect(mockL2.refreshL2).not.toHaveBeenCalled();
});

it('re-picking Friends of friends while its first build runs does not restart it', () => {
  mockTier = 'friends';
  mockL2.status = { building: true, progress: null, failed: false };
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  act(() => result.current.setWotTier('fof'));
  expect(mockL2.enableFof).not.toHaveBeenCalled();
  expect(mockL2.refreshL2).not.toHaveBeenCalled();
});

it('re-picking Friends of friends records the explicit choice without a build (#1764)', () => {
  // Saved before the explicit marker existed: notifies like Friends.
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  expect(liveNotificationAudience('big')?.tier).toBe('friends');
  act(() => result.current.setWotTier('fof'));
  expect(saveWotSettings).toHaveBeenCalledWith({ wotTier: 'fof', explicit: true }, 'big');
  expect(liveNotificationAudience('big')).toEqual({ tier: 'fof', fof: mockL2.l2Follows });
  expect(mockL2.enableFof).not.toHaveBeenCalled();
  expect(mockL2.refreshL2).not.toHaveBeenCalled();
});

it('re-picking Friends of friends during a build saves nothing', () => {
  mockL2.status = { building: true, progress: null, failed: false };
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  act(() => result.current.setWotTier('fof'));
  expect(saveWotSettings).not.toHaveBeenCalled();
});
