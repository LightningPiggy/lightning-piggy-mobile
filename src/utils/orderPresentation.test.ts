import { parseOrderEvent, parseStoredOrder, serializeOrder } from './orderEvents';
import { buildMarketOrder } from './marketOrder';
import {
  buyerOrderNote,
  orderAddressLines,
  distinctOrderItems,
  orderListingPreviews,
  orderProductPreviews,
  orderItemsSummary,
} from './orderPresentation';

describe('buyerOrderNote', () => {
  const input = {
    buyerPubkey: 'buyer',
    vendorPubkey: 'seller',
    orderId: '1234',
    lines: [{ merchantPubkey: 'seller', dTag: 'mug', quantity: 2, priceSats: 2100 }],
    shipping: { coordinate: '30406:seller:post', costSats: 0, title: 'Standard (tracked)' },
  };
  test.each([undefined, '', 'Please leave at the door.\nThanks!'])(
    'extracts note %p from actual checkout content',
    (note) => {
      const content = buildMarketOrder({ ...input, note }).rumor.content;
      expect(buyerOrderNote(content)).toBe(note ?? '');
      expect(buyerOrderNote(content.replace(/\n/g, '\r\n'))).toBe(
        (note ?? '').replace(/\n/g, '\r\n'),
      );
    },
  );
  test.each([450, 475, 490, 500, 550])(
    'strips generated totals before bounding a %i-character note on ingest and stored reads',
    (length) => {
      const note = 'x'.repeat(length);
      const rumor = buildMarketOrder({ ...input, note }).rumor;
      const original = rumor.content;
      const parsed = parseOrderEvent(rumor)!;
      expect(parsed.message).toBe(note.slice(0, 500));
      expect(parseStoredOrder(serializeOrder(parsed))?.message).toBe(note.slice(0, 500));
      expect(parseStoredOrder(serializeOrder({ ...parsed, message: original }))?.message).toBe(
        note.slice(0, 500),
      );
      expect(rumor.content).toBe(original);
      expect(original).toContain('Subtotal: 4,200 sats');
    },
  );
  it('preserves free text and incomplete or non-generated summaries', () => {
    for (const text of [
      'Subtotal: my request',
      'Total: 21 sats',
      'Subtotal: 21 sats\nShipping: Free\nTotal: 21 sats',
      'My note\n\nSubtotal: 21 sats\nShipping (Post): 0 sats\nTotal: 21 sats\n\nBuyer follow-up',
    ]) {
      expect(buyerOrderNote(text)).toBe(text);
    }
    expect(buyerOrderNote('  Just a note  ')).toBe('Just a note');
    expect(buyerOrderNote()).toBe('');
  });
});

it('maps listings by full coordinate and falls back to the listing id', () => {
  const previews = orderListingPreviews([
    {
      pubkey: 'seller',
      tags: [
        ['d', 'mug'],
        ['title', 'Mug'],
        ['image', 'https://example.com/mug.png'],
      ],
    },
    { pubkey: 'other', tags: [['d', 'mug']] },
    { pubkey: 'ignored', tags: [] },
  ]);
  expect(previews.get('30402:seller:mug')).toEqual({
    title: 'Mug',
    image: 'https://example.com/mug.png',
  });
  expect(previews.get('30402:other:mug')?.title).toBe('mug');
  expect(previews.size).toBe(2);
  expect(orderProductPreviews([]).size).toBe(0);
});

it('groups distinct items, totals their badges and retains order and unknown titles', () => {
  const lines = [
    { ref: '30402:seller:mug', title: 'Old title', quantity: 1 },
    { ref: '30402:other:hat', quantity: 2 },
    { ref: '30402:seller:mug', quantity: 3 },
    { ref: '30402:seller:scarf', title: 'Scarf', quantity: 1 },
    { ref: '30402:seller:pin', quantity: 1 },
  ];
  const previews = new Map([
    ['30402:seller:mug', { title: 'Mug', image: 'https://example.com/mug.png' }],
  ]);
  const items = distinctOrderItems(lines, previews);
  expect(items).toEqual([
    { ref: lines[0].ref, title: 'Old title', image: 'https://example.com/mug.png', quantity: 4 },
    { ref: lines[1].ref, title: 'hat', quantity: 2 },
    { ref: lines[3].ref, title: 'Scarf', quantity: 1 },
    { ref: lines[4].ref, title: 'pin', quantity: 1 },
  ]);
  expect(lines[0].quantity).toBe(1);
  expect(distinctOrderItems([])).toEqual([]);
});

it('displays legacy comma-separated addresses on separate lines without breaking structured streets', () => {
  expect(orderAddressLines('Testy McTestface, 1 Nowhere Lane, Faketown, ZZ1 1ZZ, GB')).toEqual([
    'Testy McTestface',
    '1 Nowhere Lane',
    'Faketown',
    'ZZ1 1ZZ',
    'GB',
  ]);
  expect(orderAddressLines('Testy\r\nUnit 2, Business Park\r\n\r\nGB')).toEqual([
    'Testy',
    'Unit 2, Business Park',
    'GB',
  ]);
  expect(orderAddressLines('')).toEqual([]);
});

it('preserves checkout titles for text and images, then catalogue titles, then unknown d-tags', () => {
  const ref = '30402:seller:test-little-piggy-nostr-21sat';
  const lines = [{ ref, quantity: 1 }];
  const catalogue = new Map([
    [ref, { title: 'Little Piggy Nostr Listing', image: 'https://example.com/pig.png' }],
  ]);
  expect(orderItemsSummary(lines, undefined, catalogue)).toBe('Little Piggy Nostr Listing × 1');
  expect(orderItemsSummary(lines, { [ref]: 'Old title' }, catalogue)).toBe('Old title × 1');
  expect(orderItemsSummary(lines, { [ref]: 'Checkout title' })).toBe('Checkout title × 1');
  expect(orderItemsSummary(lines)).toBe('test-little-piggy-nostr-21sat × 1');
});
