import { act, renderHook } from '@testing-library/react-native';
import type { ParsedCache } from '../services/nostrPlacesService';
import type { NearbyCachesCompletion } from '../services/nostrPlacesPublisher';
import { encodeGeohash } from '../utils/geohash';
import { useExploreRelayContent } from './useExploreRelayContent';

const mockSubscribeCaches = jest.fn();
const mockClose = jest.fn();
const mockFetchByAuthor = jest.fn(async (): Promise<ParsedCache[]> => []);
const mockIsTrusted = jest.fn(() => true);
let mockPubkey: string | null = null;
let mockSeed: ParsedCache[] = [];

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(effect, [effect]);
  },
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockPubkey, relays: [] }),
}));
jest.mock('../contexts/TrustGraphContext', () => ({
  useTrustGraph: () => ({ isTrusted: mockIsTrusted }),
}));
jest.mock('../services/nostrPlacesPublisher', () => ({
  fetchCachesByAuthor: () => mockFetchByAuthor(),
  subscribeNearbyCaches: (...args: unknown[]) => mockSubscribeCaches(...args),
  subscribeNearbyEvents: () => jest.fn(),
}));
jest.mock('../services/nostrPlacesStorage', () => ({
  peekCachedCachesSync: () => mockSeed,
  peekCachedEventsSync: () => [],
  loadCachedCaches: async () => [],
  loadCachedEvents: async () => [],
}));
jest.mock('./useExplorePlacesPersist', () => ({
  usePersistCaches: jest.fn(),
  usePersistEvents: jest.fn(),
}));
jest.mock('../utils/exploreContentFilter', () => ({
  isHiddenInProd: (pubkey: string) => pubkey === 'hidden-in-prod',
  visibleCaches: (caches: ParsedCache[]) =>
    caches.filter((cache) => cache.hiderPubkey !== 'hidden-in-prod'),
  visibleEvents: () => [],
}));

const pos = { lat: 51.5, lon: -0.1, accuracy: null };
const cache = {
  coord: 'cache',
  createdAt: 1,
  hiderPubkey: 'hider',
  geohash: 'gcpuv',
} as ParsedCache;
const callbacks = (index = 0) => ({
  event: mockSubscribeCaches.mock.calls[index][1] as (cache: ParsedCache) => void,
  complete: mockSubscribeCaches.mock.calls[index][4] as (result: NearbyCachesCompletion) => void,
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockFetchByAuthor.mockResolvedValue([]);
  mockSeed = [];
  mockPubkey = null;
  mockIsTrusted.mockReturnValue(true);
  mockSubscribeCaches.mockReturnValue(mockClose);
});
afterEach(() => jest.useRealTimers());

it('shows empty only after every widening stage finds nothing', async () => {
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  expect(result.current.cacheRailState).toBe('loading');
  act(() => {
    callbacks().complete({ allRelaysFailed: false });
    callbacks(1).complete({ allRelaysFailed: false });
    callbacks(2).complete({ allRelaysFailed: false });
  });
  expect(result.current.cacheRailState).toBe('empty');
});

it('flushes coalesced caches at completion and accepts late content after empty', async () => {
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => {
    callbacks().event(cache);
    callbacks().complete({ allRelaysFailed: false });
  });
  expect(result.current.cacheRailState).toBe('ready');
  expect(result.current.sortedCaches[0].cache).toEqual(cache);
});

it('turns a completed empty query ready when a late event arrives', async () => {
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => {
    callbacks().complete({ allRelaysFailed: false });
    callbacks(1).complete({ allRelaysFailed: false });
    callbacks(2).complete({ allRelaysFailed: false });
  });
  expect(result.current.cacheRailState).toBe('empty');
  act(() => {
    callbacks().event(cache);
    jest.advanceTimersByTime(100);
  });
  expect(result.current.cacheRailState).toBe('ready');
});

it('resets on retry and ignores completion from the previous query', async () => {
  const { result, rerender } = renderHook(
    ({ key }: { key: number }) => useExploreRelayContent(pos, key),
    {
      initialProps: { key: 0 },
    },
  );
  await act(async () => {});
  act(() => {
    callbacks().complete({ allRelaysFailed: true });
    callbacks(1).complete({ allRelaysFailed: true });
    callbacks(2).complete({ allRelaysFailed: true });
  });
  expect(result.current.cacheRailState).toBe('error');
  rerender({ key: 1 });
  expect(mockClose).toHaveBeenCalledTimes(5);
  expect(result.current.cacheRailState).toBe('loading');
  act(() => callbacks(0).complete({ allRelaysFailed: true }));
  expect(result.current.cacheRailState).toBe('loading');
  act(() => {
    callbacks(3).complete({ allRelaysFailed: false });
    callbacks(4).complete({ allRelaysFailed: false });
    callbacks(5).complete({ allRelaysFailed: false });
  });
  expect(result.current.cacheRailState).toBe('empty');
});

it('keeps visible disk content ready even if every relay fails', async () => {
  mockSeed = [cache];
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  expect(result.current.cacheRailState).toBe('ready');
  act(() => callbacks().complete({ allRelaysFailed: true }));
  expect(result.current.cacheRailState).toBe('ready');
});

it('always sorts by distance ignoring radius, includes own caches, and caps at fifty', async () => {
  mockPubkey = 'mine';
  mockSeed = Array.from({ length: 55 }, (_, i) => ({
    ...cache,
    coord: `cache-${i}`,
    geohash: encodeGeohash(53 + i * 0.01, -0.1, 9),
  })).reverse();
  mockSeed.push({ ...cache, coord: 'own', hiderPubkey: 'mine', geohash: 'u4pru' });
  const { result, rerender } = renderHook(
    ({ radius }: { radius: number }) => useExploreRelayContent(pos, 0, radius),
    {
      initialProps: { radius: 1000 },
    },
  );
  await act(async () => {});
  const expected = Array.from({ length: 50 }, (_, i) => `cache-${i}`);
  expect(result.current.sortedCaches.map((c) => c.cache.coord)).toEqual(expected);
  expect(result.current.sortedCaches.every((c) => Number.isFinite(c.distance))).toBe(true);
  rerender({ radius: 1_000_000 });
  expect(result.current.sortedCaches.map((c) => c.cache.coord)).toEqual(expected);
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(1);
});

it('widens only under ten known caches, stops at precision 3, and stays loading until done', async () => {
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  expect(result.current.cacheRailState).toBe('loading');
  act(() => callbacks(1).complete({ allRelaysFailed: false }));
  expect(result.current.cacheRailState).toBe('loading');
  act(() => callbacks(2).complete({ allRelaysFailed: false }));
  expect(result.current.cacheRailState).toBe('empty');
  expect(mockSubscribeCaches.mock.calls.map((c) => c[0].map((g: string) => g.length))).toEqual(
    [5, 4, 3].map((precision) => Array(9).fill(precision)),
  );
  expect(mockSubscribeCaches.mock.calls[1][3]).toEqual({ limit: 100 });
});

it('stops widening once ten distinct coalesced caches arrive', async () => {
  renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  act(() => {
    for (let i = 0; i < 10; i++) callbacks(1).event({ ...cache, coord: `cache-${i}` });
    callbacks(1).complete({ allRelaysFailed: false });
  });
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(2);
});

it('bounds widening by the outer deadline and cancels events on teardown', async () => {
  const { result, unmount } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  act(() => jest.advanceTimersByTime(3 * 8000));
  expect(result.current.cacheRailState).toBe('empty');
  act(() => callbacks(1).complete({ allRelaysFailed: false }));
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(2);
  unmount();
  act(() => callbacks(1).event(cache));
  expect(jest.getTimerCount()).toBe(0);
});

it('keeps loading for filtered events then shows empty with the hidden count', async () => {
  mockIsTrusted.mockReturnValue(false);
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => {
    callbacks().event(cache);
    jest.advanceTimersByTime(100);
  });
  expect(result.current.cacheRailState).toBe('loading');
  act(() => {
    callbacks().complete({ allRelaysFailed: false });
    callbacks(1).complete({ allRelaysFailed: false });
    callbacks(2).complete({ allRelaysFailed: false });
  });
  expect(result.current.cacheRailState).toBe('empty');
  expect(result.current.untrustedCacheCount).toBe(1);
});

it('does not query or load forever without a location', async () => {
  const { result } = renderHook(() => useExploreRelayContent(null, 0));
  await act(async () => {});
  expect(mockSubscribeCaches).not.toHaveBeenCalled();
  expect(result.current.cacheRailState).toBe('empty');
});

it('orders own caches by distance alongside everyone else', async () => {
  mockPubkey = 'mine';
  mockSeed = [cache, { ...cache, coord: 'own', hiderPubkey: 'mine', geohash: 'u4pru' }];
  const { result } = renderHook(() => useExploreRelayContent(pos, 0, 100_000));
  await act(async () => {});
  expect(result.current.sortedCaches.map((c) => c.cache.coord)).toEqual(['cache', 'own']);
});

it('preserves radius filtering without a position fix', async () => {
  mockSeed = [cache];
  const { result } = renderHook(() => useExploreRelayContent(null, 0, 100_000));
  await act(async () => {});
  expect(result.current.sortedCaches).toEqual([]);
  expect(result.current.cacheRailState).toBe('empty');
});

it('ignores events and completion from widening after blur/teardown', async () => {
  const { result, unmount } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  unmount();
  const timersAfterUnmount = jest.getTimerCount();
  act(() => {
    callbacks(1).event(cache);
    callbacks(1).complete({ allRelaysFailed: false });
  });
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(2);
  expect(result.current.caches.size).toBe(0);
  expect(jest.getTimerCount()).toBe(timersAfterUnmount);
});

it('still widens when the initial query completes at its eight-second deadline', async () => {
  const { result } = renderHook(() => useExploreRelayContent(pos, 0));
  await act(async () => {});
  act(() => {
    jest.advanceTimersByTime(8000);
    callbacks().complete({ allRelaysFailed: false });
  });
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(2);
  expect(result.current.cacheRailState).toBe('loading');
});

it('counts nearby own caches toward the widening threshold', async () => {
  mockPubkey = 'mine';
  mockSeed = Array.from({ length: 10 }, (_, i) => ({
    ...cache,
    coord: `own-${i}`,
    hiderPubkey: 'mine',
    geohash: encodeGeohash(pos.lat, pos.lon, 9),
  }));
  renderHook(() => useExploreRelayContent(pos, 0, 1000));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(1);
});

it('does not count hidden disk caches or caches without coordinates', async () => {
  mockSeed = Array.from({ length: 10 }, (_, i) => ({
    ...cache,
    coord: `hidden-${i}`,
    hiderPubkey: 'hidden-in-prod',
  }));
  mockSeed.push(
    ...Array.from({ length: 10 }, (_, i) => ({
      ...cache,
      coord: `unlocated-${i}`,
      geohash: null,
    })),
  );
  renderHook(() => useExploreRelayContent(pos, 0, 1000));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(2);
});

it('widens past distant cached candidates to discover closer caches', async () => {
  mockSeed = Array.from({ length: 10 }, (_, i) => ({
    ...cache,
    coord: `fallback-${i}`,
    geohash: encodeGeohash(53 + i * 0.1, -0.1, 9),
  }));
  const { result } = renderHook(() => useExploreRelayContent(pos, 0, 1000));
  await act(async () => {});
  act(() => callbacks().complete({ allRelaysFailed: false }));
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(2);
  const nearby = { ...cache, coord: 'nearby', geohash: encodeGeohash(pos.lat, pos.lon, 9) };
  act(() => {
    callbacks(1).event(nearby);
    callbacks(1).complete({ allRelaysFailed: false });
  });
  expect(mockSubscribeCaches).toHaveBeenCalledTimes(3);
  act(() => callbacks(2).complete({ allRelaysFailed: false }));
  expect(result.current.sortedCaches.map((item) => item.cache)).toEqual([nearby, ...mockSeed]);
  expect(result.current.cacheRailState).toBe('ready');
});
