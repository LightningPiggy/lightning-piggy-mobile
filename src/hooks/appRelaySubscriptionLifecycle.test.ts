import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  forgetAppRelayPrefs,
  loadAppRelayPrefs,
  setAppRelayEnabled,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { GC_RELAYS } from '../services/geocacheRelays';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import { pool } from '../services/nostrService';
import { useFoundLogIngest } from './useFoundLogIngest';
import { useNearbyCacheSubscription } from './useNearbyCacheSubscription';
import { useLiveUpdateRelaySubscriptions } from './useLiveUpdates';
import { subscribeSessionLiveUpdates } from '../services/nostrLiveLocation';
import type { FoundLog } from '../utils/foundLog';

jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: jest.requireActual('../services/nostrRelayDefaults').DEFAULT_RELAYS,
  pool: { subscribeMany: jest.fn() },
}));
jest.mock('../utils/foundLog', () => ({ parseFoundLog: (e: unknown) => e }));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('../services/nostrLiveLocation', () => ({
  subscribeSessionLiveUpdates: jest.fn(),
  subscribeLiveLocationPingsMulti: jest.fn(),
}));

const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);
const log = { id: 'find', pubkey: alice, createdAt: 1, content: 'Found' } as FoundLog;
const close = jest.fn();
const subscribe = jest.mocked(pool.subscribeMany);

beforeEach(async () => {
  jest.clearAllMocks();
  await forgetAppRelayPrefs(alice);
  await forgetAppRelayPrefs(bob);
  await AsyncStorage.clear();
  setCurrentUserPubkey(alice);
  subscribe.mockReturnValue({ close } as never);
  jest.mocked(subscribeSessionLiveUpdates).mockReturnValue(close);
});
afterEach(() => {
  setCurrentUserPubkey(null);
  jest.useRealTimers();
});

it('re-arms found logs and zaps after hydration and switches; ignores retired callbacks', async () => {
  jest.useFakeTimers();
  const { result, unmount } = renderHook(() => useFoundLogIngest('37516:hider:cache'));
  expect(subscribe.mock.calls[0][0]).toEqual([]);
  await act(async () => loadAppRelayPrefs(alice));
  expect(close).toHaveBeenCalledTimes(1);
  expect(subscribe.mock.lastCall?.[0]).toEqual(GC_RELAYS);
  act(() => result.current.addOptimisticLog(log));
  expect(subscribe.mock.lastCall?.[0]).toEqual(DEFAULT_RELAYS);
  const staleZap = subscribe.mock.lastCall![2].onevent!;
  const oldLog = subscribe.mock.calls.find((call) => call[0].length === GC_RELAYS.length)![2]
    .onevent!;
  await act(async () => setAppRelayEnabled(alice, 'geocache', GC_RELAYS[0], false));
  expect(result.current.logs.has(log.id)).toBe(true);
  expect(subscribe.mock.calls.some((call) => call[0].includes(GC_RELAYS[0]))).toBe(true);
  const activeLogs = subscribe.mock.calls.filter((call) => call[1].kinds?.[0] === 7516).at(-1)!;
  expect(activeLogs[0]).toEqual(GC_RELAYS.slice(1));
  await act(async () => setAppRelayEnabled(alice, 'default', DEFAULT_RELAYS[0], false));
  expect(subscribe.mock.lastCall?.[0]).toEqual(DEFAULT_RELAYS.slice(1));
  act(() => {
    oldLog({ ...log, id: 'stale' } as never);
    staleZap({ id: 'zap', tags: [['e', 'find']] } as never);
    jest.advanceTimersByTime(200);
  });
  expect(result.current.logs.has('stale')).toBe(false);
  expect(result.current.zapsByLog.size).toBe(0);
  const callsBefore = subscribe.mock.calls.length;
  await act(async () => setAppRelayEnabled(alice, 'geocache', GC_RELAYS[0], true));
  expect(subscribe.mock.calls.length).toBeGreaterThan(callsBefore);
  act(() => setCurrentUserPubkey(bob));
  expect(result.current.logs.size).toBe(0);
  expect(subscribe.mock.calls.filter((call) => call[1].kinds?.[0] === 7516).at(-1)![0]).toEqual([]);
  await act(async () => loadAppRelayPrefs(bob));
  expect(subscribe.mock.lastCall?.[0]).toEqual(GC_RELAYS);
  unmount();
});

it('re-arms an unchanged map viewport after hydration, preferences and account changes', async () => {
  const enqueue = jest.fn();
  const flush = jest.fn();
  const { result, unmount } = renderHook(() => useNearbyCacheSubscription({ enqueue, flush }));
  act(() => result.current.resubscribeForPrefixes(['u12']));
  expect(subscribe.mock.lastCall?.[0]).toEqual([]);
  await act(async () => loadAppRelayPrefs(alice));
  expect(subscribe.mock.lastCall?.[0]).toEqual(GC_RELAYS);
  const stale = subscribe.mock.lastCall![2].onevent!;
  await act(async () => setAppRelayEnabled(alice, 'geocache', GC_RELAYS[0], false));
  expect(close).toHaveBeenCalled();
  expect(subscribe.mock.lastCall?.[0]).toEqual(GC_RELAYS.slice(1));
  stale({ pubkey: alice, tags: [], kind: 37516 } as never);
  expect(enqueue).not.toHaveBeenCalled();
  act(() => setCurrentUserPubkey(bob));
  expect(subscribe.mock.lastCall?.[0]).toEqual([]);
  await act(async () => loadAppRelayPrefs(bob));
  expect(subscribe.mock.lastCall?.[0]).toEqual(GC_RELAYS);
  unmount();
});

it('refreshes live-location app defaults even when personal read URLs stay identical', async () => {
  const params = {
    shares: [
      {
        sender: bob,
        sessionId: 'share',
        startedAt: 1000,
        updateKey: { pubkey: bob, secret: 'secret' },
      },
    ],
    enabled: true,
    myPubkey: alice,
    signerType: 'nsec',
    relays: [{ url: 'wss://personal.example', read: true, write: true }],
  };
  const { unmount } = renderHook(() => useLiveUpdateRelaySubscriptions(params));
  const live = jest.mocked(subscribeSessionLiveUpdates);
  expect(live.mock.lastCall![0].relays).toEqual(['wss://personal.example']);
  await act(async () => loadAppRelayPrefs(alice));
  expect(live.mock.lastCall![0].relays).toContain(DEFAULT_RELAYS[0]);
  await act(async () => setAppRelayEnabled(alice, 'default', DEFAULT_RELAYS[0], false));
  expect(close).toHaveBeenCalled();
  expect(live.mock.lastCall![0].relays).not.toContain(DEFAULT_RELAYS[0]);
  expect(live.mock.lastCall![0].relays).toContain('wss://personal.example');
  unmount();
});
