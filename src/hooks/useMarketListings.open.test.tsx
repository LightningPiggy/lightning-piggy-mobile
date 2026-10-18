// The experimental All scope through the listings hook: author-less fetch,
// and sellers without a kind-0 profile dropped once profiles resolve.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { finalizeEvent, getPublicKey } from 'nostr-tools';
import { act, renderHook } from '@testing-library/react-native';
import { useMarketListings } from './useMarketListings';
import { fetchMarketListings, fetchOpenMarketListings } from '../services/marketListingsService';
import { fetchMarketMerchantProfiles } from '../services/marketMerchantProfiles';
import { clearMarketSnapshotMemory, getMarketSnapshot } from '../services/marketStorage';
import { parseMarketListing } from '../utils/marketListings';

jest.mock('../services/marketListingsService', () => ({
  fetchMarketListings: jest.fn(),
  fetchOpenMarketListings: jest.fn(),
}));
jest.mock('../services/marketMerchantProfiles', () => ({
  fetchMarketMerchantProfiles: jest.fn(),
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({
    pubkey: 'f'.repeat(64),
    relays: [{ url: 'wss://example.com', read: true, write: true }],
  }),
  useNostrContacts: () => ({ contacts: [] }),
}));
jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
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

const keyOf = (n: number) => new Uint8Array(32).fill(n);
const product = (n: number) =>
  parseMarketListing(
    finalizeEvent(
      {
        kind: 30402,
        created_at: 100 + n,
        content: '',
        tags: [
          ['d', `item-${n}`],
          ['title', `Item ${n}`],
          ['price', '21', 'SAT'],
          ['image', 'https://img.example/x.png'],
        ],
      },
      keyOf(n),
    ),
    0,
  )!;
const SCOPE = { account: 'f'.repeat(64), open: true as const };

beforeEach(() => {
  clearMarketSnapshotMemory();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
  (fetchMarketListings as jest.Mock).mockReset();
  (fetchOpenMarketListings as jest.Mock).mockReset();
  (fetchMarketMerchantProfiles as jest.Mock).mockReset();
});

it('fetches author-less listings on the read relays, never the author-scoped query', async () => {
  (fetchOpenMarketListings as jest.Mock).mockResolvedValue({ products: [], incomplete: false });
  renderHook(() => useMarketListings(true, SCOPE));
  await act(async () => {});
  expect(fetchMarketListings).not.toHaveBeenCalled();
  expect(fetchOpenMarketListings).toHaveBeenCalledWith(
    ['wss://example.com'],
    expect.any(AbortSignal),
    expect.any(Function),
    { carried: [] },
  );
});

it('drops sellers with no kind-0 profile once the profile pass answers', async () => {
  const withProfile = product(1);
  const withoutProfile = product(2);
  (fetchOpenMarketListings as jest.Mock).mockResolvedValue({
    products: [withProfile, withoutProfile],
    incomplete: false,
  });
  let answerProfiles!: (profiles: Map<string, object>) => void;
  (fetchMarketMerchantProfiles as jest.Mock).mockImplementation(
    () => new Promise((resolve) => (answerProfiles = resolve)),
  );
  const h = renderHook(() => useMarketListings(true, SCOPE));
  await act(async () => {});
  // Until profiles resolve, everything that passed the spam rules shows.
  expect(h.result.current.products.map((p) => p.id)).toEqual([withProfile.id, withoutProfile.id]);
  await act(async () =>
    answerProfiles(new Map([[getPublicKey(keyOf(1)), { npub: 'npub1x', name: 'Shop' }]])),
  );
  expect(h.result.current.products.map((p) => p.id)).toEqual([withProfile.id]);
});

it('caps each seller again after merging successive All samples, including the cached result', async () => {
  const makeProducts = (start: number) =>
    Array.from({ length: 10 }, (_, i) => {
      const event = product(1).listing!.event;
      return parseMarketListing(
        finalizeEvent(
          {
            kind: event.kind,
            created_at: 100 + start + i,
            content: event.content,
            tags: event.tags.map((tag) => (tag[0] === 'd' ? ['d', `item-${start + i}`] : tag)),
          },
          keyOf(1),
        ),
        0,
      )!;
    }).reverse();
  const old = makeProducts(0);
  const fresh = makeProducts(10);
  (fetchMarketMerchantProfiles as jest.Mock).mockResolvedValue(
    new Map([[getPublicKey(keyOf(1)), { npub: 'npub1x', name: 'Shop' }]]),
  );
  (fetchOpenMarketListings as jest.Mock)
    .mockResolvedValueOnce({ products: old, incomplete: false, answeredRelays: [] })
    .mockResolvedValueOnce({ products: fresh, incomplete: false, answeredRelays: [] });
  const h = renderHook(() => useMarketListings(true, SCOPE));
  await act(async () => {});
  expect(h.result.current.products).toHaveLength(10);
  await act(async () => h.result.current.refresh());
  expect(h.result.current.products.map((p) => p.id)).toEqual(fresh.map((p) => p.id));
  expect(
    getMarketSnapshot(`${SCOPE.account}|*|wss://example.com`)?.result.products.map((p) => p.id),
  ).toEqual(fresh.map((p) => p.id));
});

it('drops unresolved and missing sellers after a profile outage, keeping known profiles', async () => {
  const sellers = [product(1), product(2), product(3)];
  (fetchOpenMarketListings as jest.Mock).mockResolvedValue({
    products: sellers,
    incomplete: false,
  });
  (fetchMarketMerchantProfiles as jest.Mock).mockImplementation(
    (_authors, _signal, onUnresolved) => {
      onUnresolved(new Set([getPublicKey(keyOf(2))]));
      return Promise.resolve(
        new Map([[getPublicKey(keyOf(1)), { npub: 'npub1x', name: 'Cached' }]]),
      );
    },
  );
  const h = renderHook(() => useMarketListings(true, SCOPE));
  await act(async () => {});
  expect(h.result.current.profilesReady).toBe(true);
  expect(h.result.current.products.map((p) => p.id)).toEqual([sellers[0].id]);
});
