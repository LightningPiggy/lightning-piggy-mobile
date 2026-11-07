// #565 review: re-picking Friends of friends retries a failed build, even
// while the previous (stale) set is still in use — but never re-fetches a
// healthy set on an accidental re-tap.
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { TrustGraphProvider, useTrustGraph } from './TrustGraphContext';

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
  peekWotSettings: () => ({ wotTier: 'fof' }),
  loadWotSettings: () => new Promise(() => {}),
  saveWotSettings: jest.fn(async () => {}),
}));
jest.mock('./useTrustGraphL2', () => ({ useTrustGraphL2: () => mockL2 }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TrustGraphProvider>{children}</TrustGraphProvider>
);

beforeEach(() => {
  jest.clearAllMocks();
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
