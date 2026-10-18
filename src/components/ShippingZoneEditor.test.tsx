import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import ShippingZoneEditor from './ShippingZoneEditor';
import type { MarketSellerStyles } from '../styles/MarketSeller.styles';
import type { ShippingZoneDraft } from '../utils/marketSellerEvents';

jest.mock('../contexts/ThemeContext', () => ({
  useThemeColors: () => ({
    brandPink: '#f0f',
    textBody: '#000',
    textSupplementary: '#888',
    red: '#f00',
  }),
}));
jest.mock('../contexts/LocaleContext', () => ({
  useTranslation: () => (key: string, params?: { count?: number }) =>
    params?.count === undefined ? key : `${key}:${params.count}`,
}));
jest.mock('lucide-react-native', () => ({
  ChevronDown: () => null,
  ChevronUp: () => null,
  Plus: () => null,
  Trash2: () => null,
  X: () => null,
}));

const styles = {} as MarketSellerStyles;
const zone: ShippingZoneDraft = {
  dTag: 'uk',
  name: 'Royal Mail',
  countries: ['GB'],
  cost: '3',
  currency: 'GBP',
};
const renderZone = (props: Partial<React.ComponentProps<typeof ShippingZoneEditor>> = {}) =>
  render(
    <ShippingZoneEditor
      zone={zone}
      index={0}
      currency="GBP"
      showErrors={false}
      styles={styles}
      onChange={jest.fn()}
      onRemove={jest.fn()}
      onAddCountry={jest.fn()}
      {...props}
    />,
  );

it('starts collapsed with a one-line summary, and expands on tap', () => {
  const screen = renderZone();
  expect(screen.getByText('Royal Mail')).toBeTruthy();
  expect(screen.getByText('3 GBP · market.sell.zone.presetUk')).toBeTruthy();
  expect(screen.queryByTestId('shop-zone-name-0')).toBeNull();
  fireEvent.press(screen.getByTestId('shop-zone-toggle-0'));
  expect(screen.getByTestId('shop-zone-name-0')).toBeTruthy();
  fireEvent.press(screen.getByTestId('shop-zone-toggle-0'));
  expect(screen.queryByTestId('shop-zone-name-0')).toBeNull();
});

it('summarises a long country list as a count', () => {
  const screen = renderZone({ zone: { ...zone, countries: ['GB', 'IE', 'FR'] } });
  expect(screen.getByText('3 GBP · market.sell.zone.countryCount:3')).toBeTruthy();
});

it('opens a newly added zone, and any zone with errors once save is attempted', () => {
  expect(renderZone({ initiallyOpen: true }).getByTestId('shop-zone-name-0')).toBeTruthy();
  const invalid = renderZone({ zone: { ...zone, name: '' }, showErrors: true });
  expect(invalid.getByTestId('shop-zone-name-0')).toBeTruthy();
  expect(invalid.getByText('market.sell.zone.untitled')).toBeTruthy();
});

it('stays open while an error is being fixed', () => {
  const screen = renderZone({ zone: { ...zone, name: '' }, showErrors: true });
  screen.rerender(
    <ShippingZoneEditor
      zone={{ ...zone, name: 'R' }}
      index={0}
      currency="GBP"
      showErrors
      styles={styles}
      onChange={jest.fn()}
      onRemove={jest.fn()}
      onAddCountry={jest.fn()}
    />,
  );
  expect(screen.getByTestId('shop-zone-name-0')).toBeTruthy();
});

it('opens for a cost Save would reject, such as fractional sats', () => {
  const screen = renderZone({ zone: { ...zone, cost: '1.5', currency: 'SATS' }, showErrors: true });
  expect(screen.getByTestId('shop-zone-cost-0')).toBeTruthy();
});
