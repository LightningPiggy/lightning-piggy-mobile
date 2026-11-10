import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import PlaceDetailScreen from './PlaceDetailScreen';
import { fetchPlaceById, fetchPlaceRich, type BtcMapPlace } from '../services/btcMapService';

jest.mock('../contexts/ThemeContext', () => ({ useThemeColors: () => ({}) }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => ({ profile: null }) }));
jest.mock('../contexts/UserLocationContext', () => ({ useUserLocation: () => ({ pos: null }) }));
jest.mock('../components/LibreMiniMap', () => ({ LibreMiniMap: () => null }));
jest.mock('../components/BrandPatternBackground', () => () => null);
jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
}));
jest.mock('../services/btcMapService', () => ({
  ...jest.requireActual('../services/btcMapService'),
  fetchPlaceById: jest.fn(),
  fetchPlaceRich: jest.fn(),
}));

const place: BtcMapPlace = {
  id: 42,
  lat: 1,
  lon: 2,
  tags: { name: 'Merchant' },
  verified_at: null,
  osm_url: 'https://www.openstreetmap.org/way/123',
};
const props = {
  navigation: { goBack: jest.fn(), navigate: jest.fn() },
  route: { params: { placeId: 42 } },
} as unknown as React.ComponentProps<typeof PlaceDetailScreen>;
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(fetchPlaceById).mockResolvedValue(place);
  jest.mocked(fetchPlaceRich).mockResolvedValue(null);
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('offers View on BTC Map next to verify and edit with the OSM identifier', async () => {
  const ui = render(<PlaceDetailScreen {...props} />);
  await waitFor(() => expect(ui.getByTestId('place-view-on-btcmap')).toBeTruthy());
  fireEvent.press(ui.getByTestId('place-view-on-btcmap'));
  expect(Linking.openURL).toHaveBeenCalledWith('https://btcmap.org/merchant/way:123');
  expect(ui.getByTestId('place-detail-verify')).toBeTruthy();
  expect(ui.getByTestId('place-detail-suggest-edit')).toBeTruthy();
});
it.each(['plain', 'contact', 'curated'])(
  'shows callable phone and website from %s data',
  async (source) => {
    const tags: Record<string, string> =
      source === 'plain'
        ? { phone: '+44 123', website: 'example.com' }
        : { 'contact:phone': '+44 123', 'contact:website': 'https://example.com' };
    jest.mocked(fetchPlaceRich).mockResolvedValue({
      ...place,
      tags: { ...place.tags, ...tags },
      phone: source === 'curated' ? '+44 123' : null,
    });
    const ui = render(<PlaceDetailScreen {...props} />);
    await waitFor(() => expect(ui.getByTestId('place-phone')).toBeTruthy());
    fireEvent.press(ui.getByTestId('place-phone'));
    expect(Linking.openURL).toHaveBeenCalledWith('tel:+44123');
    fireEvent.press(ui.getByTestId('place-website'));
    expect(Linking.openURL).toHaveBeenCalledWith('https://example.com');
  },
);
it('hides missing contacts and a merchant link without an OSM reference', async () => {
  jest.mocked(fetchPlaceById).mockResolvedValue({ ...place, osm_url: null });
  const ui = render(<PlaceDetailScreen {...props} />);
  await waitFor(() => expect(ui.getByTestId('place-detail-directions-button')).toBeTruthy());
  expect(ui.queryByTestId('place-phone')).toBeNull();
  expect(ui.queryByTestId('place-website')).toBeNull();
  expect(ui.queryByTestId('place-view-on-btcmap')).toBeNull();
});
