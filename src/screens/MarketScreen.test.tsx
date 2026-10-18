import React from 'react';
import { FlatList } from 'react-native';
import { MARKET_PRODUCTS } from '../data/marketProducts';
import { act, fireEvent, render } from '@testing-library/react-native';
import MarketScreen from './MarketScreen';
import type { ExploreNavigation, MarketRoute } from '../navigation/types';

jest.mock('@gorhom/bottom-sheet', () => ({
  BottomSheetModalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('react-native-gesture-handler', () => ({
  GestureHandlerRootView: jest.requireActual('react-native').View,
}));
jest.mock('../components/CountryPickerSheet', () => {
  const { TouchableOpacity } = jest.requireActual('react-native');
  return function MockCountryPicker({
    visible,
    onSelect,
    onClose,
  }: {
    visible: boolean;
    onSelect: (code: string) => void;
    onClose: () => void;
  }) {
    return visible ? (
      <TouchableOpacity
        testID="country-picker-row-JP"
        onPress={() => {
          onSelect('JP');
          onClose();
        }}
      />
    ) : null;
  };
});

jest.mock('../hooks/useCollectionFilter', () => ({
  useCollectionFilter: function useMockCollectionFilter(
    products: unknown[],
    enabled: boolean,
    merchant: string | null,
  ) {
    const mockReact = jest.requireActual<typeof React>('react');
    const [selected, setSelected] = mockReact.useState<string | null>(mockSelectedCollection);
    mockCollectionScope(enabled, merchant);
    return {
      products: selected ? [] : products,
      collections: mockCollections,
      selected,
      select: (value: string | null) => {
        mockSelectCollection(value);
        setSelected(value);
      },
    };
  },
}));

jest.mock('../hooks/useMarketPreferences', () => ({
  useMarketPreferences: () => mockPreferencesHook(),
}));
const mockCollectionScope = jest.fn();
const mockSelectCollection = jest.fn();
let mockSelectedCollection: string | null = null;
let mockCollections: import('nostr-tools').Event[] = [];
let mockReady = true;
let mockCompleted = false;
let mockLoading = true;
let mockGeneration = 0;
let mockIncomplete = false;
let mockSellersUnreachable = false;
let mockAnsweredRelays: string[] | undefined;
let mockInitialPreferences = {
  mode: 'preferred',
  merchant: null as string | null,
  shipsTo: null as string | null,
  includeUnknownShipping: true,
  currency: null as string | null,
};
let mockShipsTo = new Map<string, import('../utils/marketShipsTo').ShipsTo>();
jest.mock('../hooks/useMarketShipsTo', () => ({
  useMarketShipsTo: () => ({ byProduct: mockShipsTo, deviceCountry: 'GB' }),
}));
const mockUpdate = jest.fn();
let mockLiveProducts: typeof import('../data/marketProducts').MARKET_PRODUCTS = [];
const mockPreferencesHook = function useMockPreferences() {
  const [preferences, setPreferences] = React.useState(mockInitialPreferences);
  return {
    ready: mockReady,
    preferences,
    update: (patch: object) => {
      mockUpdate(patch);
      setPreferences((previous) => ({ ...previous, ...patch }));
    },
  };
};
jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => ({
  useTranslation: () => (key: string) => key,
  useLocale: () => ({ t: (key: string) => key, locale: 'en', formatLocale: 'en-GB' }),
}));
jest.mock('../components/MarketHeader', () => {
  const { View, Text } = jest.requireActual('react-native');
  return function MockMarketHeader({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) {
    return (
      <View>
        <Text>{title}</Text>
        {children}
      </View>
    );
  };
});
jest.mock('../components/MarketProductCard', () => () => null);
let mockBuyerActions = 0;
let mockSellerActions = 0;
let mockHasListings = false;
let mockLikedProducts: { id: string }[] = [];
let mockLikedFailed = false;
jest.mock('../hooks/useLikedListings', () => ({
  useLikedListings: () => ({ products: mockLikedProducts, failed: mockLikedFailed }),
}));
jest.mock('../contexts/MarketShortcutsContext', () => ({
  useMarketShortcutCounts: () => ({
    buyer: mockBuyerActions,
    seller: mockSellerActions,
    hasListings: mockHasListings,
  }),
}));
jest.mock('../hooks/usePreferredMarketListings', () => ({
  usePreferredMarketListings: () => ({
    products: mockLiveProducts.length
      ? mockLiveProducts
      : jest.requireActual('../data/marketProducts').MARKET_PRODUCTS,
    loading: false,
    completed: true,
    incomplete: false,
    refresh: jest.fn(),
  }),
}));
jest.mock('../hooks/useMarketListings', () => ({
  useMarketListings: (enabled: boolean, scope?: { open?: true; authors?: string[] }) => {
    // One instance per scope: Friends (no scope), friends of friends
    // (authors), All (open).
    if (!scope) mockLiveEnabled(enabled);
    else if (scope.open) mockAllEnabled(enabled);
    else mockFofEnabled(enabled, scope.authors);
    return {
      products: mockLiveProducts,
      loading: enabled && mockLoading,
      completed: mockCompleted,
      incomplete: mockIncomplete,
      sellersUnreachable: mockSellersUnreachable,
      generation: mockGeneration,
      answeredRelays: mockAnsweredRelays,
      refresh: jest.fn(),
    };
  },
}));
jest.mock('lucide-react-native', () => ({
  ChevronLeft: () => null,
  Heart: () => null,
  MoreVertical: () => null,
  Package: () => null,
  Search: () => null,
  SlidersHorizontal: () => null,
  Store: () => null,
  ReceiptText: () => null,
  X: () => null,
  Check: () => null,
  Lock: () => null,
}));
const mockLiveEnabled = jest.fn();
const mockFofEnabled = jest.fn();
const mockAllEnabled = jest.fn();
let mockExperimental = false;
jest.mock('../contexts/GroupsContext', () => ({
  useGroups: () => ({ secretMode: mockExperimental }),
}));
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ pubkey: 'f'.repeat(64) }) }));
let mockFof: {
  authors: string[] | undefined;
  progress: { done: number; total: number } | null;
  failed: boolean;
} = { authors: ['a'.repeat(64)], progress: null, failed: false };
const mockFofArmed = jest.fn();
jest.mock('../hooks/useMarketFofAuthors', () => ({
  useMarketFofAuthors: (enabled: boolean) => {
    mockFofArmed(enabled);
    return mockFof;
  },
}));
const navigation = { goBack: jest.fn(), navigate: jest.fn() } as unknown as ExploreNavigation;

beforeEach(() => {
  mockBuyerActions = 0;
  mockSellerActions = 0;
  mockHasListings = false;
  mockLikedProducts = [];
  mockLikedFailed = false;
  jest.useFakeTimers();
  mockLiveEnabled.mockClear();
  mockFofEnabled.mockClear();
  mockAllEnabled.mockClear();
  mockFofArmed.mockClear();
  mockExperimental = false;
  mockFof = { authors: ['a'.repeat(64)], progress: null, failed: false };
  mockCollectionScope.mockClear();
  mockSelectCollection.mockClear();
  mockSelectedCollection = null;
  mockCollections = [];
  mockReady = true;
  mockCompleted = false;
  mockLoading = true;
  mockGeneration = 0;
  mockIncomplete = false;
  mockSellersUnreachable = false;
  mockAnsweredRelays = undefined;
  mockUpdate.mockClear();
  mockInitialPreferences = {
    mode: 'preferred',
    merchant: null,
    shipsTo: null,
    includeUnknownShipping: true,
    currency: null,
  };
  mockShipsTo = new Map();
  mockLiveProducts = [];
});
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  jest.useRealTimers();
});

it('moves the single-choice seller scope into Filters and resets it from the search chip', () => {
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-mode-selector')).toBeNull();
  expect(screen.queryByText('market.screen.showing')).toBeNull();
  // The default scope is a pill too, with no × (there's nothing wider yet).
  expect(screen.getByTestId('market-scope-pill-preferred')).toHaveTextContent(
    'market.modes.preferred',
  );
  expect(screen.queryByTestId('market-scope-pill-friends')).toBeNull();
  // The default preferred-sellers scope narrows the list, so the button is
  // already active with one filter.
  expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
  expect(screen.getByTestId('market-filter-button').props.accessibilityState).toEqual({
    selected: true,
  });
  fireEvent.press(screen.getByTestId('market-filter-button'));
  // Nothing beyond the default to reset yet, so the panel's Clear is hidden.
  expect(screen.queryByTestId('market-filter-clear')).toBeNull();
  const preferred = screen.getByTestId('market-filter-sellers-preferred');
  const friends = screen.getByTestId('market-filter-sellers-friends');
  const fof = screen.getByTestId('market-scope-fof');
  expect(preferred.props.accessibilityState).toEqual({ selected: true, disabled: false });
  expect(fof.props.accessibilityState).toEqual({ selected: false, disabled: true });
  fireEvent.press(fof);
  expect(mockLiveEnabled).toHaveBeenLastCalledWith(false);
  fireEvent.press(friends);
  expect(
    screen.getByTestId('market-filter-sellers-friends').props.accessibilityState.selected,
  ).toBe(true);
  expect(
    screen.getByTestId('market-filter-sellers-preferred').props.accessibilityState.selected,
  ).toBe(false);
  expect(mockLiveEnabled).toHaveBeenLastCalledWith(true);
  fireEvent.press(screen.getByTestId('market-filter-done'));
  act(() => jest.runOnlyPendingTimers());
  expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
  expect(screen.getByText('market.live.loading')).toBeTruthy();
  fireEvent.press(screen.getByTestId('market-scope-pill-friends'));
  expect(mockLiveEnabled).toHaveBeenLastCalledWith(false);
  expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
  expect(screen.queryByTestId('market-scope-pill-friends')).toBeNull();
});

it('clears seller scope with the sheet filters and badges a non-empty search', () => {
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId('market-filter-button'));
  fireEvent.press(screen.getByTestId('market-filter-sellers-friends'));
  fireEvent.press(screen.getByTestId('market-filter-clear'));
  expect(mockLiveEnabled).toHaveBeenLastCalledWith(false);
  expect(screen.queryByTestId('market-scope-pill-friends')).toBeNull();
  fireEvent.press(screen.getByTestId('market-filter-done'));
  act(() => jest.runOnlyPendingTimers());
  expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
  fireEvent.press(screen.getByTestId('market-header-search'));
  fireEvent.changeText(screen.getByTestId('market-search-input'), 'piggy');
  expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('2');
  fireEvent.press(screen.getByTestId('market-search-clear'));
  expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
});

it('gates listings and the first query until account filters finish restoring', () => {
  mockReady = false;
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(mockLiveEnabled).toHaveBeenLastCalledWith(false);
  expect(screen.queryByTestId('market-search-input')).toBeNull();
  expect(screen.queryByText('market.screen.emptyNone')).toBeNull();
});
it('removes full loading copy once a cached or first-page result exists', () => {
  mockLiveProducts = MARKET_PRODUCTS.slice(0, 1);
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId('market-filter-button'));
  fireEvent.press(screen.getByTestId('market-filter-sellers-friends'));
  expect(screen.queryByText('market.live.loading')).toBeNull();
});

it('shows no-match copy instead of full loading when filters hide an existing snapshot', () => {
  mockLiveProducts = MARKET_PRODUCTS.slice(0, 1);
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId('market-filter-button'));
  fireEvent.press(screen.getByTestId('market-filter-sellers-friends'));
  fireEvent.press(screen.getByTestId('market-header-search'));
  fireEvent.changeText(screen.getByTestId('market-search-input'), 'no such product');
  act(() => jest.advanceTimersByTime(300));
  expect(screen.queryByText('market.live.loading')).toBeNull();
  expect(screen.getByText('market.screen.emptyNoMatch')).toBeTruthy();
});

it('preserves restored WoT filters until they are missing from two completed loads', () => {
  mockLoading = false; // Hydration render before the fetch effect sets loading.
  mockInitialPreferences = {
    mode: 'wotFriends',
    merchant: 'Saved merchant',
    shipsTo: 'DE',
    includeUnknownShipping: true,
    currency: 'EUR',
  };
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(mockUpdate).not.toHaveBeenCalled();
  mockLoading = true;
  screen.rerender(<MarketScreen navigation={navigation} />);
  expect(mockUpdate).not.toHaveBeenCalled();
  mockLoading = false;
  mockCompleted = true;
  mockGeneration = 1;
  screen.rerender(<MarketScreen navigation={navigation} />);
  // One load without them is not enough: it may just have missed a relay.
  expect(mockUpdate).not.toHaveBeenCalled();
  mockGeneration = 2;
  screen.rerender(<MarketScreen navigation={navigation} />);
  // Ships-to is the shopper's destination, so it survives a catalogue that
  // has no listings for it; catalogue-derived axes reset.
  expect(mockUpdate).toHaveBeenCalledWith({ merchant: null, currency: null });
});

describe('a chosen merchant across partial refreshes', () => {
  const EDEN = 'e'.repeat(64);
  const EDEN_RELAY = 'wss://relay.weeksfamily.me';
  const MARKET_RELAY = 'wss://relay.plebeian.market';
  const listed = (id: string, pubkey: string, sellerName: string, relay: string) => ({
    ...MARKET_PRODUCTS[0],
    id,
    sellerName,
    listing: {
      event: { id, pubkey, kind: 30402, created_at: 1, tags: [], content: '', sig: '' },
      currency: 'SATS',
      priceLabel: '21 sats',
      vendor: { ...MARKET_PRODUCTS[0], name: sellerName },
      seenOn: [relay],
    },
  });
  const scarf = listed('eden-scarf', EDEN, 'Eden', EDEN_RELAY);
  const mug = listed('shop-mug', 'f'.repeat(64), 'Shop', MARKET_RELAY);
  const edenChip = () => screen.getByTestId(`market-filter-merchant-${EDEN}`);
  const ids = () =>
    screen.UNSAFE_getByType(FlatList).props.data.map((product: { id: string }) => product.id);
  let screen: ReturnType<typeof render>;
  const load = (generation: number, products: typeof mockLiveProducts, answered: string[]) => {
    mockGeneration = generation;
    mockLiveProducts = products;
    mockAnsweredRelays = answered;
    screen.rerender(<MarketScreen navigation={navigation} />);
  };

  beforeEach(() => {
    mockInitialPreferences.mode = 'wotFriends';
    mockLoading = false;
    mockCompleted = true;
    mockGeneration = 1;
    mockAnsweredRelays = [MARKET_RELAY, EDEN_RELAY];
    mockLiveProducts = [scarf, mug] as unknown as typeof mockLiveProducts;
    screen = render(<MarketScreen navigation={navigation} />);
    fireEvent.press(screen.getByTestId('market-filter-button'));
  });

  it('applies the merchant filter as soon as the chip is tapped', () => {
    expect(ids()).toEqual(['eden-scarf', 'shop-mug']);
    fireEvent.press(edenChip());
    expect(ids()).toEqual(['eden-scarf']);
    expect(edenChip().props.accessibilityState).toEqual({ selected: true });
  });

  it("keeps the selection and the chip through a refresh that missed the seller's relay", () => {
    fireEvent.press(edenChip());
    mockUpdate.mockClear();
    load(2, [mug] as unknown as typeof mockLiveProducts, [MARKET_RELAY]);
    load(3, [mug] as unknown as typeof mockLiveProducts, [MARKET_RELAY]);
    expect(mockUpdate).not.toHaveBeenCalled();
    // The chip stays rendered and selected, so it can be unselected.
    expect(edenChip().props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId(`market-filter-merchant-${EDEN}`)).toHaveTextContent('Eden');
    expect(ids()).toEqual([]);
    expect(screen.getByText('market.screen.emptyMerchantMissing')).toBeTruthy();
    fireEvent.press(edenChip());
    expect(mockUpdate).toHaveBeenLastCalledWith({ merchant: null });
    expect(ids()).toEqual(['shop-mug']);
  });

  it('clears the merchant once their relay answered two loads in a row without them', () => {
    fireEvent.press(edenChip());
    mockUpdate.mockClear();
    load(2, [mug] as unknown as typeof mockLiveProducts, [MARKET_RELAY, EDEN_RELAY]);
    expect(mockUpdate).not.toHaveBeenCalled();
    load(3, [mug] as unknown as typeof mockLiveProducts, [MARKET_RELAY, EDEN_RELAY]);
    expect(mockUpdate).toHaveBeenCalledWith({ merchant: null });
    expect(screen.queryByTestId(`market-filter-merchant-${EDEN}`)).toBeNull();
  });

  it('clears a merchant missing from the new seller scope on its first load', () => {
    fireEvent.press(edenChip());
    mockUpdate.mockClear();
    // The preferred scope's catalogue (mocked) has no listings from Eden.
    mockLiveProducts = [mug] as unknown as typeof mockLiveProducts;
    fireEvent.press(screen.getByTestId('market-filter-sellers-preferred'));
    expect(mockUpdate).toHaveBeenCalledWith({ merchant: null });
  });
});

it('filters by Ships to from shipping data, with unknown shipping behind the include toggle', () => {
  mockLiveProducts = [
    { ...MARKET_PRODUCTS[0], id: 'ships-gb' },
    { ...MARKET_PRODUCTS[0], id: 'ships-de' },
    { ...MARKET_PRODUCTS[0], id: 'worldwide' },
    { ...MARKET_PRODUCTS[0], id: 'unknown' },
  ];
  mockShipsTo = new Map([
    ['ships-gb', { kind: 'countries', countries: ['GB'] }],
    ['ships-de', { kind: 'countries', countries: ['DE'] }],
    ['worldwide', { kind: 'anywhere', reason: 'worldwide' }],
    ['unknown', { kind: 'unknown' }],
  ]);
  const screen = render(<MarketScreen navigation={navigation} />);
  const ids = () =>
    screen.UNSAFE_getByType(FlatList).props.data.map((product: { id: string }) => product.id);
  expect(ids()).toEqual(['ships-gb', 'ships-de', 'worldwide', 'unknown']);
  fireEvent.press(screen.getByTestId('market-filter-button'));
  // Phone's country (GB) leads the chips, after Worldwide.
  expect(screen.getByTestId('market-filter-shipsto-anywhere')).toBeTruthy();
  fireEvent.press(screen.getByTestId('market-filter-shipsto-GB'));
  expect(ids()).toEqual(['ships-gb', 'worldwide', 'unknown']);
  fireEvent(screen.getByTestId('market-filter-shipsto-include-unknown'), 'valueChange', false);
  expect(ids()).toEqual(['ships-gb', 'worldwide']);
  fireEvent.press(screen.getByTestId('market-filter-shipsto-anywhere'));
  expect(ids()).toEqual(['ships-gb', 'ships-de', 'worldwide', 'unknown']);
});

it('offers the phone country for worldwide sellers and keeps a picker selection as a chip', () => {
  mockLiveProducts = [{ ...MARKET_PRODUCTS[0], id: 'worldwide' }];
  mockShipsTo = new Map([['worldwide', { kind: 'anywhere', reason: 'worldwide' }]]);
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId('market-filter-button'));
  expect(screen.getByTestId('market-filter-shipsto-GB')).toBeTruthy();
  fireEvent.press(screen.getByTestId('market-filter-shipsto-more'));
  fireEvent.press(screen.getByTestId('country-picker-row-JP'));
  expect(screen.queryByTestId('country-picker-row-JP')).toBeNull();
  expect(screen.getByTestId('market-filter-shipsto-JP').props.accessibilityState.selected).toBe(
    true,
  );
  expect(mockUpdate).toHaveBeenCalledWith({ shipsTo: 'JP' });
  fireEvent(screen.getByTestId('market-filter-shipsto-include-unknown'), 'valueChange', false);
  expect(
    screen.UNSAFE_getByType(FlatList).props.data.map((product: { id: string }) => product.id),
  ).toEqual(['worldwide']);
  fireEvent.press(screen.getByTestId('market-filter-shipsto-JP'));
  expect(mockUpdate).toHaveBeenCalledWith({ shipsTo: null });
});

it('shows live preferred listings rather than the bundled catalogue', () => {
  mockLiveProducts = [
    { ...MARKET_PRODUCTS[0], id: 'live-preferred', title: 'Live preferred item' },
  ];
  const screen = render(<MarketScreen navigation={navigation} />);
  const list = screen.UNSAFE_getByType(FlatList);
  expect(list.props.data.map((product: { id: string }) => product.id)).toEqual(['live-preferred']);
});

it('drops the status row: pull-to-refresh only, with a banner only for unreachable sellers', () => {
  mockLoading = false;
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-live-status')).toBeNull();
  expect(screen.queryByTestId('market-live-refresh')).toBeNull();
  expect(screen.queryByTestId('market-partial-banner')).toBeNull();
  expect(screen.UNSAFE_getByType(FlatList).props.refreshControl).toBeTruthy();
  mockIncomplete = true;
  fireEvent.press(screen.getByTestId('market-filter-button'));
  fireEvent.press(screen.getByTestId('market-filter-sellers-friends'));
  expect(screen.queryByTestId('market-partial-banner')).toBeNull();
  mockSellersUnreachable = true;
  screen.rerender(<MarketScreen navigation={navigation} />);
  expect(screen.getByTestId('market-partial-banner')).toHaveTextContent('market.live.partialToast');
  mockLoading = true;
  screen.rerender(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-partial-banner')).toBeNull();
});

it('opens Filters from the Preferred pill; the Friends pill × returns to Preferred', () => {
  mockLoading = false;
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId('market-scope-pill-preferred'));
  expect(screen.getByTestId('market-filter-sellers')).toBeTruthy();
  fireEvent.press(screen.getByTestId('market-filter-sellers-friends'));
  fireEvent.press(screen.getByTestId('market-filter-done'));
  act(() => jest.runOnlyPendingTimers());
  expect(screen.queryByTestId('market-scope-pill-preferred')).toBeNull();
  expect(screen.getByTestId('market-scope-pill-friends')).toHaveTextContent(
    'market.filters.friendsChip',
  );
  fireEvent.press(screen.getByTestId('market-scope-pill-friends'));
  expect(mockUpdate).toHaveBeenLastCalledWith({ mode: 'preferred' });
  expect(screen.getByTestId('market-scope-pill-preferred')).toBeTruthy();
});

it('hides collections without a merchant even when collection results exist', () => {
  mockCollections = [
    {
      pubkey: 'a'.repeat(64),
      tags: [
        ['d', 'art'],
        ['title', 'Art'],
      ],
    } as import('nostr-tools').Event,
  ];
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-collection-filters')).toBeNull();
  expect(mockCollectionScope).toHaveBeenLastCalledWith(false, null);
});

it('enables merchant-scoped collections for a remembered single merchant', () => {
  const merchant = jest
    .requireActual('../utils/marketMerchants')
    .marketMerchants(MARKET_PRODUCTS)[0].id;
  mockInitialPreferences.merchant = merchant;
  mockCollections = [
    {
      pubkey: 'a'.repeat(64),
      tags: [
        ['d', 'art'],
        ['title', 'Art'],
      ],
    } as import('nostr-tools').Event,
  ];
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(mockCollectionScope).toHaveBeenLastCalledWith(true, merchant);
  expect(screen.getByTestId('market-collection-filters')).toBeTruthy();
});

it.each(['preferred', 'wotFriends'] as const)(
  'See all resets conflicting filters on a reused %s grid, even for the same seller',
  (mode) => {
    const seller = 'a'.repeat(64);
    mockCompleted = true;
    mockLoading = false;
    mockInitialPreferences = {
      mode,
      merchant: seller,
      shipsTo: 'DE',
      includeUnknownShipping: false,
      currency: 'EUR',
    };
    mockSelectedCollection = `30405:${seller}:old-collection`;
    mockLiveProducts = [
      {
        ...MARKET_PRODUCTS[0],
        id: 'seller-item',
        listing: {
          event: { pubkey: seller, tags: [] },
          currency: 'SAT',
          vendor: { country: 'GB' },
        },
      } as unknown as (typeof MARKET_PRODUCTS)[number],
    ];
    const screen = render(<MarketScreen navigation={navigation} />);
    fireEvent.press(screen.getByTestId('market-header-search'));
    fireEvent.changeText(screen.getByTestId('market-search-input'), 'unrelated search');
    act(() => jest.advanceTimersByTime(300));
    expect(screen.UNSAFE_getByType(FlatList).props.data).toEqual([]);
    const route = {
      key: 'market',
      name: 'Market',
      params: { merchant: seller, mode },
    } as MarketRoute;
    screen.rerender(<MarketScreen navigation={navigation} route={route} />);
    act(() => jest.advanceTimersByTime(300));
    expect(mockUpdate).toHaveBeenCalledWith({
      merchant: seller,
      mode,
      shipsTo: null,
      includeUnknownShipping: true,
      currency: null,
    });
    expect(mockSelectCollection).toHaveBeenCalledWith(null);
    expect(screen.getByTestId('market-search-input').props.value).toBe('');
    expect(screen.UNSAFE_getByType(FlatList).props.data.map((p: { id: string }) => p.id)).toEqual([
      'seller-item',
    ]);
    // Consumed params must not reset subsequent searches on preference renders.
    fireEvent.changeText(screen.getByTestId('market-search-input'), 'new search');
    screen.rerender(<MarketScreen navigation={navigation} route={route} />);
    expect(screen.getByTestId('market-search-input').props.value).toBe('new search');
  },
);

it('opens Liked items from the shortcut row', () => {
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId('market-shortcut-liked'));
  expect(navigation.navigate).toHaveBeenCalledWith('MarketLikedItems');
});

describe('experimental seller scopes (friends of friends / All)', () => {
  const openFilters = (screen: ReturnType<typeof render>) =>
    fireEvent.press(screen.getByTestId('market-filter-button'));

  it('keeps friends of friends "coming soon" and All hidden while experimental is off', () => {
    const screen = render(<MarketScreen navigation={navigation} />);
    openFilters(screen);
    const fof = screen.getByTestId('market-scope-fof');
    expect(fof.props.accessibilityState).toEqual({ selected: false, disabled: true });
    expect(screen.getByText('market.filters.comingSoon')).toBeTruthy();
    expect(screen.queryByTestId('market-scope-all')).toBeNull();
    fireEvent.press(fof);
    expect(mockFofEnabled).toHaveBeenLastCalledWith(false, expect.anything());
    expect(mockFofArmed).toHaveBeenLastCalledWith(false);
  });

  it('unlocks both with experimental on; friends of friends queries the shared FoF set', () => {
    mockExperimental = true;
    const screen = render(<MarketScreen navigation={navigation} />);
    openFilters(screen);
    expect(screen.queryByText('market.filters.comingSoon')).toBeNull();
    expect(screen.getByTestId('market-scope-all').props.accessibilityState.disabled).toBe(false);
    fireEvent.press(screen.getByTestId('market-scope-fof'));
    expect(mockFofArmed).toHaveBeenLastCalledWith(true);
    expect(mockFofEnabled).toHaveBeenLastCalledWith(true, ['a'.repeat(64)]);
    expect(mockUpdate).toHaveBeenLastCalledWith({ mode: 'wotFof' });
    fireEvent.press(screen.getByTestId('market-filter-done'));
    act(() => jest.runOnlyPendingTimers());
    expect(screen.getByTestId('market-scope-pill-fof')).toHaveTextContent(
      'market.filters.friendsOfFriendsChip',
    );
    // A narrowing scope: one filter on the button.
    expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
    fireEvent.press(screen.getByTestId('market-scope-pill-fof'));
    expect(screen.getByTestId('market-scope-pill-preferred')).toBeTruthy();
  });

  it('shows the build progress and holds the listings query until the FoF set is known', () => {
    mockExperimental = true;
    mockInitialPreferences = { ...mockInitialPreferences, mode: 'wotFof' };
    mockFof = { authors: undefined, progress: { done: 2, total: 5 }, failed: false };
    const screen = render(<MarketScreen navigation={navigation} />);
    expect(screen.getByTestId('market-scope-fof-progress')).toHaveTextContent(
      'market.screen.fofBuilding',
    );
    expect(mockFofEnabled).toHaveBeenLastCalledWith(false, []);
    expect(screen.getByText('market.live.loadingNetwork')).toBeTruthy();
  });

  it('All: pill with the unvetted note, no filter badge, × back to Preferred', () => {
    mockExperimental = true;
    const screen = render(<MarketScreen navigation={navigation} />);
    openFilters(screen);
    fireEvent.press(screen.getByTestId('market-scope-all'));
    expect(mockAllEnabled).toHaveBeenLastCalledWith(true);
    fireEvent.press(screen.getByTestId('market-filter-done'));
    act(() => jest.runOnlyPendingTimers());
    expect(screen.getByTestId('market-scope-pill-all')).toHaveTextContent('market.filters.allChip');
    expect(screen.getByTestId('market-scope-all-note')).toHaveTextContent(
      'market.screen.allScopeNote',
    );
    // All is the unfiltered scope: no badge with nothing else selected.
    expect(screen.queryByTestId('market-filter-badge')).toBeNull();
    fireEvent.press(screen.getByTestId('market-header-search'));
    fireEvent.changeText(screen.getByTestId('market-search-input'), 'piggy');
    expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
    fireEvent.press(screen.getByTestId('market-search-clear'));
    fireEvent.press(screen.getByTestId('market-scope-pill-all'));
    expect(mockAllEnabled).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('market-scope-all-note')).toBeNull();
    expect(screen.getByTestId('market-filter-active-count')).toHaveTextContent('1');
  });

  it('falls back to Preferred when experimental features are turned off', () => {
    mockExperimental = true;
    mockInitialPreferences = { ...mockInitialPreferences, mode: 'wotAll' };
    const screen = render(<MarketScreen navigation={navigation} />);
    expect(screen.getByTestId('market-scope-pill-all')).toBeTruthy();
    expect(mockAllEnabled).toHaveBeenLastCalledWith(true);
    mockExperimental = false;
    screen.rerender(<MarketScreen navigation={navigation} />);
    expect(screen.queryByTestId('market-scope-pill-all')).toBeNull();
    expect(screen.getByTestId('market-scope-pill-preferred')).toBeTruthy();
    expect(mockAllEnabled).toHaveBeenLastCalledWith(false);
    openFilters(screen);
    expect(
      screen.getByTestId('market-filter-sellers-preferred').props.accessibilityState.selected,
    ).toBe(true);
    expect(screen.queryByTestId('market-scope-all')).toBeNull();
  });
});

it('expands and closes header search, clearing the query', () => {
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-search-input')).toBeNull();
  fireEvent.press(screen.getByTestId('market-header-search'));
  fireEvent.changeText(screen.getByTestId('market-search-input'), 'sats');
  fireEvent.press(screen.getByTestId('market-search-clear'));
  expect(screen.queryByTestId('market-search-input')).toBeNull();
  fireEvent.press(screen.getByTestId('market-header-search'));
  expect(screen.getByTestId('market-search-input').props.value).toBe('');
});

it.each([
  ['market-shortcut-shop', 'MarketMyShop'],
  ['market-shortcut-orders', 'MarketMyOrders'],
])('opens %s from the shortcut row', (id, route) => {
  const screen = render(<MarketScreen navigation={navigation} />);
  fireEvent.press(screen.getByTestId(id));
  expect(navigation.navigate).toHaveBeenCalledWith(route);
  expect(screen.queryByTestId('market-menu-close')).toBeNull();
});

it.each([1, 12])('shows the buyer action badge for %s orders', (count) => {
  mockBuyerActions = count;
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.getByTestId('market-shortcut-orders-badge')).toHaveTextContent(String(count));
  fireEvent.press(screen.getByTestId('market-shortcut-orders'));
  expect(navigation.navigate).toHaveBeenCalledWith('MarketMyOrders');
});

it('hides zero action badges and offers Start selling without listings', () => {
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-shortcut-orders-badge')).toBeNull();
  expect(screen.queryByTestId('market-shortcut-shop-badge')).toBeNull();
  expect(screen.getByTestId('market-shortcut-shop')).toHaveTextContent(
    'market.shortcuts.startSelling',
  );
});

it('shows positive liked counts and hides the zero badge', () => {
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-shortcut-liked-badge')).toBeNull();
  mockLikedProducts = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
  screen.unmount();
  const updated = render(<MarketScreen navigation={navigation} />);
  expect(updated.getByTestId('market-shortcut-liked-badge')).toHaveTextContent('3');
});

it('does not report a zero liked count after a failed fetch', () => {
  mockLikedFailed = true;
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.queryByTestId('market-shortcut-liked-badge')).toBeNull();
  expect(screen.getByTestId('market-shortcut-liked').props.accessibilityLabel).toBe(
    'market.shortcuts.liked',
  );
});

it('keeps the known liked count after a failed refresh', () => {
  mockLikedFailed = true;
  mockLikedProducts = [{ id: 'one' }];
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.getByTestId('market-shortcut-liked-badge')).toHaveTextContent('1');
  expect(screen.getByTestId('market-shortcut-liked').props.accessibilityLabel).toBe(
    'market.shortcuts.liked, 1',
  );
});

it('shows My shop and its action badge for a seller with listings', () => {
  mockHasListings = true;
  mockSellerActions = 4;
  const screen = render(<MarketScreen navigation={navigation} />);
  expect(screen.getByText('market.sell.myShop')).toBeTruthy();
  expect(screen.getByTestId('market-shortcut-shop-badge')).toHaveTextContent('4');
});
