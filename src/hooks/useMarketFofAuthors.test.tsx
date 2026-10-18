import { act, renderHook } from '@testing-library/react-native';
import { __resetMarketFofMemo, useMarketFofAuthors } from './useMarketFofAuthors';
import { computeFofSet, loadFofCache } from '../services/friendsOfFriendsService';
import { fetchFollowLists } from '../services/followListsFetcher';
import { MARKET_FOF_MAX } from '../utils/marketFofScope';

jest.mock('../services/friendsOfFriendsService', () => ({
  computeFofSet: jest.fn(),
  loadFofCache: jest.fn(),
  FOF_CACHE_TTL_MS: jest.requireActual('../services/friendsOfFriendsService').FOF_CACHE_TTL_MS,
}));
jest.mock('../services/followListsFetcher', () => ({ fetchFollowLists: jest.fn() }));
const hex = (n: number) => n.toString(16).padStart(64, '0');
let mockViewer = hex(0xfeed);
let mockFocused = true;
const mockContacts = [
  { pubkey: '1'.padStart(64, '0').toUpperCase() },
  { pubkey: '2'.padStart(64, '0') },
];
const mockRelays = [{ url: 'wss://read.example', read: true, write: true }];
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockViewer, relays: mockRelays }),
  useNostrContacts: () => ({ contacts: mockContacts }),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(() => (mockFocused ? callback() : undefined), [callback]);
  },
}));
const compute = computeFofSet as jest.Mock;
const loadCache = loadFofCache as jest.Mock;

beforeEach(() => {
  __resetMarketFofMemo();
  mockFocused = true;
  mockViewer = hex(0xfeed);
  compute.mockReset();
  loadCache.mockReset().mockResolvedValue(null);
  (fetchFollowLists as jest.Mock).mockReset().mockResolvedValue({});
});

it('does nothing while the scope is inactive', () => {
  const h = renderHook(() => useMarketFofAuthors(false));
  expect(loadCache).not.toHaveBeenCalled();
  expect(h.result.current.authors).toBeUndefined();
});

it('builds the set with the shared FoF service: follows first, then ranked FoF', async () => {
  let resolve!: (r: { set: Set<string> }) => void;
  compute.mockImplementation(
    (_user, _friends, opts: { onProgress: (d: number, t: number) => void }) => {
      opts.onProgress(1, 3);
      return new Promise((r) => (resolve = r));
    },
  );
  const h = renderHook(() => useMarketFofAuthors(true));
  await act(async () => {});
  expect(loadCache).toHaveBeenCalledWith(mockViewer, [hex(1), hex(2)], MARKET_FOF_MAX);
  const [user, friends, opts] = compute.mock.calls[0];
  expect(user).toBe(mockViewer);
  expect(friends).toEqual([hex(1), hex(2)]);
  expect(opts.maxSize).toBe(MARKET_FOF_MAX);
  // The injected relay layer is the kind-3 fetcher, on the user's read relays.
  await opts.fetchKind3([hex(1)]);
  expect(fetchFollowLists).toHaveBeenCalledWith([hex(1)], ['wss://read.example'], opts.signal);
  expect(h.result.current.authors).toBeUndefined();
  expect(h.result.current.progress).toEqual({ done: 1, total: 3 });
  await act(async () => resolve({ set: new Set([hex(9), hex(2), hex(8)]) }));
  expect(h.result.current.authors).toEqual([hex(1), hex(2), hex(9), hex(8)]);
  expect(h.result.current.progress).toBeNull();
});

it('reuses the service cache without recomputing, and the in-memory set on remount', async () => {
  loadCache.mockResolvedValue({
    set: new Set([hex(7)]),
    excludedFriends: 0,
    computedAt: Date.now(),
  });
  const h = renderHook(() => useMarketFofAuthors(true));
  await act(async () => {});
  expect(compute).not.toHaveBeenCalled();
  expect(h.result.current.authors).toEqual([hex(1), hex(2), hex(7)]);
  h.unmount();
  loadCache.mockClear();
  const again = renderHook(() => useMarketFofAuthors(true));
  expect(again.result.current.authors).toEqual([hex(1), hex(2), hex(7)]);
  await act(async () => {});
  expect(loadCache).not.toHaveBeenCalled();
});

it('falls back to the follows alone when the build fails', async () => {
  compute.mockRejectedValue(new Error('relays down'));
  const h = renderHook(() => useMarketFofAuthors(true));
  await act(async () => {});
  expect(h.result.current.failed).toBe(true);
  expect(h.result.current.authors).toEqual([hex(1), hex(2)]);
});

it('aborts the build when the scope is switched off', async () => {
  compute.mockImplementation(() => new Promise(() => {}));
  const h = renderHook(({ on }: { on: boolean }) => useMarketFofAuthors(on), {
    initialProps: { on: true },
  });
  await act(async () => {});
  const { signal } = compute.mock.calls[0][2];
  h.rerender({ on: false });
  expect(signal.aborted).toBe(true);
});

it('reuses the failed fallback on remount within the cooldown, then retries after expiry', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    compute.mockRejectedValueOnce(new Error('relays down'));
    const h = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    h.unmount();
    now.mockReturnValue(129_999);
    const again = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    expect(again.result.current.failed).toBe(true);
    expect(again.result.current.authors).toEqual([hex(1), hex(2)]);
    expect(loadCache).toHaveBeenCalledTimes(1);
    expect(compute).toHaveBeenCalledTimes(1);
    again.unmount();
    now.mockReturnValue(130_000);
    compute.mockResolvedValueOnce({ set: new Set([hex(9)]) });
    const retry = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    expect(loadCache).toHaveBeenCalledTimes(2);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(retry.result.current.failed).toBe(false);
    expect(retry.result.current.authors).toEqual([hex(1), hex(2), hex(9)]);
  } finally {
    now.mockRestore();
  }
});

it.each(['account', 'follows'])(
  'does not reuse a failed cooldown for changed %s',
  async (change) => {
    compute.mockRejectedValueOnce(new Error('relays down'));
    const h = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    h.unmount();
    const oldContact = mockContacts[0].pubkey;
    try {
      if (change === 'account') mockViewer = hex(0xbeef);
      else mockContacts[0].pubkey = hex(3);
      compute.mockResolvedValueOnce({ set: new Set([hex(9)]) });
      const again = renderHook(() => useMarketFofAuthors(true));
      await act(async () => {});
      expect(compute).toHaveBeenCalledTimes(2);
      expect(again.result.current.failed).toBe(false);
      expect(again.result.current.authors).toContain(hex(9));
    } finally {
      mockContacts[0].pubkey = oldContact;
    }
  },
);

it('does not memoize a rejection after abort', async () => {
  let reject!: (error: Error) => void;
  compute.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const h = renderHook(() => useMarketFofAuthors(true));
  await act(async () => {});
  h.unmount();
  await act(async () => reject(new Error('aborted')));
  compute.mockResolvedValueOnce({ set: new Set([hex(9)]) });
  const again = renderHook(() => useMarketFofAuthors(true));
  await act(async () => {});
  expect(compute).toHaveBeenCalledTimes(2);
  expect(again.result.current.failed).toBe(false);
  expect(again.result.current.authors).toContain(hex(9));
});

it('expires a successful memo from the original computation time, including cache reads', async () => {
  const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  const ttl = 24 * 60 * 60 * 1000;
  try {
    loadCache.mockResolvedValueOnce({ set: new Set([hex(7)]), computedAt: 1 });
    const first = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    first.unmount();
    now.mockReturnValue(ttl);
    const fresh = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    expect(loadCache).toHaveBeenCalledTimes(1);
    fresh.unmount();
    now.mockReturnValue(ttl + 2);
    compute.mockResolvedValueOnce({ set: new Set([hex(9)]), computedAt: ttl + 2 });
    const expired = renderHook(() => useMarketFofAuthors(true));
    await act(async () => {});
    expect(loadCache).toHaveBeenCalledTimes(2);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(expired.result.current.authors).toEqual([hex(1), hex(2), hex(9)]);
  } finally {
    now.mockRestore();
  }
});
