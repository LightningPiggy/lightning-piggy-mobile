// #565: friends-of-friends is built on demand, cancel-safe, capped, and
// costs nothing for anyone not on the 'fof' tier.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import { fetchFollowLists } from '../services/followListsFetcher';
import * as fofService from '../services/friendsOfFriendsService';
import {
  __resetFofMemory,
  fofCacheKey,
  FOF_CACHE_TTL_MS,
  persistFofCache,
} from '../services/friendsOfFriendsService';
import type { WotTier } from '../services/wotSettingsService';
import {
  L2_BACKGROUND_REFRESH_DELAY_MS,
  L2_RESUME_CHECK_DELAY_MS,
  useTrustGraphL2,
  WOT_FOF_MAX,
} from './useTrustGraphL2';

jest.mock('../services/followListsFetcher', () => ({ fetchFollowLists: jest.fn() }));

const fetchMock = fetchFollowLists as jest.MockedFunction<typeof fetchFollowLists>;
const pk = (label: string, n = 0) => `${label}_${n}`.padStart(64, '0').slice(-64);
const USER = pk('user');
const FRIENDS: ReadonlySet<string> = new Set([pk('a'), pk('b')]);
const SHARED = pk('shared');

const abortable = (signal?: AbortSignal) =>
  new Promise<Record<string, string[]>>((_, reject) => {
    signal?.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
    );
  });

const render = (wotTier: WotTier, persistTier = jest.fn(), friends = FRIENDS) => {
  const hook = renderHook(
    (props: { wotTier: WotTier }) =>
      useTrustGraphL2({
        pubkey: USER,
        friends,
        readRelays: ['wss://relay.example'],
        wotTier: props.wotTier,
        wotTierReady: true,
        persistTier,
      }),
    { initialProps: { wotTier } },
  );
  return { ...hook, persistTier };
};

const flush = () => act(async () => {});

beforeEach(async () => {
  jest.useRealTimers();
  await AsyncStorage.clear();
  __resetFofMemory();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (batch) =>
    Object.fromEntries(batch.map((f) => [f, [SHARED, pk(`only-${f.slice(-3)}`)]])),
  );
});

it('reads and fetches nothing while the tier is not fof', async () => {
  jest.useFakeTimers();
  const getItem = AsyncStorage.getItem as jest.Mock;
  getItem.mockClear();
  const { result } = render('friends');
  await act(async () => {
    jest.advanceTimersByTime(L2_BACKGROUND_REFRESH_DELAY_MS * 3);
  });
  expect(getItem).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.l2Follows.size).toBe(0);
});

it('builds the capped set on demand and only then switches the tier', async () => {
  const { result, persistTier } = render('friends');
  await act(async () => result.current.enableFof());
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(persistTier).toHaveBeenCalledWith('fof');
  expect(result.current.l2Follows.has(SHARED)).toBe(true);
  expect(result.current.status).toEqual({ building: false, progress: null, failed: false });
  expect(await AsyncStorage.getItem(fofCacheKey(USER, WOT_FOF_MAX))).not.toBeNull();
});

it('switches instantly from a fresh cached set without touching relays', async () => {
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([SHARED]), excludedFriends: 0, computedAt: Date.now() },
    WOT_FOF_MAX,
  );
  const { result, persistTier } = render('friends');
  await act(async () => result.current.enableFof());
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(persistTier).toHaveBeenCalledWith('fof');
  expect([...result.current.l2Follows]).toEqual([SHARED]);
});

it('cancel keeps the tier, persists nothing and clears the progress', async () => {
  fetchMock.mockImplementation((_batch, _relays, signal) => abortable(signal));
  const { result, persistTier } = render('friends');
  await act(async () => result.current.enableFof());
  await flush();
  expect(result.current.status.building).toBe(true);
  // The total (friends to check) is known before the first batch lands.
  expect(result.current.status.progress).toEqual({ done: 0, total: 2 });
  act(() => result.current.cancelL2());
  await flush();
  expect(result.current.status).toEqual({ building: false, progress: null, failed: false });
  expect(persistTier).not.toHaveBeenCalled();
  expect(result.current.l2Follows.size).toBe(0);
  expect(await AsyncStorage.getItem(fofCacheKey(USER, WOT_FOF_MAX))).toBeNull();
});

it('a relay failure keeps the tier and reports it', async () => {
  fetchMock.mockRejectedValue(new Error('No follow-list relay answered'));
  const { result, persistTier } = render('friends');
  await act(async () => result.current.enableFof());
  await flush();
  expect(result.current.status).toEqual({ building: false, progress: null, failed: true });
  expect(persistTier).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(fofCacheKey(USER, WOT_FOF_MAX))).toBeNull();
});

it('a persisted fof tier shows the stale set at once and refreshes it after startup settles', async () => {
  jest.useFakeTimers();
  const old = pk('old');
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([old]), excludedFriends: 0, computedAt: Date.now() - 2 * 24 * 3600_000 },
    WOT_FOF_MAX,
  );
  const { result, persistTier } = render('fof');
  await flush();
  expect([...result.current.l2Follows]).toEqual([old]);
  expect(fetchMock).not.toHaveBeenCalled();

  await act(async () => {
    jest.advanceTimersByTime(L2_BACKGROUND_REFRESH_DELAY_MS);
  });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(result.current.l2Follows.has(SHARED)).toBe(true);
  expect(persistTier).not.toHaveBeenCalled(); // already on fof
});

it('a persisted fof tier with a fresh set never refetches', async () => {
  jest.useFakeTimers();
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([SHARED]), excludedFriends: 0, computedAt: Date.now() },
    WOT_FOF_MAX,
  );
  const { result } = render('fof');
  await flush();
  await act(async () => {
    jest.advanceTimersByTime(L2_BACKGROUND_REFRESH_DELAY_MS * 3);
  });
  expect(fetchMock).not.toHaveBeenCalled();
  expect([...result.current.l2Follows]).toEqual([SHARED]);
});

it('a stale set is replaced by one the Market built meanwhile, without refetching', async () => {
  jest.useFakeTimers();
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([SHARED]), excludedFriends: 0, computedAt: Date.now() - FOF_CACHE_TTL_MS - 1 },
    WOT_FOF_MAX,
  );
  const { result } = render('fof');
  await flush();
  expect([...result.current.l2Follows]).toEqual([SHARED]);
  // The Market's friends-of-friends scope builds the shared set before the
  // background rebuild is due.
  const fresh = pk('fresh');
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([fresh]), excludedFriends: 0, computedAt: Date.now() },
    WOT_FOF_MAX,
  );
  await act(async () => {
    jest.advanceTimersByTime(L2_BACKGROUND_REFRESH_DELAY_MS);
  });
  await flush();
  expect(fetchMock).not.toHaveBeenCalled();
  expect([...result.current.l2Follows]).toEqual([fresh]);
  expect(result.current.status.building).toBe(false);
});

it('with no direct friends left, a previously cached set is neither read nor trusted', async () => {
  jest.useFakeTimers();
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([SHARED]), excludedFriends: 0, computedAt: Date.now() },
    WOT_FOF_MAX,
  );
  const getItem = AsyncStorage.getItem as jest.Mock;
  getItem.mockClear();
  const { result } = render('fof', jest.fn(), new Set());
  await act(async () => {
    jest.advanceTimersByTime(L2_BACKGROUND_REFRESH_DELAY_MS * 3);
  });
  expect(getItem).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
  expect(result.current.l2Follows.size).toBe(0);
});

it('a set that expires while the app is backgrounded is rebuilt after resume', async () => {
  jest.useFakeTimers();
  let onChange: ((s: AppStateStatus) => void) | undefined;
  // Once only: AppState.addEventListener is already a jest mock, and
  // restoring a spy on it would wipe its default implementation.
  jest.spyOn(AppState, 'addEventListener').mockImplementationOnce((_type, cb) => {
    onChange = cb as (s: AppStateStatus) => void;
    return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([SHARED]), excludedFriends: 0, computedAt: Date.now() },
    WOT_FOF_MAX,
  );
  const { result } = render('fof');
  await flush();
  expect([...result.current.l2Follows]).toEqual([SHARED]);

  // A day later the user reopens the app.
  jest.setSystemTime(Date.now() + FOF_CACHE_TTL_MS + 1);
  await act(async () => {
    onChange?.('active');
    jest.advanceTimersByTime(L2_RESUME_CHECK_DELAY_MS);
  });
  await flush();
  expect(fetchMock).not.toHaveBeenCalled(); // still staggered
  await act(async () => {
    jest.advanceTimersByTime(L2_BACKGROUND_REFRESH_DELAY_MS);
  });
  await flush();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('a new but equal friends Set (profile hydration) does not re-read the cache', async () => {
  await persistFofCache(
    USER,
    [...FRIENDS],
    { set: new Set([SHARED]), excludedFriends: 0, computedAt: Date.now() },
    WOT_FOF_MAX,
  );
  // Counted at the service: the set is in memory, so storage isn't touched.
  const loads = jest.spyOn(fofService, 'loadFofCache');
  const persistTier = jest.fn(); // stable, as the context's useCallback is
  const { rerender } = renderHook(
    (props: { friends: ReadonlySet<string> }) =>
      useTrustGraphL2({
        pubkey: USER,
        friends: props.friends,
        readRelays: ['wss://relay.example'], // new array each render, same content
        wotTier: 'fof',
        wotTierReady: true,
        persistTier,
      }),
    { initialProps: { friends: new Set(FRIENDS) as ReadonlySet<string> } },
  );
  await flush();
  const reads = loads.mock.calls.length;
  expect(reads).toBeGreaterThan(0);
  for (let i = 0; i < 3; i += 1) {
    rerender({ friends: new Set([...FRIENDS].reverse()) });
    await flush();
  }
  expect(loads.mock.calls.length).toBe(reads);
  loads.mockRestore();
});
