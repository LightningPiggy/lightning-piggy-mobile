import { act, renderHook } from '@testing-library/react-native';
import type { Event } from 'nostr-tools';
import { useSellerOrderQuote } from './useSellerOrderQuote';
import { fetchSellerEvents, persistSellerSnapshot } from '../services/marketSellerService';
import { resetSellerStore, sellerStoreState } from '../services/sellerEventStore';
import { parseOrderEvent } from '../utils/orderEvents';

let mockScope = 'initial';
const mockPubkey = 'a'.repeat(64);
jest.mock('./useAppRelayPrefs', () => ({ useAppRelayPrefs: () => mockScope }));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockPubkey, relays: [] }),
}));
jest.mock('./useBtcRates', () => ({ useBtcRates: () => ({ rates: {} }) }));
jest.mock('../services/marketSellerService', () => ({
  fetchSellerEvents: jest.fn(),
  loadSellerCache: async () => [],
  loadHiddenListings: async () => new Map(),
  persistSellerSnapshot: jest.fn().mockResolvedValue(undefined),
  sellerRelays: () => ['wss://seller.example'],
}));
const order = parseOrderEvent({
  kind: 16,
  content: '',
  tags: [
    ['order', 'order-id'],
    ['type', '1'],
  ],
});
const event = (id: string): Event => ({
  id,
  pubkey: mockPubkey,
  kind: 1,
  created_at: 100,
  content: '',
  tags: [],
  sig: '',
});

beforeEach(() => {
  resetSellerStore();
  jest.clearAllMocks();
  mockScope = expect.getState().currentTestName!;
});

it('discards an obsolete scope before merging, persisting or marking it fresh', async () => {
  expect(order).not.toBeNull();
  const initialScope = mockScope;
  let finishOld!: (events: Event[]) => void;
  jest
    .mocked(fetchSellerEvents)
    .mockImplementationOnce(() => new Promise((resolve) => (finishOld = resolve)))
    .mockResolvedValue([event('current')]);
  const h = renderHook(() => useSellerOrderQuote(order));
  await act(async () => {});
  mockScope = `${initialScope}:new`;
  h.rerender({});
  await act(async () => {});
  expect([...sellerStoreState(mockPubkey).events.keys()]).toEqual(['current']);
  expect(persistSellerSnapshot).toHaveBeenCalledTimes(1);

  await act(async () => finishOld([event('obsolete')]));
  expect([...sellerStoreState(mockPubkey).events.keys()]).toEqual(['current']);
  expect(persistSellerSnapshot).toHaveBeenCalledTimes(1);
  // A stale completion must not replace the current scope's freshness marker.
  h.unmount();
  renderHook(() => useSellerOrderQuote(order));
  await act(async () => {});
  expect(fetchSellerEvents).toHaveBeenCalledTimes(2);
});

it('makes a deduplicated A request current again after switching A → B → A', async () => {
  const scopeA = mockScope;
  let finishA!: (events: Event[]) => void;
  let finishB!: (events: Event[]) => void;
  jest
    .mocked(fetchSellerEvents)
    .mockImplementationOnce(() => new Promise((resolve) => (finishA = resolve)))
    .mockImplementationOnce(() => new Promise((resolve) => (finishB = resolve)));
  const h = renderHook(() => useSellerOrderQuote(order));
  await act(async () => {});
  mockScope = `${scopeA}:B`;
  h.rerender({});
  await act(async () => {});
  mockScope = scopeA;
  h.rerender({});
  await act(async () => {});
  expect(fetchSellerEvents).toHaveBeenCalledTimes(2);
  await act(async () => finishA([event('A')]));
  await act(async () => finishB([event('B')]));
  expect([...sellerStoreState(mockPubkey).events.keys()]).toEqual(['A']);
  expect(persistSellerSnapshot).toHaveBeenCalledTimes(1);
});
