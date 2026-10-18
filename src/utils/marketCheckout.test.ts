import { MARKET_PRODUCTS, sellerOf, type MarketProduct } from '../data/marketProducts';
import type { MarketVendor } from '../data/marketVendors';
import type { Event } from 'nostr-tools';
import { maxOrderQuantity, marketCheckoutTarget } from './marketCheckout';
import type { MarketListing } from './marketListings';

const vendor: MarketVendor = {
  name: 'Robotechy',
  country: 'United Kingdom',
  shippingRegions: ['Worldwide'],
  shopType: 'online',
  description: 'x',
  url: 'https://robotechy.com',
  logo: 'https://example.com/logo.png',
  nostrUrl: 'https://njump.me/npub1yy0nyk6nj6tg4sx8nd7q5qcdw6pqd5e2cc0e8u2rmcgjhpvm63hsk67xe5',
  xUrl: '',
  featured: false,
};

const product: MarketProduct = {
  id: 'robotechy-lightning-piggy',
  title: 'Lightning Piggy',
  description: 'x',
  priceSats: 1,
  priceFiatLabel: '£60',
  image: 'https://example.com/x.png',
  sellerName: 'Robotechy',
  url: 'https://robotechy.com',
  featured: true,
};

describe('marketCheckoutTarget', () => {
  it('uses the website for a Nostr seller without an explicit opt-in', () => {
    expect(marketCheckoutTarget(product, vendor)).toBeNull();
  });

  it('uses the website when the opted-in seller has no Nostr identity', () => {
    const optedIn = {
      ...product,
      checkout: { listingDTag: 'lp', fulfilment: 'physical' as const },
    };
    expect(marketCheckoutTarget(optedIn, { ...vendor, nostrUrl: '' })).toBeNull();
    expect(marketCheckoutTarget(optedIn, undefined)).toBeNull();
  });

  it('rejects a blank listing id', () => {
    const blank = { ...product, checkout: { listingDTag: '  ', fulfilment: 'none' as const } };
    expect(marketCheckoutTarget(blank, vendor)).toBeNull();
  });

  it('orders against the seller listing id, not the catalogue id', () => {
    const optedIn = {
      ...product,
      checkout: { listingDTag: 'seller-listing-42', fulfilment: 'none' as const },
    };
    expect(marketCheckoutTarget(optedIn, vendor)).toEqual({
      vendorPubkey: expect.stringMatching(/^[0-9a-f]{64}$/),
      listingDTag: 'seller-listing-42',
      fulfilment: 'none',
      source: 'curated',
      stock: null,
      shippingRefs: [],
    });
  });
});

describe('catalogue checkout opt-in', () => {
  it('offers in-app checkout only for the dev test sellers', () => {
    const inApp = MARKET_PRODUCTS.filter((p) => marketCheckoutTarget(p, sellerOf(p)) !== null);
    for (const p of inApp) {
      // Real sellers keep the website link until they confirm order support
      // and supply their real listing id (#948 review).
      expect(p.sellerName).toMatch(/\(TEST\)$/);
    }
    for (const p of MARKET_PRODUCTS.filter((x) => !x.sellerName.endsWith('(TEST)'))) {
      expect(p.checkout).toBeUndefined();
    }
  });
});

describe('marketCheckoutTarget — Nostr listings (Gamma kind 30402)', () => {
  const SELLER = 'c'.repeat(64);
  const BUYER = 'd'.repeat(64);
  const SHIP = `30406:${SELLER}:uk`;

  function listingProduct(tags: string[][], fields: Partial<Event> = {}): MarketProduct {
    const event = {
      id: 'e'.repeat(64),
      sig: 'f'.repeat(128),
      kind: 30402,
      pubkey: SELLER,
      created_at: 1,
      content: '',
      tags: [['d', 'mug'], ['title', 'Mug'], ...tags],
      ...fields,
    } as Event;
    return {
      ...product,
      id: 'nostr-30402-mug',
      listing: { event, currency: 'GBP', priceLabel: '', vendor } as MarketListing,
    };
  }

  it('targets the listing author, its own d tag and price', () => {
    const target = marketCheckoutTarget(listingProduct([['price', '12.50', 'gbp']]), vendor, BUYER);
    expect(target).toEqual({
      vendorPubkey: SELLER,
      listingDTag: 'mug',
      fulfilment: 'none',
      source: 'listing',
      price: { amount: 12.5, currency: 'GBP' },
      stock: null,
      shippingRefs: [],
    });
  });

  it('a physical listing carries its stock and shipping_option refs (extra in the listing currency)', () => {
    const target = marketCheckoutTarget(
      listingProduct([
        ['price', '2100', 'SAT'],
        ['type', 'simple', 'physical'],
        ['stock', '3'],
        ['shipping_option', SHIP, '1.5'],
      ]),
      vendor,
      BUYER,
    );
    expect(target).toMatchObject({
      fulfilment: 'physical',
      price: { amount: 2100, currency: 'SATS' },
      stock: 3,
      shippingRefs: [{ coordinate: SHIP, extraAmount: 1.5 }],
    });
  });

  it('defaults to digital (no shipping) when the type tag is absent or digital', () => {
    const digital = listingProduct([
      ['price', '5', 'EUR'],
      ['type', 'simple', 'digital'],
      ['shipping_option', SHIP],
    ]);
    expect(marketCheckoutTarget(digital, vendor, BUYER)).toMatchObject({
      fulfilment: 'none',
      shippingRefs: [],
    });
  });

  it('never targets your own listing', () => {
    expect(
      marketCheckoutTarget(listingProduct([['price', '1', 'USD']]), vendor, SELLER),
    ).toBeNull();
    expect(
      marketCheckoutTarget(listingProduct([['price', '1', 'USD']]), vendor, SELLER.toUpperCase()),
    ).toBeNull();
  });

  it.each([
    ['no price', []],
    ['a zero price', [['price', '0', 'USD']]],
    ['a negative price', [['price', '-1', 'USD']]],
    ['a non-numeric price', [['price', 'ten', 'USD']]],
    ['an unknown currency', [['price', '1', 'XYZ']]],
    ['msats (not converted by the reader)', [['price', '1000', 'MSAT']]],
    ['a subscription price', [['price', '5', 'USD', 'M']]],
    [
      'a variable parent',
      [
        ['price', '5', 'USD'],
        ['type', 'variable', 'physical'],
      ],
    ],
  ])('rejects %s', (_label, tags) => {
    expect(marketCheckoutTarget(listingProduct(tags as string[][]), vendor, BUYER)).toBeNull();
  });

  it('rejects classic NIP-15 (30018) products and a missing d tag', () => {
    expect(
      marketCheckoutTarget(listingProduct([['price', '1', 'USD']], { kind: 30018 }), vendor, BUYER),
    ).toBeNull();
    const noD = listingProduct([['price', '1', 'USD']]);
    noD.listing!.event.tags = noD.listing!.event.tags.filter((t) => t[0] !== 'd');
    expect(marketCheckoutTarget(noD, vendor, BUYER)).toBeNull();
  });

  it('caps the order quantity at stock', () => {
    expect(maxOrderQuantity({ stock: null })).toBe(99);
    expect(maxOrderQuantity({ stock: 3 })).toBe(3);
    expect(maxOrderQuantity({ stock: 0 })).toBe(0);
    expect(maxOrderQuantity({ stock: 500 })).toBe(99);
  });
});
