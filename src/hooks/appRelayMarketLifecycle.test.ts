import { act, renderHook } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSellerProducts } from './useSellerProducts';
import { useCollectionFilter } from './useCollectionFilter';
import { useSellerOrderQuote } from './useSellerOrderQuote';
import { fetchMarketListings } from '../services/marketListingsService';
import { fetchMarketCollections } from '../services/marketCollectionsService';
import { fetchSellerEvents } from '../services/marketSellerService';
import { resetSellerStore } from '../services/sellerEventStore';
import {
  forgetAppRelayPrefs,
  loadAppRelayPrefs,
  setAppRelayEnabled,
} from '../services/appRelayPrefs';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import type { MarketProduct } from '../data/marketProducts';
import type { ParsedOrderEvent } from '../utils/orderEvents';

const mockOwner = 'a'.repeat(64);
const mockRelays = [{ url: 'wss://personal.example', read: true, write: true }];
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockOwner, relays: mockRelays }),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('../services/marketListingsService', () => ({ fetchMarketListings: jest.fn() }));
jest.mock('../services/marketCollectionsService', () => ({ fetchMarketCollections: jest.fn() }));
jest.mock('../services/marketSellerService', () => ({
  fetchSellerEvents: jest.fn(),
  loadSellerCache: async () => [],
  loadHiddenListings: async () => new Map(),
  persistSellerSnapshot: async () => {},
  sellerRelays: () => ['wss://personal.example'],
}));
jest.mock('./useBtcRates', () => ({ useBtcRates: () => ({ rates: {} }) }));

it('retries seller listings, collections and order snapshots after hydration and market edits', async () => {
  await forgetAppRelayPrefs(mockOwner);
  await AsyncStorage.clear();
  resetSellerStore();
  setCurrentUserPubkey(mockOwner);
  jest.mocked(fetchMarketListings).mockResolvedValue({ products: [], incomplete: false });
  jest.mocked(fetchMarketCollections).mockResolvedValue({ events: [], incomplete: false });
  jest.mocked(fetchSellerEvents).mockResolvedValue([]);
  const products = [
    { id: 'listing', listing: { event: { pubkey: mockOwner } } },
  ] as MarketProduct[];
  const order = { items: [] } as unknown as ParsedOrderEvent;
  const h = renderHook(() => {
    useSellerProducts(mockOwner, true, 0, 'Seller');
    useCollectionFilter(products, true, mockOwner);
    useSellerOrderQuote(order);
  });
  await act(async () => {});
  expect(fetchMarketListings).toHaveBeenCalledTimes(1);
  expect(fetchMarketCollections).toHaveBeenCalledTimes(1);
  expect(fetchSellerEvents).toHaveBeenCalledTimes(1);
  await act(async () => loadAppRelayPrefs(mockOwner));
  expect(fetchMarketListings).toHaveBeenCalledTimes(2);
  expect(fetchMarketCollections).toHaveBeenCalledTimes(2);
  expect(fetchSellerEvents).toHaveBeenCalledTimes(2);
  await act(async () => setAppRelayEnabled(mockOwner, 'market', 'wss://market.example', false));
  expect(fetchMarketListings).toHaveBeenCalledTimes(3);
  expect(fetchMarketCollections).toHaveBeenCalledTimes(3);
  expect(fetchSellerEvents).toHaveBeenCalledTimes(3);
  h.unmount();
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(mockOwner);
});
