import {
  amountToSats,
  checkoutRateCurrencies,
  checkoutShippingCostSats,
  checkoutShippingOptions,
  checkoutUnitPriceSats,
} from './marketCheckoutPricing';
import type { MarketCheckoutTarget } from './marketCheckout';
import type { ShippingOption } from './marketShipping';

const SELLER = 'c'.repeat(64);
const option = (dTag: string, baseAmount: number, currency: string): ShippingOption => ({
  coordinate: `30406:${SELLER}:${dTag}`,
  pubkey: SELLER,
  dTag,
  title: dTag,
  baseAmount,
  currency,
  countries: [],
  createdAt: 1,
});
const listing = (
  price: { amount: number; currency: string },
  shippingRefs: MarketCheckoutTarget['shippingRefs'] = [],
): MarketCheckoutTarget => ({
  vendorPubkey: SELLER,
  listingDTag: 'mug',
  fulfilment: 'physical',
  source: 'listing',
  price,
  stock: null,
  shippingRefs,
});
const RATES = { GBP: 50_000, USD: 100_000 };

describe('amountToSats', () => {
  it('passes sats through, scales BTC and converts fiat at the rate', () => {
    expect(amountToSats(21, 'sat', {})).toBe(21);
    expect(amountToSats(0.001, 'BTC', {})).toBe(100_000);
    expect(amountToSats(10, 'gbp', RATES)).toBe(20_000);
  });
  it('fails closed without a fiat rate', () => {
    expect(amountToSats(10, 'EUR', RATES)).toBeNull();
    expect(amountToSats(10, 'GBP', { GBP: null })).toBeNull();
  });
});

describe('checkoutUnitPriceSats', () => {
  it('uses the catalogue sats for curated products', () => {
    expect(checkoutUnitPriceSats({ priceSats: 21 }, { source: 'curated' }, {})).toBe(21);
    expect(checkoutUnitPriceSats({ priceSats: 0 }, { source: 'curated' }, {})).toBeNull();
  });
  it('converts a listing price at the live rate', () => {
    const target = listing({ amount: 12.5, currency: 'GBP' });
    expect(checkoutUnitPriceSats({ priceSats: 0 }, target, RATES)).toBe(25_000);
    expect(checkoutUnitPriceSats({ priceSats: 0 }, target, {})).toBeNull();
  });
  it('never yields a zero-sat unit (a sub-sat fiat price)', () => {
    const target = listing({ amount: 0.0001, currency: 'USD' });
    expect(checkoutUnitPriceSats({ priceSats: 0 }, target, RATES)).toBeNull();
  });
});

describe('checkoutShippingOptions', () => {
  const uk = option('uk', 5, 'GBP');
  const eu = option('eu', 7, 'EUR');
  it('offers every seller option when the listing references none', () => {
    expect(checkoutShippingOptions(listing({ amount: 1, currency: 'GBP' }), [uk, eu])).toEqual([
      uk,
      eu,
    ]);
  });
  it('restricts to the referenced options that the seller still publishes', () => {
    const target = listing({ amount: 1, currency: 'GBP' }, [
      { coordinate: eu.coordinate, extraAmount: 0 },
      { coordinate: `30406:${SELLER}:gone`, extraAmount: 0 },
    ]);
    expect(checkoutShippingOptions(target, [uk, eu])).toEqual([eu]);
  });
});

describe('checkoutShippingCostSats', () => {
  it('adds the listing surcharge in the LISTING currency to the option base', () => {
    const uk = option('uk', 5, 'GBP');
    // Listing in USD: £5 base + $2 extra.
    const target = listing({ amount: 10, currency: 'USD' }, [
      { coordinate: uk.coordinate, extraAmount: 2 },
    ]);
    expect(checkoutShippingCostSats(uk, target, RATES)).toBe(10_000 + 2_000);
    expect(checkoutShippingCostSats(uk, target, { GBP: 50_000 })).toBeNull();
  });
  it('ignores surcharges on curated products and on unreferenced options', () => {
    const uk = option('uk', 5, 'GBP');
    expect(checkoutShippingCostSats(uk, { source: 'curated', shippingRefs: [] }, RATES)).toBe(
      10_000,
    );
    expect(checkoutShippingCostSats(uk, listing({ amount: 1, currency: 'GBP' }), RATES)).toBe(
      10_000,
    );
  });
  it('prices a free option without any rate', () => {
    expect(
      checkoutShippingCostSats(
        option('pickup', 0, 'EUR'),
        listing({ amount: 1, currency: 'SATS' }),
        {},
      ),
    ).toBe(0);
  });
});

describe('checkoutRateCurrencies', () => {
  it('lists each fiat currency once, never sats or BTC', () => {
    expect(
      checkoutRateCurrencies(listing({ amount: 1, currency: 'usd' }), [
        option('a', 1, 'GBP'),
        option('b', 1, 'SATS'),
        option('c', 1, 'USD'),
        option('d', 1, 'BTC'),
      ]),
    ).toEqual(['GBP', 'USD']);
    expect(checkoutRateCurrencies({ price: undefined }, [])).toEqual([]);
  });
});
