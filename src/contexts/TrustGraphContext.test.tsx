import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { TrustGraphProvider, useTrustGraph } from './TrustGraphContext';
import type { WotSettings } from '../services/wotSettingsService';
import { liveNotificationAudience } from '../services/notificationAudience';
import { saveWotSettings } from '../services/wotSettingsService';

const STRANGER = 'f'.repeat(64);
let mockPubkey = 'big';
const mockKnown = new Map<string, WotSettings>();
const mockPending = new Map<string, (s: WotSettings) => void>();

jest.mock('./NostrContext', () => ({
  useNostr: () => ({ pubkey: mockPubkey }),
  useNostrContacts: () => ({ contacts: [] }),
}));
jest.mock('../services/wotSettingsService', () => ({
  notificationTierFor: jest.requireActual('../services/wotSettingsService').notificationTierFor,
  peekWotSettings: (pk: string | null) => (pk ? (mockKnown.get(pk) ?? null) : null),
  // Each load stays pending until the test resolves it (slow AsyncStorage).
  loadWotSettings: (pk: string) =>
    new Promise<WotSettings>((resolve) => {
      mockPending.set(pk, resolve);
    }),
  saveWotSettings: jest.fn(async () => {}),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TrustGraphProvider>{children}</TrustGraphProvider>
);

beforeEach(() => {
  mockPubkey = 'big';
  mockKnown.clear();
  mockPending.clear();
});

it('never widens to "all" while a Friends account is still loading (cold start or switch)', async () => {
  const { result, rerender } = renderHook(() => useTrustGraph(), { wrapper });
  // Unknown account: gated to the narrowest tier, strangers hidden.
  expect(result.current.wotTierReady).toBe(false);
  expect(result.current.wotTier).toBe('friends');
  expect(result.current.isTrusted(STRANGER)).toBe(false);
  await act(async () => mockPending.get('big')!({ wotTier: 'all' }));
  expect(result.current.wotTier).toBe('all');

  // Switch to Middle (set to Friends, not yet known): still gated, never 'all'.
  mockPubkey = 'middle';
  rerender({});
  expect(result.current.wotTierReady).toBe(false);
  expect(result.current.wotTier).toBe('friends');
  expect(result.current.isTrusted(STRANGER)).toBe(false);
  await act(async () => mockPending.get('middle')!({ wotTier: 'friends' }));
  expect(result.current.wotTierReady).toBe(true);
  expect(result.current.wotTier).toBe('friends');
});

it("renders a prewarmed account's tier on the first frame after a switch", () => {
  mockKnown.set('big', { wotTier: 'all' });
  mockKnown.set('middle', { wotTier: 'friends' });
  const { result, rerender } = renderHook(() => useTrustGraph(), { wrapper });
  expect(result.current.wotTier).toBe('all');
  mockPubkey = 'middle';
  rerender({});
  expect(result.current.wotTierReady).toBe(true);
  expect(result.current.wotTier).toBe('friends');
  mockPubkey = 'big';
  rerender({});
  expect(result.current.wotTier).toBe('all');
});

it('a load that resolves after the user picks a tier does not roll it back', async () => {
  const { result } = renderHook(() => useTrustGraph(), { wrapper });
  act(() => result.current.setWotTier('friends'));
  expect(result.current.wotTier).toBe('friends');
  await act(async () => mockPending.get('big')!({ wotTier: 'all' }));
  expect(result.current.wotTier).toBe('friends');
});

it('publishes the tier for notifications per account, live, and nothing while it loads', async () => {
  mockKnown.set('middle', { wotTier: 'fof', explicit: true });
  const { result, rerender, unmount } = renderHook(() => useTrustGraph(), { wrapper });
  // 'big' still loading: no audience, so notifications stay follows-only.
  expect(liveNotificationAudience('big')).toBeNull();
  // Unchosen 'all' (the #627 default): the list widens, notifications don't.
  await act(async () => mockPending.get('big')!({ wotTier: 'all' }));
  expect(result.current.wotTier).toBe('all');
  expect(liveNotificationAudience('big')).toEqual({ tier: 'friends', fof: null });
  // A derived tier (legacy migration) stays unchosen.
  act(() => result.current.setWotTier('all', { explicit: false }));
  expect(liveNotificationAudience('big')).toEqual({ tier: 'friends', fof: null });
  expect(saveWotSettings).toHaveBeenLastCalledWith({ wotTier: 'all' }, 'big');
  // Picked in the sheet: everyone, saved with the marker.
  act(() => result.current.setWotTier('all'));
  expect(liveNotificationAudience('big')).toEqual({ tier: 'all', fof: null });
  expect(saveWotSettings).toHaveBeenLastCalledWith({ wotTier: 'all', explicit: true }, 'big');
  // Switching away retracts the previous account's audience.
  mockPubkey = 'middle';
  rerender({});
  expect(liveNotificationAudience('big')).toBeNull();
  // Explicit FoF with no friends-of-friends set built yet: follows only.
  expect(liveNotificationAudience('middle')).toEqual({ tier: 'fof', fof: null });
  unmount();
  expect(liveNotificationAudience('middle')).toBeNull();
});
