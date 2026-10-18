import {
  loadAppRelayPrefs,
  setAppRelayEnabled,
  forgetAppRelayPrefs,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { Toast } from '../components/BrandedToast';
import { act, renderHook } from '@testing-library/react-native';
import { usePreferredMarketListings, usePreferredMarketSample } from './usePreferredMarketListings';
import {
  fetchPreferredSellers,
  PREFERRED_SELLERS_ACCOUNT,
} from '../services/marketPreferredSellers';
import { useMarketListings } from './useMarketListings';
import { MARKET_PRODUCTS, PIG_TEST_PRODUCTS } from '../data/marketProducts';
import { preferredMarketScope } from '../utils/preferredMarketScope';
import { ROBOTECHY_PUBKEY } from '../utils/marketSample';
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ relays: [{ url: 'wss://example.com', read: true }] }),
}));
jest.mock('../services/marketPreferredSellers', () => ({
  fetchPreferredSellers: jest.fn(),
  getPreferredSellers: () => undefined,
  PREFERRED_SELLERS_ACCOUNT: 'preferred',
}));
const mockTranslate = (key: string) => key;
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => mockTranslate }));
jest.mock('../components/BrandedToast', () => ({ Toast: { showOwned: jest.fn(() => jest.fn()) } }));
jest.mock('./useMarketListings', () => ({ useMarketListings: jest.fn() }));
const live = useMarketListings as jest.Mock;
const follows = fetchPreferredSellers as jest.Mock;
const refresh = jest.fn();
beforeEach(() => {
  follows.mockReset();
  live.mockReturnValue({
    products: [],
    hasSnapshot: false,
    completed: false,
    incomplete: false,
    loading: false,
    refresh,
  });
});
it('scopes the shared verified pipeline to follows and curated sellers', async () => {
  const authors = ['b'.repeat(64)];
  follows.mockResolvedValue(authors);
  renderHook(() => usePreferredMarketListings());
  await act(async () => {});
  expect(live).toHaveBeenLastCalledWith(true, {
    account: PREFERRED_SELLERS_ACCOUNT,
    authors: preferredMarketScope(authors),
  });
});
it('falls back to the catalogue when relays fail without a snapshot', async () => {
  follows.mockRejectedValue(new Error('offline'));
  const h = renderHook(() => usePreferredMarketListings());
  await act(async () => {});
  expect(h.result.current.products).toBe(MARKET_PRODUCTS);
  expect(h.result.current.loading).toBe(false);
  expect(live).toHaveBeenLastCalledWith(true, {
    account: PREFERRED_SELLERS_ACCOUNT,
    authors: preferredMarketScope([]),
  });
});
it('preserves cached listings on failure and respects a successful empty snapshot', async () => {
  follows.mockResolvedValue([]);
  const cached = [{ ...MARKET_PRODUCTS[0], id: 'cached-live' }];
  live.mockReturnValue({
    products: cached,
    hasSnapshot: true,
    incomplete: true,
    completed: true,
    refresh,
  });
  const h = renderHook(() => usePreferredMarketListings());
  await act(async () => {});
  expect(h.result.current.products).toEqual([...PIG_TEST_PRODUCTS, ...cached]);
  live.mockReturnValue({
    products: [],
    hasSnapshot: true,
    incomplete: false,
    completed: true,
    refresh,
  });
  h.rerender({});
  expect(h.result.current.products).toEqual(PIG_TEST_PRODUCTS);
});

describe('follow recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());
  it.each([false, true])(
    'retries failed follows, preserves fallback, and toasts only after retry (cache: %s)',
    async (cached) => {
      const authors = ['b'.repeat(64)];
      follows.mockImplementation((_relays, _signal, onCache) => {
        if (cached) onCache(authors);
        return Promise.reject(new Error('offline'));
      });
      const h = renderHook(() => usePreferredMarketListings());
      await act(async () => {});
      expect(h.result.current.incomplete).toBe(true);
      expect(h.result.current.products).toBe(MARKET_PRODUCTS);
      expect(Toast.showOwned).not.toHaveBeenCalled();
      await act(async () => jest.advanceTimersByTime(1500));
      expect(follows).toHaveBeenCalledTimes(2);
      expect(h.result.current.incomplete).toBe(true);
      expect(h.result.current.loading).toBe(false);
      expect(Toast.showOwned).toHaveBeenCalledWith(
        expect.objectContaining({ text1: 'market.live.partialToast' }),
      );
      if (cached)
        expect(live).toHaveBeenLastCalledWith(true, {
          account: PREFERRED_SELLERS_ACCOUNT,
          authors: preferredMarketScope(authors),
        });
      follows.mockResolvedValue(authors);
      act(() => h.result.current.refresh());
      await act(async () => {});
      expect(h.result.current.incomplete).toBe(false);
    },
  );
  it('recovers silently and cancels retries when disabled', async () => {
    follows.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(['b'.repeat(64)]);
    const h = renderHook(
      ({ enabled }: { enabled: boolean }) => usePreferredMarketListings(enabled),
      {
        initialProps: { enabled: true },
      },
    );
    await act(async () => {});
    await act(async () => jest.advanceTimersByTime(1500));
    expect(h.result.current.incomplete).toBe(false);
    expect(Toast.showOwned).not.toHaveBeenCalled();
    follows.mockRejectedValue(new Error('offline'));
    act(() => h.result.current.refresh());
    await act(async () => {});
    h.rerender({ enabled: false });
    await act(async () => jest.advanceTimersByTime(1500));
    expect(follows).toHaveBeenCalledTimes(3);
  });
});

it('puts a live Robotechy listing in the Explore rail when absent from team follows', async () => {
  const authors = Array.from({ length: 216 }, (_, i) => i.toString(16).padStart(64, '0'));
  follows.mockResolvedValue(authors);
  const robot = {
    ...MARKET_PRODUCTS[0],
    id: 'live-robotechy',
    listing: { event: { pubkey: ROBOTECHY_PUBKEY } },
  } as (typeof MARKET_PRODUCTS)[number];
  const other = Array.from({ length: 30 }, (_, i) => ({
    ...MARKET_PRODUCTS[0],
    id: `live-${i}`,
  }));
  live.mockImplementation((enabled, scope) => ({
    products: enabled && scope.authors.includes(ROBOTECHY_PUBKEY) ? [...other, robot] : other,
    hasSnapshot: enabled,
    refresh,
  }));
  const h = renderHook(() => usePreferredMarketSample());
  await act(async () => {});
  expect(h.result.current).toHaveLength(8);
  expect(h.result.current).toContain(robot);
  expect(h.result.current.every((product) => product.id.startsWith('live-'))).toBe(true);
});

it('re-arms preferred-seller reads after market preference hydration and edits', async () => {
  const owner = 'a'.repeat(64);
  await forgetAppRelayPrefs(owner);
  setCurrentUserPubkey(owner);
  follows.mockResolvedValue([]);
  const h = renderHook(() => usePreferredMarketListings());
  await act(async () => {});
  expect(follows).toHaveBeenCalledTimes(1);
  await act(async () => loadAppRelayPrefs(owner));
  expect(follows).toHaveBeenCalledTimes(2);
  await act(async () => setAppRelayEnabled(owner, 'market', 'wss://market.example', false));
  expect(follows).toHaveBeenCalledTimes(3);
  h.unmount();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(owner);
});
