import {
  parseOrderEvent,
  isOrderEvent,
  serializeOrder,
  parseStoredOrder,
  orderPreviewText,
  orderPreviewFromContent,
  orderCardHeader,
  shortOrderId,
  payableBolt11,
  bolt11FromText,
  type OrderEventInput,
  type ParsedOrderEvent,
} from './orderEvents';

// Realistic Gamma/Plebeian-market events, verified live on relays.
const orderPlaced: OrderEventInput = {
  kind: 16,
  content: 'Order created',
  tags: [
    ['p', 'a'.repeat(64)],
    ['subject', 'order-info'],
    ['type', '1'],
    ['order', 'c6c790ca-1234-4abc-9def-0123456789ab'],
    ['amount', '21'],
    ['item', '30402:' + 'b'.repeat(64) + ':widget', '2'],
    ['shipping', '30406:' + 'b'.repeat(64) + ':ship-uk'],
  ],
};

const paymentRequest: OrderEventInput = {
  kind: 16,
  content: 'Please pay this invoice...',
  tags: [
    ['p', 'a'.repeat(64)],
    ['type', '2'],
    ['order', 'c6c790ca-1234-4abc-9def-0123456789ab'],
    ['amount', '21'],
    ['payment', 'lightning', 'lnbc210n1pexample'],
  ],
};

const statusUpdate: OrderEventInput = {
  kind: 16,
  content: 'Order status updated to confirmed',
  tags: [
    ['type', '3'],
    ['order', 'c6c790ca'],
    ['status', 'confirmed'],
  ],
};

const shippingUpdate: OrderEventInput = {
  kind: 16,
  content: 'Shipped',
  tags: [
    ['type', '4'],
    ['order', 'c6c790ca'],
    ['status', 'shipped'],
    ['tracking', 'TRACK123'],
  ],
};

const receipt: OrderEventInput = {
  kind: 17,
  content: 'Seller payment for 1 items',
  tags: [
    ['subject', 'order-receipt'],
    ['order', 'c6c790ca'],
    ['payment', 'lightning', 'lnbc210n1pexample', 'preimage_deadbeef'],
    ['amount', '21'],
  ],
};

// NIP-18 generic repost — same kind 16, must be rejected.
const repostAlt: OrderEventInput = {
  kind: 16,
  content: '{"id":"...","kind":1,"content":"hi"}',
  tags: [
    ['p', 'a'.repeat(64)],
    ['e', 'c'.repeat(64)],
    ['alt', 'Generic repost'],
  ],
};
const repostK: OrderEventInput = {
  kind: 16,
  content: '{}',
  tags: [
    ['e', 'c'.repeat(64)],
    ['k', '1'],
  ],
};

describe('parseOrderEvent', () => {
  it('parses an order-placed (type 1)', () => {
    const o = parseOrderEvent(orderPlaced);
    expect(o).not.toBeNull();
    expect(o!.type).toBe('order');
    expect(o!.kind).toBe(16);
    expect(o!.orderId).toBe('c6c790ca-1234-4abc-9def-0123456789ab');
    expect(o!.amountSats).toBe(21);
    expect(o!.items).toEqual([{ ref: '30402:' + 'b'.repeat(64) + ':widget', quantity: 2 }]);
    expect(o!.shipping).toBe('30406:' + 'b'.repeat(64) + ':ship-uk');
    expect(o!.message).toBe('Order created');
  });

  it('parses a payment request (type 2) with payment detail', () => {
    const o = parseOrderEvent(paymentRequest)!;
    expect(o.type).toBe('payment');
    expect(o.payment).toEqual({ method: 'lightning', value: 'lnbc210n1pexample' });
  });

  it('parses a status update (type 3)', () => {
    const o = parseOrderEvent(statusUpdate)!;
    expect(o.type).toBe('status');
    expect(o.status).toBe('confirmed');
  });

  it('parses a shipping update (type 4) with tracking', () => {
    const o = parseOrderEvent(shippingUpdate)!;
    expect(o.type).toBe('shipping');
    expect(o.status).toBe('shipped');
    expect(o.tracking).toBe('TRACK123');
  });

  it('parses a kind-17 receipt with payment preimage', () => {
    const o = parseOrderEvent(receipt)!;
    expect(o.type).toBe('receipt');
    expect(o.kind).toBe(17);
    expect(o.payment).toEqual({
      method: 'lightning',
      value: 'lnbc210n1pexample',
      preimage: 'preimage_deadbeef',
    });
    expect(o.amountSats).toBe(21);
  });

  it('rejects a NIP-18 repost advertised via an alt tag', () => {
    expect(parseOrderEvent(repostAlt)).toBeNull();
  });

  it('rejects a NIP-18 repost carrying a k (repost-target-kind) tag', () => {
    expect(parseOrderEvent(repostK)).toBeNull();
  });

  it('rejects a kind-16 with no type tag', () => {
    expect(parseOrderEvent({ kind: 16, content: '', tags: [['order', 'x']] })).toBeNull();
  });

  it('rejects a kind-16 order tag missing', () => {
    expect(parseOrderEvent({ kind: 16, content: '', tags: [['type', '1']] })).toBeNull();
  });

  it('rejects an unrelated kind', () => {
    expect(parseOrderEvent({ kind: 1, content: 'note', tags: [] })).toBeNull();
  });

  it('rejects a kind-17 without the order-receipt subject (e.g. a NIP-25 website reaction)', () => {
    expect(parseOrderEvent({ kind: 17, content: '+', tags: [['order', 'c6c790ca']] })).toBeNull();
    expect(
      parseOrderEvent({
        kind: 17,
        content: '',
        tags: [
          ['order', 'c6c790ca'],
          ['subject', 'something-else'],
        ],
      }),
    ).toBeNull();
  });

  it('ignores a non-numeric amount', () => {
    const o = parseOrderEvent({
      kind: 16,
      content: '',
      tags: [
        ['type', '1'],
        ['order', 'x'],
        ['amount', 'free'],
      ],
    })!;
    expect(o.amountSats).toBeUndefined();
  });

  it('defaults item quantity to 1 when omitted', () => {
    const o = parseOrderEvent({
      kind: 16,
      content: '',
      tags: [
        ['type', '1'],
        ['order', 'x'],
        ['item', '30402:pk:a'],
      ],
    })!;
    expect(o.items).toEqual([{ ref: '30402:pk:a', quantity: 1 }]);
  });
});

describe('isOrderEvent', () => {
  it('is true for orders, false for reposts', () => {
    expect(isOrderEvent(orderPlaced)).toBe(true);
    expect(isOrderEvent(receipt)).toBe(true);
    expect(isOrderEvent(repostAlt)).toBe(false);
  });
});

describe('serialize / parseStoredOrder round-trip', () => {
  it('round-trips every variant', () => {
    for (const ev of [orderPlaced, paymentRequest, statusUpdate, shippingUpdate, receipt]) {
      const o = parseOrderEvent(ev)!;
      const restored = parseStoredOrder(serializeOrder(o));
      expect(restored).toEqual(o);
    }
  });

  it('returns null for non-order JSON', () => {
    expect(parseStoredOrder('hello world')).toBeNull();
    expect(parseStoredOrder('{"foo":1}')).toBeNull();
  });

  it('rejects a stored row with an off-schema type', () => {
    expect(parseStoredOrder('{"kind":16,"orderId":"x","type":"bogus"}')).toBeNull();
  });

  it('coerces a missing/invalid item quantity to 1', () => {
    const restored = parseStoredOrder(
      '{"kind":16,"orderId":"x","type":"order","items":[{"ref":"a"},{"ref":"b","quantity":"7"}]}',
    );
    expect(restored!.items).toEqual([
      { ref: 'a', quantity: 1 },
      { ref: 'b', quantity: 1 },
    ]);
  });

  it('rejects non-finite / negative / fractional amountSats', () => {
    // 1e999 parses to Infinity; NaN isn't valid JSON so can't be embedded here.
    for (const bad of ['null', '1e999', '-5', '1.5']) {
      const restored = parseStoredOrder(
        `{"kind":16,"orderId":"x","type":"order","amountSats":${bad}}`,
      );
      expect(restored!.amountSats).toBeUndefined();
    }
    expect(
      parseStoredOrder('{"kind":16,"orderId":"x","type":"order","amountSats":21}')!.amountSats,
    ).toBe(21);
  });

  it('clamps 0 / negative / fractional item quantity to 1', () => {
    const restored = parseStoredOrder(
      '{"kind":16,"orderId":"x","type":"order","items":[{"ref":"a","quantity":0},{"ref":"b","quantity":-3},{"ref":"c","quantity":2.5}]}',
    );
    expect(restored!.items).toEqual([
      { ref: 'a', quantity: 1 },
      { ref: 'b', quantity: 1 },
      { ref: 'c', quantity: 1 },
    ]);
  });

  it('drops an off-schema payment (non-string method/value)', () => {
    expect(
      parseStoredOrder(
        '{"kind":16,"orderId":"x","type":"order","payment":{"method":1,"value":true}}',
      )!.payment,
    ).toBeUndefined();
    expect(
      parseStoredOrder(
        '{"kind":16,"orderId":"x","type":"order","payment":{"method":"lightning","value":"lnbc1"}}',
      )!.payment,
    ).toEqual({ method: 'lightning', value: 'lnbc1' });
  });
});

describe('orderPreviewText', () => {
  it('summarises an order with amount', () => {
    expect(orderPreviewText(parseOrderEvent(orderPlaced)!)).toBe('🛒 Order Placed · 21 sats');
  });
  it('summarises a status update without free text', () => {
    expect(orderPreviewText(parseOrderEvent(statusUpdate)!)).toBe('📋 Order Status Update');
  });
  it('summarises a receipt with amount', () => {
    expect(orderPreviewText(parseOrderEvent(receipt)!)).toBe('🧾 Payment Receipt · 21 sats');
  });
});

describe('orderPreviewFromContent', () => {
  it('derives a preview for a stored order row', () => {
    const stored = serializeOrder(parseOrderEvent(orderPlaced)!);
    expect(orderPreviewFromContent(stored, 16)).toBe('🛒 Order Placed · 21 sats');
  });
  it('passes plain text through for non-order rows', () => {
    expect(orderPreviewFromContent('hello', 14)).toBe('hello');
  });
  it('never leaks raw JSON for an unparseable kind-16/17 row (corrupt / repost payload)', () => {
    // A NIP-18 repost shares kind 16 but isn't an order, so parseStoredOrder rejects it.
    const out = orderPreviewFromContent('{"kind":1,"id":"abc","content":"gm"}', 16);
    expect(out).not.toContain('{');
    expect(out).toBe('🛍️ Marketplace message');
  });
});

describe('helpers', () => {
  it('orderCardHeader maps types to emoji + label', () => {
    expect(orderCardHeader('order')).toEqual({ emoji: '🛒', label: 'Order Placed' });
    expect(orderCardHeader('receipt')).toEqual({ emoji: '🧾', label: 'Payment Receipt' });
  });
  it('shortOrderId strips dashes and truncates', () => {
    expect(shortOrderId('c6c790ca-1234-4abc')).toBe('c6c790ca');
  });
});

describe('payableBolt11', () => {
  // A bech32 data part comfortably over the {50,} floor the parser shares with
  // INVOICE_REGEX (a real bolt11 is far longer). Uses only valid bech32 chars.
  const DATA = '210n1p' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2);
  const BC = `lnbc${DATA}`;

  const base: ParsedOrderEvent = {
    kind: 16,
    type: 'payment',
    orderId: 'c6c790ca',
    items: [],
    message: '',
    payment: { method: 'lightning', value: BC },
  };

  it('returns the bolt11 for a kind-16 type-2 payment request', () => {
    expect(payableBolt11(base)).toBe(BC);
  });

  it('accepts every HRP extractInvoice does (bc / tb / ts / bs, + regtest/signet)', () => {
    for (const v of [
      `lntb${DATA}`,
      `lntbs${DATA}`,
      `lnbcrt${DATA}`,
      `lnts${DATA}`,
      `lnbs${DATA}`,
    ]) {
      expect(payableBolt11({ ...base, payment: { method: 'lightning', value: v } })).toBe(v);
    }
  });

  it('strips an optional lightning: URI prefix (matches extractInvoice)', () => {
    expect(
      payableBolt11({ ...base, payment: { method: 'lightning', value: `lightning:${BC}` } }),
    ).toBe(BC);
  });

  it('trims surrounding whitespace before matching', () => {
    expect(payableBolt11({ ...base, payment: { method: 'lightning', value: `  ${BC}  ` } })).toBe(
      BC,
    );
  });

  it('rejects a too-short bolt11-shaped value (below the {50,} floor)', () => {
    expect(
      payableBolt11({ ...base, payment: { method: 'lightning', value: 'lnbc1xyz' } }),
    ).toBeNull();
  });

  it('rejects a Lightning address (not a bolt11)', () => {
    expect(
      payableBolt11({ ...base, payment: { method: 'lightning', value: 'shop@getalby.com' } }),
    ).toBeNull();
  });

  it('rejects a non-Lightning payment method even when the value looks like a bolt11', () => {
    expect(payableBolt11({ ...base, payment: { method: 'onchain', value: BC } })).toBeNull();
  });

  it('accepts the Lightning method case-insensitively', () => {
    expect(payableBolt11({ ...base, payment: { method: 'Lightning', value: BC } })).toBe(BC);
  });

  it('rejects a kind-17 receipt (already settled)', () => {
    const receipt: ParsedOrderEvent = {
      ...base,
      kind: 17,
      type: 'receipt',
      payment: { method: 'lightning', value: BC, preimage: 'ab'.repeat(32) },
    };
    expect(payableBolt11(receipt)).toBeNull();
  });

  it('rejects non-payment order types (placed / status / shipping)', () => {
    for (const type of ['order', 'status', 'shipping'] as const) {
      expect(payableBolt11({ ...base, type })).toBeNull();
    }
  });

  it('returns null when there is no payment value', () => {
    expect(payableBolt11({ ...base, payment: undefined })).toBeNull();
    expect(payableBolt11({ ...base, payment: { method: 'lightning', value: '' } })).toBeNull();
  });

  it('lowercases the returned invoice so it compares equal to a chat-note copy', () => {
    const upper = BC.toUpperCase();
    expect(payableBolt11({ ...base, payment: { method: 'lightning', value: upper } })).toBe(BC);
  });
});

describe('bolt11FromText', () => {
  // Same over-the-floor bech32 data part used by the payableBolt11 suite.
  const DATA = '210n1p' + 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.repeat(2);
  const BC = `lnbc${DATA}`;

  it('extracts a bolt11 embedded in a human-readable chat-note line', () => {
    expect(bolt11FromText(`Please pay your order: ${BC} — thanks!`)).toBe(BC);
  });

  it('strips a lightning: URI prefix', () => {
    expect(bolt11FromText(`Pay: lightning:${BC}`)).toBe(BC);
  });

  it('lowercases so it compares equal to a payableBolt11 result', () => {
    expect(bolt11FromText(`PAY ${BC.toUpperCase()} NOW`)).toBe(BC);
  });

  it('returns null for text with no invoice and for empty text', () => {
    expect(bolt11FromText('just a normal message, no invoice here')).toBeNull();
    expect(bolt11FromText('')).toBeNull();
  });

  it('ignores a too-short lnbc-shaped token (below the {50,} floor)', () => {
    expect(bolt11FromText('here is lnbc1short for you')).toBeNull();
  });
});

describe('seller-side fields and spec-shaped receipts', () => {
  it('keeps the buyer address / email / phone on a type-1 order and round-trips them', () => {
    const order = parseOrderEvent({
      kind: 16,
      content: '',
      tags: [
        ['type', '1'],
        ['order', 'o-1'],
        ['item', `30402:${'a'.repeat(64)}:mug`, '1'],
        ['address', '  1 High St, London '],
        ['email', 'jane@example.com'],
        ['phone', '+44 1234'],
      ],
    })!;
    expect(order).toMatchObject({
      address: '1 High St, London',
      email: 'jane@example.com',
      phone: '+44 1234',
    });
    expect(parseStoredOrder(serializeOrder(order))).toMatchObject({
      address: '1 High St, London',
      email: 'jane@example.com',
    });
  });

  it('accepts a kind-17 receipt with a payment proof whatever its subject (Robotechy-style)', () => {
    const receipt = parseOrderEvent({
      kind: 17,
      content: '',
      tags: [
        ['subject', 'Payment for order o-1'],
        ['order', 'o-1'],
        ['payment', 'lightning', 'lnbc1invoice', 'preimage'],
      ],
    });
    expect(receipt).toMatchObject({ type: 'receipt', payment: { preimage: 'preimage' } });
  });

  it('still rejects a kind-17 with neither the receipt subject nor a payment proof (NIP-25)', () => {
    expect(
      parseOrderEvent({
        kind: 17,
        content: '+',
        tags: [
          ['order', 'o-1'],
          ['r', 'https://x'],
        ],
      }),
    ).toBeNull();
  });
});

it('caps all order free text on ingest and on reading older stored rows', () => {
  const long = 'x'.repeat(5000);
  const parsed = parseOrderEvent({
    kind: 16,
    content: long,
    tags: [
      ['type', '1'],
      ['order', 'o'],
      ['address', long],
      ['email', long],
      ['phone', long],
      ['contact', long],
      ['notes', long],
    ],
  })!;
  for (const field of ['message', 'address', 'email', 'phone', 'contact', 'notes'] as const)
    expect(parsed[field]).toHaveLength(500);
  const stored = parseStoredOrder(
    JSON.stringify({ ...parsed, message: long, notes: long, contact: long }),
  )!;
  expect(stored.message).toHaveLength(500);
  expect(stored.notes).toHaveLength(500);
  expect(stored.contact).toHaveLength(500);
});
it.each([16, 17])('rejects signed public kind %s even with order tags', (kind) => {
  expect(
    parseOrderEvent({
      kind,
      sig: 'public signature',
      content: '',
      tags: [
        ['type', '1'],
        ['order', 'o'],
        ['subject', 'order-receipt'],
      ],
    }),
  ).toBeNull();
});

it.each(['order', 'payment', 'status', 'shipping', 'receipt'] as const)(
  'keeps %s previews free of delivery details and all free text',
  (type) => {
    const order = {
      ...parseOrderEvent(orderPlaced)!,
      type,
      address: 'private address',
      email: 'private email',
      phone: 'private phone',
      contact: 'private contact',
      notes: 'private notes',
      message: 'private message',
      status: 'private status',
      tracking: 'private tracking',
    };
    const preview = orderPreviewText(order);
    expect(preview).toBe(`${orderCardHeader(type).emoji} ${orderCardHeader(type).label} · 21 sats`);
    expect(orderPreviewFromContent(serializeOrder(order), 16)).toBe(preview);
  },
);

it('rejects more than 50 item tags, including duplicate refs', () => {
  const tags = Array.from({ length: 51 }, () => ['item', 'product', '1']);
  expect(
    parseOrderEvent({
      ...orderPlaced,
      tags: [...orderPlaced.tags.filter((t) => t[0] !== 'item'), ...tags],
    }),
  ).toBeNull();
  expect(
    parseOrderEvent({
      ...orderPlaced,
      tags: [...orderPlaced.tags.filter((t) => t[0] !== 'item'), ...tags.slice(0, 50)],
    })?.items,
  ).toEqual([{ ref: 'product', quantity: 50 }]);
});
it('merges duplicate item refs and caps individual and summed quantities', () => {
  const tags = [
    ['item', 'one', '600'],
    ['item', 'one', '600'],
    ['item', 'two', '9'.repeat(400)],
  ];
  expect(
    parseOrderEvent({
      ...orderPlaced,
      tags: [...orderPlaced.tags.filter((t) => t[0] !== 'item'), ...tags],
    })?.items,
  ).toEqual([
    { ref: 'one', quantity: 1000 },
    { ref: 'two', quantity: 1000 },
  ]);
});
