import { MARKET_RELAYS } from '../utils/marketListingsQuery';
import { act, renderHook } from '@testing-library/react-native';
import type { Event } from 'nostr-tools';
import type { MarketProduct } from '../data/marketProducts';
import { MARKET_VENDORS } from '../data/marketVendors';
import { clearShippingOptionCache } from '../services/marketShippingCache';
import { fetchShippingOptionsForDisplay } from '../services/marketShippingService';
import { parseShippingOptionEvent } from '../utils/marketShipping';
import { shipsToMatches } from '../utils/marketShipsTo';
import { useMarketShipsTo } from './useMarketShipsTo';

let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const React = jest.requireActual('react');
    const focused = mockFocused;
    React.useEffect(() => (focused ? callback() : undefined), [callback, focused]);
  },
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ relays: [{ url: 'wss://example.com', read: true }] }),
}));
jest.mock('expo-localization', () => ({ useLocales: () => [{ regionCode: 'GB' }] }));
jest.mock('../services/marketShippingService', () => ({
  fetchShippingOptionsForDisplay: jest.fn(),
  MAX_DISPLAY_SHIPPING_REFERENCES: 200,
}));
const fetchMock = fetchShippingOptionsForDisplay as jest.Mock;
const seller = 'a'.repeat(64);
const coordinate = `30406:${seller}:standard`;
const products: MarketProduct[] = [
  {
    id: 'product',
    title: 'Product',
    description: '',
    priceSats: 1,
    priceFiatLabel: '1 SATS',
    image: '',
    sellerName: 'Robotechy',
    url: 'https://example.com',
    featured: false,
    listing: {
      event: { kind: 30402, pubkey: seller, tags: [['shipping_option', coordinate]] } as Event,
      currency: 'SATS',
      priceLabel: '1 SATS',
      vendor: MARKET_VENDORS[0],
    },
  },
];
const option = (country: string) =>
  parseShippingOptionEvent({
    kind: 30406,
    pubkey: seller,
    created_at: 1,
    tags: [
      ['d', 'standard'],
      ['price', '5', 'GBP'],
      ['country', country],
    ],
  })!;

beforeEach(() => {
  jest.useFakeTimers();
  mockFocused = true;
  clearShippingOptionCache();
  fetchMock.mockReset();
});
afterEach(() => jest.useRealTimers());

async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(400);
  });
}
function refocus(rerender: (props: object) => void) {
  mockFocused = false;
  rerender({});
  mockFocused = true;
  rerender({});
}

test('retries on next focus after a relay failure retained as shipping unknown', async () => {
  fetchMock
    .mockRejectedValueOnce(new Error('all relays failed'))
    .mockResolvedValueOnce([option('GB')]);
  const { result, rerender } = renderHook(() => useMarketShipsTo(products, true));
  await settle();
  expect(result.current.byProduct.get('product')).toEqual({ kind: 'unknown' });
  refocus(rerender);
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.current.byProduct.get('product')).toEqual({ kind: 'countries', countries: ['GB'] });
});

test.each([
  ['published option', [option('GB')], 10 * 60_000, { kind: 'countries', countries: ['GB'] }],
  ['unpublished option', [], 2 * 60_000, { kind: 'unknown' }],
])(
  'revalidates an expired %s on focus but serves fresh answers from cache',
  async (_label, initial, ttl, expected) => {
    fetchMock.mockResolvedValueOnce(initial).mockResolvedValueOnce([option('DE')]);
    const { result, rerender } = renderHook(() => useMarketShipsTo(products, true));
    await settle();
    expect(result.current.byProduct.get('product')).toEqual(expected);
    refocus(rerender);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.byProduct.get('product')).toEqual(expected);
    act(() => {
      jest.advanceTimersByTime(ttl as number);
    });
    refocus(rerender);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.byProduct.get('product')).toEqual({
      kind: 'countries',
      countries: ['DE'],
    });
  },
);

test('keeps fresh cached shipping when fetching a new coordinate fails', async () => {
  fetchMock.mockResolvedValueOnce([option('GB')]).mockRejectedValueOnce(new Error('offline'));
  const { result, rerender } = renderHook(
    ({ items }: { items: MarketProduct[] }) => useMarketShipsTo(items, true),
    {
      initialProps: { items: products },
    },
  );
  await settle();
  const newProduct: MarketProduct = {
    ...products[0],
    id: 'new-product',
    listing: {
      ...products[0].listing!,
      event: {
        ...products[0].listing!.event,
        tags: [['shipping_option', `30406:${seller}:new-option`]],
      },
    },
  };
  rerender({ items: [...products, newProduct] });
  await settle();
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls[1][0].coordinates).toEqual([`30406:${seller}:new-option`]);
  expect(result.current.byProduct.get('product')).toEqual({ kind: 'countries', countries: ['GB'] });
  expect(result.current.byProduct.get('new-product')).toEqual({ kind: 'unknown' });
});

test.each(MARKET_RELAYS)(
  'resolves shipping published only on marketplace relay %s',
  async (shippingRelay) => {
    fetchMock.mockImplementation(async ({ relays }: { relays: string[] }) =>
      relays.includes(shippingRelay) ? [option('GB')] : [],
    );
    const { result } = renderHook(() => useMarketShipsTo(products, true));
    await settle();
    expect(fetchMock.mock.calls[0][0].relays).toEqual([...MARKET_RELAYS, 'wss://example.com']);
    expect(result.current.byProduct.get('product')).toEqual({
      kind: 'countries',
      countries: ['GB'],
    });
    expect(shipsToMatches(result.current.byProduct.get('product')!, 'GB', false)).toBe(true);
  },
);
