import {
  loadAppRelayPrefs,
  setAppRelayEnabled,
  forgetAppRelayPrefs,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { Toast } from '../components/BrandedToast';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearMarketSnapshotMemory,
  writeMarketSnapshot,
  MARKET_CACHE_KEY,
} from '../services/marketStorage';
import { act, renderHook } from '@testing-library/react-native';
import { MARKET_SNAPSHOT_FRESH_MS, useMarketListings } from './useMarketListings';
import { fetchMarketListings } from '../services/marketListingsService';
import type { MarketListingsResult } from '../services/marketListingsService';
jest.mock('../services/marketListingsService', () => ({ fetchMarketListings: jest.fn() }));
jest.mock('../services/marketMerchantProfiles', () => ({
  fetchMarketMerchantProfiles: jest.fn(async () => new Map()),
}));
let mockViewer = 'mockViewer-a';
let mockFocused = true;
const mockContacts = [{ pubkey: 'a'.repeat(64), petname: 'Friend', profile: null }];
const mockRelays = [{ url: 'wss://example.com', read: true, write: true }];
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockViewer, relays: mockRelays }),
  useNostrContacts: () => ({ contacts: mockContacts }),
}));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockFocused,
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));
const mockTranslate = (key: string) => key;
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => mockTranslate }));
jest.mock('../components/BrandedToast', () => ({
  Toast: { show: jest.fn(), showOwned: jest.fn(() => jest.fn()) },
}));
const fetch = fetchMarketListings as jest.Mock;
let finish: (result: MarketListingsResult) => void;
beforeEach(() => {
  clearMarketSnapshotMemory();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  mockViewer = 'mockViewer-a';
  mockFocused = true;
  fetch.mockReset();
  fetch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
});
it('does no relay work in preferred mode', () => {
  renderHook(() => useMarketListings(false));
  expect(fetch).not.toHaveBeenCalled();
});
it('aborts on blur and ignores a late result', async () => {
  const h = renderHook(() => useMarketListings(true));
  const signal = fetch.mock.calls[0][2];
  mockFocused = false;
  h.rerender({});
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ products: [], incomplete: true }));
  expect(h.result.current.incomplete).toBe(false);
});
it('aborts on account switch and never exposes the previous account snapshot', async () => {
  const h = renderHook(() => useMarketListings(true));
  const signal = fetch.mock.calls[0][2];
  const oldFinish = finish;
  mockViewer = 'mockViewer-b';
  h.rerender({});
  expect(signal.aborted).toBe(true);
  await act(async () => oldFinish({ products: [], incomplete: true }));
  expect(h.result.current.incomplete).toBe(false);
  expect(h.result.current.loading).toBe(true);
  await act(async () => finish({ products: [], incomplete: false }));
  expect(h.result.current.loading).toBe(false);
});
it('cleans up on unmount', () => {
  const h = renderHook(() => useMarketListings(true));
  const signal = fetch.mock.calls[0][2];
  h.unmount();
  expect(signal.aborted).toBe(true);
});
it('keeps the current listings on screen while refreshing the same scope', async () => {
  const product = {
    id: 'p1',
    sellerName: 'Seller',
  } as unknown as MarketListingsResult['products'][number];
  const h = renderHook(() => useMarketListings(true));
  await act(async () => finish({ products: [product], incomplete: false }));
  expect(h.result.current.products).toHaveLength(1);
  act(() => h.result.current.refresh());
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(h.result.current.loading).toBe(true);
  expect(h.result.current.products).toHaveLength(1);
});
describe('snapshot freshness', () => {
  afterEach(() => jest.useRealTimers());

  it('reuses a fresh complete snapshot when switching back, but Refresh always fetches', async () => {
    const h = renderHook(({ on }: { on: boolean }) => useMarketListings(on), {
      initialProps: { on: true },
    });
    await act(async () => finish({ products: [], incomplete: false }));
    h.rerender({ on: false });
    h.rerender({ on: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.result.current.loading).toBe(false);
    act(() => h.result.current.refresh());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('refetches once the snapshot is older than the freshness window', async () => {
    jest.useFakeTimers();
    const h = renderHook(({ on }: { on: boolean }) => useMarketListings(on), {
      initialProps: { on: true },
    });
    await act(async () => finish({ products: [], incomplete: false }));
    h.rerender({ on: false });
    jest.setSystemTime(Date.now() + MARKET_SNAPSHOT_FRESH_MS + 1);
    h.rerender({ on: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('always refetches after a partial snapshot', async () => {
    const h = renderHook(({ on }: { on: boolean }) => useMarketListings(on), {
      initialProps: { on: true },
    });
    await act(async () => finish({ products: [], incomplete: true }));
    h.rerender({ on: false });
    h.rerender({ on: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shows the cached snapshot after a brief detour through another scope', async () => {
    const product = {
      id: 'p1',
      sellerName: 'Seller',
    } as unknown as MarketListingsResult['products'][number];
    const h = renderHook(() => useMarketListings(true));
    await act(async () => finish({ products: [product], incomplete: false }));
    // Switch account (new scope, fetch left in flight), then straight back.
    mockViewer = 'mockViewer-b';
    h.rerender({});
    expect(h.result.current.loading).toBe(true);
    mockViewer = 'mockViewer-a';
    h.rerender({});
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.result.current.loading).toBe(false);
    expect(h.result.current.products).toHaveLength(1);
  });
});

describe('first page', () => {
  const item = (id: string) =>
    ({ id, sellerName: 'Seller' }) as unknown as MarketListingsResult['products'][number];

  it('shows the first page while the rest load, then the full snapshot', async () => {
    const h = renderHook(() => useMarketListings(true));
    const onFirstPage = fetch.mock.calls[0][3];
    act(() => onFirstPage([item('p1')]));
    expect(h.result.current.products).toHaveLength(1);
    expect(h.result.current.loading).toBe(true);
    await act(async () => finish({ products: [item('p1'), item('p2')], incomplete: false }));
    expect(h.result.current.products).toHaveLength(2);
    expect(h.result.current.loading).toBe(false);
  });

  it('never shrinks a longer snapshot that is already showing during a refresh', async () => {
    const h = renderHook(() => useMarketListings(true));
    await act(async () => finish({ products: [item('p1'), item('p2')], incomplete: false }));
    act(() => h.result.current.refresh());
    act(() => fetch.mock.calls[1][3]([item('p1')]));
    expect(h.result.current.products).toHaveLength(2);
  });
});

const cachedProduct = {
  id: 'cached',
  sellerName: 'Seller',
} as MarketListingsResult['products'][number];
it('shows memory cache on remount immediately and refresh replaces deleted listings', async () => {
  const first = renderHook(() => useMarketListings(true));
  await act(async () => finish({ products: [cachedProduct], incomplete: false }));
  first.unmount();
  const second = renderHook(() => useMarketListings(true));
  expect(second.result.current.products).toEqual([cachedProduct]);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(second.result.current.loading).toBe(true);
  await act(async () => finish({ products: [], incomplete: false }));
  expect(second.result.current.products).toEqual([]);
});
it('hydrates disk products while relay refresh is pending, without verification', async () => {
  const key = `${mockViewer}|${mockContacts[0].pubkey}|${mockRelays[0].url}`;
  await writeMarketSnapshot(key, { products: [cachedProduct], incomplete: false });
  const raw = (AsyncStorage.setItem as jest.Mock).mock.calls
    .filter(([k]) => k === MARKET_CACHE_KEY)
    .pop()[1];
  clearMarketSnapshotMemory();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(raw);
  const h = renderHook(() => useMarketListings(true));
  await act(async () => {});
  expect(h.result.current.products).toEqual([cachedProduct]);
  await act(async () => finish({ products: [], incomplete: false }));
  expect(h.result.current.products).toEqual([]);
});
it('never lets a late disk read overwrite a completed refresh', async () => {
  let resolveDisk!: (value: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveDisk = resolve;
      }),
  );
  const h = renderHook(() => useMarketListings(true));
  await act(async () => {});
  await act(async () => finish({ products: [], incomplete: false }));
  await act(async () =>
    resolveDisk(
      JSON.stringify([
        {
          key: `${mockViewer}|${mockContacts[0].pubkey}|${mockRelays[0].url}`,
          at: Date.now(),
          result: { products: [cachedProduct], incomplete: false },
        },
      ]),
    ),
  );
  expect(h.result.current.products).toEqual([]);
});

it('marks completion only for a fetched snapshot in the current scope', async () => {
  const h = renderHook(({ on }: { on: boolean }) => useMarketListings(on), {
    initialProps: { on: false },
  });
  expect(h.result.current.completed).toBe(false);
  h.rerender({ on: true });
  act(() => fetch.mock.calls[0][3]([cachedProduct]));
  expect(h.result.current.completed).toBe(false);
  await act(async () => finish({ products: [cachedProduct], incomplete: false }));
  expect(h.result.current.completed).toBe(true);
  mockViewer = 'different-account';
  h.rerender({ on: false });
  expect(h.result.current.completed).toBe(false);
});

it('does not resurrect an expired listing from the fresh hook-local snapshot', async () => {
  const now = Date.now();
  const product = {
    id: 'short-lived',
    sellerName: 'Seller',
    listing: {
      event: { pubkey: 'seller', tags: [['expiration', String(now / 1000 + 1)]] },
      vendor: { name: 'Seller' },
    },
  } as unknown as MarketListingsResult['products'][number];
  const h = renderHook(({ on }: { on: boolean }) => useMarketListings(on), {
    initialProps: { on: true },
  });
  await act(async () => finish({ products: [product], incomplete: false }));
  expect(h.result.current.products).toHaveLength(1);
  h.rerender({ on: false });
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 2000);
  try {
    h.rerender({ on: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.result.current.products).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

describe('partial snapshot recovery', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (Toast.showOwned as jest.Mock).mockClear();
  });
  afterEach(() => jest.useRealTimers());
  it('retries once with backoff and only warns if the seller is still unreachable', async () => {
    const h = renderHook(() => useMarketListings(true));
    await act(async () =>
      finish({ products: [], incomplete: true, unreachableSellers: [mockContacts[0].pubkey] }),
    );
    expect(Toast.showOwned).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(1499));
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => jest.advanceTimersByTime(1));
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () =>
      finish({ products: [], incomplete: true, unreachableSellers: [mockContacts[0].pubkey] }),
    );
    expect(Toast.showOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        autoHide: true,
        visibilityTime: 3500,
        text1: 'market.live.partialToast',
      }),
    );
    act(() => jest.advanceTimersByTime(10000));
    expect(fetch).toHaveBeenCalledTimes(2);
    act(() => h.result.current.refresh());
    await act(async () => finish({ products: [], incomplete: false }));
    expect(h.result.current.incomplete).toBe(false);
  });
  it('clears failure silently when the automatic retry succeeds', async () => {
    const h = renderHook(() => useMarketListings(true));
    await act(async () => finish({ products: [], incomplete: true }));
    act(() => jest.advanceTimersByTime(1500));
    await act(async () => finish({ products: [], incomplete: false }));
    expect(h.result.current.incomplete).toBe(false);
    expect(Toast.showOwned).not.toHaveBeenCalled();
  });
  it('cancels a pending retry on blur', async () => {
    const h = renderHook(() => useMarketListings(true));
    await act(async () => finish({ products: [], incomplete: true }));
    mockFocused = false;
    h.rerender({});
    act(() => jest.advanceTimersByTime(1500));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(Toast.showOwned).not.toHaveBeenCalled();
  });
});

it('uses the preferred follow scope instead of the viewer contacts, including signed-out viewers', async () => {
  mockViewer = '';
  renderHook(() => useMarketListings(true, { account: 'preferred', authors: ['b'.repeat(64)] }));
  expect(fetch.mock.calls[0][0]).toEqual(['b'.repeat(64)]);
  await act(async () => finish({ products: [], incomplete: false }));
});

it('keeps the cached snapshot through an unanswered refresh and retry', async () => {
  jest.useFakeTimers();
  const h = renderHook(() => useMarketListings(true));
  await act(async () => finish({ products: [cachedProduct], incomplete: false }));
  act(() => h.result.current.refresh());
  await act(async () => finish({ products: [], incomplete: true, transportFailed: true }));
  expect(h.result.current.products).toEqual([cachedProduct]);
  act(() => jest.advanceTimersByTime(1500));
  await act(async () => finish({ products: [], incomplete: true, transportFailed: true }));
  expect(h.result.current.products).toEqual([cachedProduct]);
  h.unmount();
  jest.useRealTimers();
});

it.each(['blur', 'mode', 'account', 'unmount'])(
  'dismisses its shown partial toast on %s cleanup',
  async (cleanup) => {
    jest.useFakeTimers();
    const dismiss = jest.fn();
    (Toast.showOwned as jest.Mock).mockReturnValue(dismiss);
    const h = renderHook(({ enabled }: { enabled: boolean }) => useMarketListings(enabled), {
      initialProps: { enabled: true },
    });
    await act(async () =>
      finish({ products: [], incomplete: true, unreachableSellers: [mockContacts[0].pubkey] }),
    );
    act(() => jest.advanceTimersByTime(1500));
    await act(async () =>
      finish({ products: [], incomplete: true, unreachableSellers: [mockContacts[0].pubkey] }),
    );
    if (cleanup === 'blur') {
      mockFocused = false;
      h.rerender({ enabled: true });
    } else if (cleanup === 'mode') h.rerender({ enabled: false });
    else if (cleanup === 'account') {
      mockViewer = 'new-account';
      h.rerender({ enabled: true });
    } else h.unmount();
    expect(dismiss).toHaveBeenCalledTimes(1);
    h.unmount();
    jest.useRealTimers();
  },
);

describe('stale-while-revalidate across partial refreshes', () => {
  const sold = (id: string, relay: string) =>
    ({
      id,
      sellerName: id,
      listing: {
        event: { id: `event-${id}`, pubkey: id, kind: 30402, created_at: 1, tags: [] },
        seenOn: [relay],
      },
    }) as unknown as MarketListingsResult['products'][number];
  const eden = sold('eden', 'wss://relay.weeksfamily.me');
  const shop = sold('shop', 'wss://example.com');

  it("keeps a seller whose relay didn't answer the refresh, then drops them once it answers without them", async () => {
    const h = renderHook(() => useMarketListings(true));
    await act(async () =>
      finish({
        products: [shop, eden],
        incomplete: false,
        answeredRelays: ['wss://example.com', 'wss://relay.weeksfamily.me'],
      }),
    );
    const firstGeneration = h.result.current.generation;
    act(() => h.result.current.refresh());
    // The shown listings ride along so pass 2 can check their deletions.
    expect(fetch.mock.calls[1][4]).toEqual({
      carried: [shop.listing!.event, eden.listing!.event],
      previousProducts: [shop, eden],
    });
    await act(async () =>
      finish({ products: [shop], incomplete: false, answeredRelays: ['wss://example.com'] }),
    );
    expect(h.result.current.products.map((p) => p.id).sort()).toEqual(['eden', 'shop']);
    expect(h.result.current.generation).toBe(firstGeneration + 1);
    expect(h.result.current.answeredRelays).toEqual(['wss://example.com']);
    act(() => h.result.current.refresh());
    await act(async () =>
      finish({
        products: [shop],
        incomplete: false,
        answeredRelays: ['wss://example.com', 'wss://relay.weeksfamily.me'],
      }),
    );
    expect(h.result.current.products.map((p) => p.id)).toEqual(['shop']);
  });

  it('removes a carried listing the refresh reports withdrawn (NIP-09 deletion)', async () => {
    const h = renderHook(() => useMarketListings(true));
    await act(async () =>
      finish({ products: [shop, eden], incomplete: false, answeredRelays: ['wss://example.com'] }),
    );
    act(() => h.result.current.refresh());
    await act(async () =>
      finish({
        products: [shop],
        incomplete: false,
        answeredRelays: ['wss://example.com'],
        withdrawn: ['eden'],
      }),
    );
    expect(h.result.current.products.map((p) => p.id)).toEqual(['shop']);
  });
});

describe('unreachable seller banner signal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (Toast.showOwned as jest.Mock).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  it.each(['internal', 'unreachable', 'cached', 'recovered', 'retry-only'])(
    'only surfaces a persistent missing seller after retry: %s',
    async (scenario) => {
      const author = mockContacts[0].pubkey;
      const cached = {
        ...cachedProduct,
        listing: { event: { pubkey: author }, seenOn: ['wss://example.com'], vendor: {} },
      } as MarketListingsResult['products'][number];
      const h = renderHook(() => useMarketListings(true));
      if (scenario === 'cached') {
        await act(async () => finish({ products: [cached], incomplete: false }));
        act(() => h.result.current.refresh());
      }
      const partial = (unreachable: boolean): MarketListingsResult => ({
        products: [],
        incomplete: true,
        budgetLimited: scenario === 'internal',
        answeredRelays: [],
        unreachableSellers: unreachable ? [author] : [],
      });
      await act(async () => finish(partial(!['internal', 'retry-only'].includes(scenario))));
      expect(h.result.current.sellersUnreachable).toBe(false);
      expect(Toast.showOwned).not.toHaveBeenCalled();
      act(() => jest.advanceTimersByTime(1500));
      await act(async () => finish(partial(!['internal', 'recovered'].includes(scenario))));
      expect(h.result.current.sellersUnreachable).toBe(scenario === 'unreachable');
      expect(Toast.showOwned).toHaveBeenCalledTimes(scenario === 'unreachable' ? 1 : 0);
      if (scenario === 'cached')
        expect(h.result.current.products.map((p) => p.id)).toEqual([cached.id]);
      h.unmount();
    },
  );
});

it('keeps the existing retry policy when a complete first pass carries an unreachable signal', async () => {
  const h = renderHook(() => useMarketListings(true));
  await act(async () =>
    finish({ products: [], incomplete: false, unreachableSellers: [mockContacts[0].pubkey] }),
  );
  expect(h.result.current.sellersUnreachable).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(1);
  h.unmount();
});

it('invalidates a fresh feed when only market preferences change', async () => {
  const owner = 'a'.repeat(64);
  setCurrentUserPubkey(owner);
  await loadAppRelayPrefs(owner);
  fetch.mockResolvedValue({ products: [], incomplete: false });
  const h = renderHook(() => useMarketListings(true));
  await act(async () => {});
  expect(fetch).toHaveBeenCalledTimes(1);
  const oldSignal = fetch.mock.calls[0][2];
  await act(async () => setAppRelayEnabled(owner, 'market', 'wss://market.example', false));
  expect(oldSignal.aborted).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
  h.unmount();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(owner);
});
