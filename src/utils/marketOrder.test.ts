import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent, unwrapEvent } from 'nostr-tools/nip59';
import {
  buildMarketOrder,
  orderTotalSats,
  productCoordinate,
  newOrderId,
  shortOrderId,
  PRODUCT_COORD_KIND,
  ORDER_MESSAGE_TYPE,
  MAX_ORDER_ADDRESS_LENGTH,
  normalizeOrderAddress,
  type MarketOrderLine,
} from './marketOrder';
import { parseOrderEvent } from './orderEvents';

const BUYER = 'a'.repeat(64);
const VENDOR = 'b'.repeat(64);

const line = (over: Partial<MarketOrderLine> = {}): MarketOrderLine => ({
  merchantPubkey: VENDOR,
  dTag: 'lightning-piggy',
  quantity: 1,
  priceSats: 100_000,
  ...over,
});

describe('productCoordinate', () => {
  it('builds a bare 30402 coordinate (no a: prefix — that is only for review a-tags)', () => {
    expect(productCoordinate(VENDOR, 'widget')).toBe(`${PRODUCT_COORD_KIND}:${VENDOR}:widget`);
    expect(productCoordinate(VENDOR, 'widget').startsWith('a:')).toBe(false);
  });
});

describe('orderTotalSats', () => {
  it('sums quantity × unit price across lines', () => {
    expect(orderTotalSats([line({ quantity: 3, priceSats: 100 })])).toBe(300);
    expect(
      orderTotalSats([line({ quantity: 2, priceSats: 100 }), line({ quantity: 1, priceSats: 50 })]),
    ).toBe(250);
  });

  it('clamps a non-positive / fractional quantity to 1 and a negative price to 0', () => {
    expect(orderTotalSats([line({ quantity: 0, priceSats: 100 })])).toBe(100);
    expect(orderTotalSats([line({ quantity: 2.9, priceSats: 100 })])).toBe(200);
    expect(orderTotalSats([line({ quantity: 1, priceSats: -5 })])).toBe(0);
  });

  it('rounds a fractional price to whole sats (parseOrderEvent rejects a decimal amount)', () => {
    expect(orderTotalSats([line({ quantity: 3, priceSats: 100.4 })])).toBe(300);
    expect(orderTotalSats([line({ quantity: 1, priceSats: 99.5 })])).toBe(100);
  });
});

describe('newOrderId', () => {
  it('is a v4 uuid and is unique across calls', () => {
    const id = newOrderId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newOrderId()).not.toBe(id);
  });

  it('shortOrderId strips dashes and takes the first 8 chars', () => {
    expect(shortOrderId('dev0seed-1234-4abc-9def-0123456789ab')).toBe('dev0seed');
  });
});

describe('buildMarketOrder', () => {
  it('builds a kind-16 type-1 order rumor with the expected tags', () => {
    const { rumor, orderId, totalSats } = buildMarketOrder({
      buyerPubkey: BUYER,
      vendorPubkey: VENDOR,
      lines: [line({ quantity: 2, priceSats: 100_000 })],
      createdAt: 1_700_000_000,
    });

    expect(rumor.kind).toBe(16);
    expect(rumor.pubkey).toBe(BUYER);
    expect(rumor.created_at).toBe(1_700_000_000);
    // Amount = quantity × unit price.
    expect(totalSats).toBe(200_000);

    expect(rumor.tags).toContainEqual(['p', VENDOR]);
    expect(rumor.tags).toContainEqual(['type', ORDER_MESSAGE_TYPE.CREATION]);
    expect(rumor.tags).toContainEqual(['order', orderId]);
    expect(rumor.tags).toContainEqual(['amount', '200000']);
    expect(rumor.tags).toContainEqual(['subject', `Order ${shortOrderId(orderId)}`]);
    // Item coordinate = 30402:<vendor>:<dTag> with the quantity.
    expect(rumor.tags).toContainEqual([
      'item',
      `${PRODUCT_COORD_KIND}:${VENDOR}:lightning-piggy`,
      '2',
    ]);
  });

  it('threads the chosen shipping option: tag, all-in amount, itemised content (#948)', () => {
    const shippingCoord = `30406:${VENDOR}:royal-mail-48`;
    const { rumor, totalSats } = buildMarketOrder({
      buyerPubkey: BUYER,
      vendorPubkey: VENDOR,
      lines: [line({ quantity: 2, priceSats: 100_000 })],
      createdAt: 1_700_000_000,
      note: 'Ring the bell',
      shipping: { coordinate: shippingCoord, costSats: 7_500, title: 'Royal Mail Tracked 48' },
    });

    // Amount is the ALL-IN total (subtotal + shipping) per Gamma.
    expect(totalSats).toBe(207_500);
    expect(rumor.tags).toContainEqual(['amount', '207500']);
    expect(rumor.tags).toContainEqual(['shipping', shippingCoord]);
    // The human-readable summary itemises shipping AND keeps the note.
    expect(rumor.content).toContain('Ring the bell');
    expect(rumor.content).toContain('Subtotal: 200,000 sats');
    expect(rumor.content).toContain('Shipping (Royal Mail Tracked 48): 7,500 sats');
    expect(rumor.content).toContain('Total: 207,500 sats');
    // parseOrderEvent reads the shipping coordinate straight back.
    expect(parseOrderEvent(rumor)?.shipping).toBe(shippingCoord);
  });

  it('adds the Gamma address tag for a physical order, normalised, after shipping', () => {
    const { rumor } = buildMarketOrder({
      buyerPubkey: BUYER,
      vendorPubkey: VENDOR,
      lines: [{ merchantPubkey: VENDOR, dTag: 'mug', quantity: 2, priceSats: 100 }],
      orderId: 'order-addr',
      createdAt: 1,
      shipping: { coordinate: `30406:${VENDOR}:uk`, costSats: 50, title: 'Royal Mail' },
      address: '  Jane Doe \n\n 1 High St\r\n London  ',
    });
    expect(rumor.tags).toEqual([
      ['p', VENDOR],
      ['subject', 'Order orderadd'],
      ['type', '1'],
      ['order', 'order-addr'],
      ['amount', '250'],
      ['item', `30402:${VENDOR}:mug`, '2'],
      ['shipping', `30406:${VENDOR}:uk`],
      ['address', 'Jane Doe\n1 High St\nLondon'],
    ]);
  });

  it('omits a blank address and caps a long one', () => {
    const base = {
      buyerPubkey: BUYER,
      vendorPubkey: VENDOR,
      lines: [{ merchantPubkey: VENDOR, dTag: 'mug', quantity: 1, priceSats: 1 }],
    };
    expect(
      buildMarketOrder({ ...base, address: ' \n ' }).rumor.tags.some((t) => t[0] === 'address'),
    ).toBe(false);
    expect(normalizeOrderAddress('x'.repeat(2000))).toHaveLength(MAX_ORDER_ADDRESS_LENGTH);
  });

  it('emits no shipping tag and an unchanged amount without a shipping input', () => {
    const { rumor, totalSats } = buildMarketOrder({
      buyerPubkey: BUYER,
      vendorPubkey: VENDOR,
      lines: [line({ quantity: 1, priceSats: 50_000 })],
    });
    expect(totalSats).toBe(50_000);
    expect(rumor.tags.some((t) => t[0] === 'shipping')).toBe(false);
    expect(rumor.content).toBe('');
  });

  it('gift-wraps the order to the VENDOR pubkey (no plaintext leak) and honours the note', () => {
    const buyerSk = generateSecretKey();
    const buyerPk = getPublicKey(buyerSk);
    const vendorSk = generateSecretKey();
    const vendorPk = getPublicKey(vendorSk);

    const { rumor, orderId } = buildMarketOrder({
      buyerPubkey: buyerPk,
      vendorPubkey: vendorPk,
      lines: [line({ merchantPubkey: vendorPk, dTag: 'lightning-piggy', quantity: 1 })],
      note: 'Please ship to the moon',
    });

    const wrap = wrapEvent(rumor, buyerSk, vendorPk);
    // The gift wrap is a kind-1059 addressed only to the vendor; the order id /
    // note ride inside the NIP-44 seal, never in the wrap's plaintext.
    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toEqual([['p', vendorPk]]);
    expect(wrap.content).not.toContain(orderId);
    expect(wrap.content).not.toContain('ship to the moon');

    // The vendor (and LP's own ingest) unwraps and parses it straight back.
    const inner = unwrapEvent(wrap, vendorSk);
    expect(inner.pubkey).toBe(buyerPk); // authenticated sender
    const parsed = parseOrderEvent(inner);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe('order');
    expect(parsed?.orderId).toBe(orderId);
    expect(parsed?.items).toEqual([
      { ref: `${PRODUCT_COORD_KIND}:${vendorPk}:lightning-piggy`, quantity: 1 },
    ]);
    expect(parsed?.message).toBe('Please ship to the moon');
  });

  it('round-trips through a signed event id (nostr-tools accepts the rumor shape)', () => {
    const sk = generateSecretKey();
    const { rumor } = buildMarketOrder({
      buyerPubkey: getPublicKey(sk),
      vendorPubkey: VENDOR,
      lines: [line()],
    });
    // finalizeEvent computes id + sig over exactly kind/created_at/tags/content —
    // if the rumor shape were malformed this throws.
    const signed = finalizeEvent(rumor, sk);
    expect(signed.kind).toBe(16);
    expect(signed.id).toMatch(/^[0-9a-f]{64}$/);
  });
});
