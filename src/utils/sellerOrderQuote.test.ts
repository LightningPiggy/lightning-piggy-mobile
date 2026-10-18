import type { Event } from 'nostr-tools';
import {
  orderItemsSummary,
  orderOwnership,
  parseCoordinate,
  quoteSellerOrder,
} from './sellerOrderQuote';
import type { ParsedOrderEvent } from './orderEvents';
import type { ShippingOption } from './marketShipping';

const SELLER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const RATES = { GBP: 50_000, USD: 100_000 };

function listing(d: string, tags: string[][], pubkey = SELLER): Event {
  return {
    id: `${d}-id`.padEnd(64, '0'),
    sig: 'f'.repeat(128),
    kind: 30402,
    pubkey,
    created_at: 1,
    content: '',
    tags: [['d', d], ['title', d.toUpperCase()], ...tags],
  } as Event;
}
const zone = (d: string, baseAmount: number, currency: string): ShippingOption => ({
  coordinate: `30406:${SELLER}:${d}`,
  pubkey: SELLER,
  dTag: d,
  title: `Zone ${d}`,
  baseAmount,
  currency,
  countries: [],
  createdAt: 1,
});
function order(over: Partial<ParsedOrderEvent> = {}): ParsedOrderEvent {
  return {
    kind: 16,
    type: 'order',
    orderId: 'o-1',
    items: [{ ref: `30402:${SELLER}:mug`, quantity: 2 }],
    message: '',
    ...over,
  };
}

describe('parseCoordinate / orderOwnership', () => {
  it('parses kind-checked coordinates', () => {
    expect(parseCoordinate(`30402:${SELLER}:mug:blue`, 30402)).toEqual({
      pubkey: SELLER,
      dTag: 'mug:blue',
    });
    expect(parseCoordinate(`30406:${SELLER}:uk`, 30402)).toBeNull();
    expect(parseCoordinate('30402:nothex:mug', 30402)).toBeNull();
  });

  it('is mine only when EVERY item is my listing', () => {
    expect(orderOwnership(order(), SELLER)).toBe('mine');
    expect(orderOwnership(order(), OTHER)).toBe('notMine');
    expect(
      orderOwnership(
        order({
          items: [
            { ref: `30402:${SELLER}:mug`, quantity: 1 },
            { ref: `30402:${OTHER}:hat`, quantity: 1 },
          ],
        }),
        SELLER,
      ),
    ).toBe('notMine');
    expect(orderOwnership(order({ items: [] }), SELLER)).toBe('empty');
    expect(orderOwnership(order({ type: 'payment' }), SELLER)).toBe('empty');
  });
});

describe('quoteSellerOrder', () => {
  it('prices sats listings × quantity from MY listing, not the buyer amount', () => {
    const quote = quoteSellerOrder({
      order: order({ amountSats: 1 }),
      sellerPubkey: SELLER,
      listings: [listing('mug', [['price', '2100', 'sat']])],
      zones: [],
      rates: {},
    });
    expect(quote).toMatchObject({
      problem: null,
      subtotalSats: 4200,
      totalSats: 4200,
      buyerAmountSats: 1,
      amountMismatch: true,
      fiatTotal: null,
    });
    expect(quote.lines[0]).toMatchObject({ title: 'MUG', quantity: 2, unitSats: 2100 });
  });

  it('converts fiat at the current rate and adds shipping base + listing-currency surcharge', () => {
    const quote = quoteSellerOrder({
      order: order({ shipping: `30406:${SELLER}:uk`, amountSats: 52_000 }),
      sellerPubkey: SELLER,
      listings: [
        listing('mug', [
          ['price', '12.50', 'GBP'],
          ['type', 'simple', 'physical'],
          ['shipping_option', `30406:${SELLER}:uk`, '1'],
        ]),
      ],
      zones: [zone('uk', 5, 'GBP')],
      rates: RATES,
    });
    // 2 × £12.50 = £25 → 50,000 sats; shipping £5 + £1 = £6 → 12,000 sats.
    expect(quote).toMatchObject({
      problem: null,
      subtotalSats: 50_000,
      shippingSats: 12_000,
      totalSats: 62_000,
      fiatTotal: { amount: 31, currency: 'GBP' },
      amountMismatch: true,
      shippingMissing: false,
    });
    expect(quote.shipping).toMatchObject({ title: 'Zone uk', sats: 12_000, notOffered: false });
  });

  it('agrees with a buyer who computed the same total', () => {
    const quote = quoteSellerOrder({
      order: order({ amountSats: 50_000 }),
      sellerPubkey: SELLER,
      listings: [listing('mug', [['price', '12.50', 'GBP']])],
      zones: [],
      rates: RATES,
    });
    expect(quote.amountMismatch).toBe(false);
  });

  it('flags over-stock lines, missing shipping and options the listing does not offer', () => {
    const quote = quoteSellerOrder({
      order: order({ items: [{ ref: `30402:${SELLER}:mug`, quantity: 5 }] }),
      sellerPubkey: SELLER,
      listings: [
        listing('mug', [
          ['price', '100', 'SATS'],
          ['stock', '3'],
          ['type', 'simple', 'physical'],
        ]),
      ],
      zones: [],
      rates: {},
    });
    expect(quote.lines[0]).toMatchObject({ stock: 3, overStock: true });
    expect(quote.shippingMissing).toBe(true);
    expect(quote.totalSats).toBeNull();

    const notOffered = quoteSellerOrder({
      order: order({ shipping: `30406:${SELLER}:eu` }),
      sellerPubkey: SELLER,
      listings: [
        listing('mug', [
          ['price', '100', 'SATS'],
          ['shipping_option', `30406:${SELLER}:uk`],
        ]),
      ],
      zones: [zone('uk', 0, 'SATS'), zone('eu', 50, 'SATS')],
      rates: {},
    });
    expect(notOffered.shipping).toMatchObject({ notOffered: true, sats: 50 });
    expect(notOffered.totalSats).toBeNull();
  });

  it.each([
    ['notMine', order({ items: [{ ref: `30402:${OTHER}:mug`, quantity: 1 }] }), []],
    ['missingListing', order(), []],
    ['badPrice', order(), [listing('mug', [['price', '5', 'USD', 'M']])]],
  ] as const)('blocks with %s', (problem, o, listings) => {
    const quote = quoteSellerOrder({
      order: o,
      sellerPubkey: SELLER,
      listings: [...listings],
      zones: [],
      rates: RATES,
    });
    expect(quote.problem).toBe(problem);
    expect(quote.totalSats).toBeNull();
  });

  it('never uses another seller listing with the same d tag', () => {
    const quote = quoteSellerOrder({
      order: order(),
      sellerPubkey: SELLER,
      listings: [listing('mug', [['price', '1', 'SATS']], OTHER)],
      zones: [],
      rates: {},
    });
    expect(quote.problem).toBe('missingListing');
  });

  it('blocks an unknown shipping option and a missing rate', () => {
    const unknown = quoteSellerOrder({
      order: order({ shipping: `30406:${SELLER}:gone` }),
      sellerPubkey: SELLER,
      listings: [listing('mug', [['price', '1', 'SATS']])],
      zones: [],
      rates: {},
    });
    expect(unknown).toMatchObject({ problem: 'unknownShipping', totalSats: null });
    const noRate = quoteSellerOrder({
      order: order(),
      sellerPubkey: SELLER,
      listings: [listing('mug', [['price', '10', 'EUR']])],
      zones: [],
      rates: RATES,
    });
    expect(noRate).toMatchObject({ problem: 'noRate', totalSats: null });
  });
});

it('orderItemsSummary uses titles when known', () => {
  const o = order({
    items: [
      { ref: `30402:${SELLER}:mug`, quantity: 2 },
      { ref: `30402:${SELLER}:hat`, quantity: 1 },
    ],
  });
  expect(orderItemsSummary(o, new Map([[`30402:${SELLER}:mug`, 'Mug']]))).toBe('Mug × 2, hat × 1');
});

it('refuses unsafe quantities before computing an invoice amount', () => {
  const quote = quoteSellerOrder({
    sellerPubkey: SELLER,
    order: order({
      items: [{ ref: `30402:${SELLER}:mug`, quantity: Number.MAX_SAFE_INTEGER + 1 }],
    }),
    listings: [],
    zones: [],
    rates: {},
  });
  expect(quote.totalSats).toBeNull();
});

it('requires the chosen shipping option to be offered by every item that specifies options', () => {
  const quote = quoteSellerOrder({
    sellerPubkey: SELLER,
    order: order({
      items: [
        { ref: `30402:${SELLER}:mug`, quantity: 1 },
        { ref: `30402:${SELLER}:hat`, quantity: 1 },
      ],
      shipping: `30406:${SELLER}:uk`,
    }),
    listings: [
      listing('mug', [
        ['price', '100', 'SATS'],
        ['shipping_option', `30406:${SELLER}:uk`],
      ]),
      listing('hat', [
        ['price', '200', 'SATS'],
        ['shipping_option', `30406:${SELLER}:other`],
      ]),
    ],
    zones: [zone('uk', 50, 'SATS')],
    rates: {},
  });
  expect(quote.totalSats).toBeNull();
  expect(quote.shipping?.notOffered).toBe(true);
});
