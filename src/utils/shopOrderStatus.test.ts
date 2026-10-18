import { bech32 } from 'bech32';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  needsInvoiceCount,
  preimageMatches,
  receiptProvesPayment,
  effectiveSellerInvoice,
  sellerOrderThreads,
  shopOrderEntries,
  shopOrderStatus,
} from './shopOrderStatus';
import { serializeOrder, type ParsedOrderEvent } from './orderEvents';
import type { OrderRowInput } from './orderThreads';

const BUYER = 'b'.repeat(64);
const NOW = 1_800_000_000;
function bolt11(hrp: string, timestamp = NOW, expiry?: number): string {
  const words = (value: number, length: number) =>
    Array.from({ length }, (_, i) => Math.floor(value / 32 ** (length - i - 1)) % 32);
  return bech32.encode(
    hrp,
    [
      ...words(timestamp, 7),
      1,
      1,
      20,
      ...bech32.toWords(Buffer.alloc(32, 1)),
      ...(expiry === undefined ? [] : [6, 0, 3, ...words(expiry, 3)]),
      ...Array(104).fill(0),
    ],
    2000,
  );
}
const BOLT11 = bolt11('lnbc21u');
const PREIMAGE = '11'.repeat(32);
const HASH = bytesToHex(sha256(Uint8Array.from(Array(32).fill(0x11))));

function row(
  fromMe: boolean,
  createdAt: number,
  order: Partial<ParsedOrderEvent> & Pick<ParsedOrderEvent, 'type'>,
): OrderRowInput {
  const full: ParsedOrderEvent = {
    kind: order.type === 'receipt' ? 17 : 16,
    orderId: 'o-1',
    items: [],
    message: '',
    ...order,
  };
  return {
    id: `r${createdAt}`,
    fromMe,
    createdAt,
    wireKind: full.kind,
    text: serializeOrder(full),
  };
}
const received = row(false, 10, { type: 'order', amountSats: 2100 });
const myInvoice = row(true, 20, {
  type: 'payment',
  amountSats: 2100,
  payment: { method: 'lightning', value: BOLT11 },
});
const thread = (rows: OrderRowInput[]) => sellerOrderThreads(rows).get('o-1')!;

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000));
afterEach(() => jest.restoreAllMocks());

describe('shopOrderStatus', () => {
  it('Needs invoice → Invoice sent → Paid → Shipped', () => {
    expect(shopOrderStatus(thread([received]))).toBe('needsInvoice');
    expect(shopOrderStatus(thread([received, myInvoice]))).toBe('invoiceSent');
    expect(shopOrderStatus(thread([received, myInvoice]), { walletPaid: true })).toBe('paid');
    expect(
      shopOrderStatus(
        thread([received, myInvoice, row(true, 30, { type: 'status', status: 'confirmed' })]),
      ),
    ).toBe('paid');
    expect(
      shopOrderStatus(
        thread([received, myInvoice, row(true, 40, { type: 'shipping', status: 'shipped' })]),
      ),
    ).toBe('shipped');
  });

  it('a buyer cancelling wins; a buyer can not mark it paid', () => {
    expect(
      shopOrderStatus(thread([received, row(false, 30, { type: 'status', status: 'cancelled' })])),
    ).toBe('cancelled');
    expect(
      shopOrderStatus(
        thread([received, myInvoice, row(false, 30, { type: 'status', status: 'confirmed' })]),
      ),
    ).toBe('invoiceSent');
  });

  it('counts orders needing an invoice', () => {
    expect(needsInvoiceCount(['needsInvoice', 'paid', 'needsInvoice', 'invoiceSent'])).toBe(2);
  });
});

describe('receipt verification', () => {
  it('a receipt proves payment only with my bolt11 and a matching preimage', () => {
    expect(preimageMatches(PREIMAGE, HASH)).toBe(true);
    expect(preimageMatches('22'.repeat(32), HASH)).toBe(false);
    expect(preimageMatches(undefined, HASH)).toBe(false);
    const good = thread([
      received,
      myInvoice,
      row(false, 30, {
        type: 'receipt',
        payment: { method: 'lightning', value: BOLT11, preimage: PREIMAGE },
      }),
    ]);
    expect(receiptProvesPayment(good, HASH)).toBe(true);
    expect(shopOrderStatus(good, { receiptVerified: receiptProvesPayment(good, HASH) })).toBe(
      'paid',
    );
    const otherInvoice = thread([
      received,
      myInvoice,
      row(false, 30, {
        type: 'receipt',
        payment: { method: 'lightning', value: `lnbc1${'z'.repeat(60)}`, preimage: PREIMAGE },
      }),
    ]);
    expect(receiptProvesPayment(otherInvoice, HASH)).toBe(false);
  });

  it('verifies against the durable invoice when the relay self-copy is missing', () => {
    const receiptOnly = thread([
      received,
      row(false, 30, {
        type: 'receipt',
        payment: { method: 'lightning', value: BOLT11, preimage: PREIMAGE },
      }),
    ]);
    // No relay invoice in the thread: only the persisted record knows the bolt11.
    expect(receiptProvesPayment(receiptOnly, HASH)).toBe(false);
    expect(receiptProvesPayment(receiptOnly, HASH, BOLT11)).toBe(true);
    const record = { bolt11: BOLT11, sentAt: 1, paymentHash: HASH };
    expect(effectiveSellerInvoice(record, receiptOnly.invoice)).toEqual({
      bolt11: BOLT11,
      paymentHash: HASH,
    });
    expect(effectiveSellerInvoice(null, receiptOnly.invoice)).toBeNull();
    // A wrong preimage still fails even with the durable invoice.
    expect(receiptProvesPayment(receiptOnly, 'ab'.repeat(32), BOLT11)).toBe(false);
  });
});

it('shopOrderEntries lists received orders newest first with chips and jump rows', () => {
  const second = row(false, 50, { type: 'order', orderId: 'o-2' });
  const entries = shopOrderEntries(
    new Map([
      [BUYER, [received, myInvoice]],
      ['c'.repeat(64), [second]],
    ]),
    new Set(['o-1']),
  );
  expect(entries.map((e) => [e.orderId, e.status, e.jumpToRowId])).toEqual([
    ['o-2', 'needsInvoice', 'r50'],
    ['o-1', 'paid', 'r10'],
  ]);
});

it('expires at the BOLT11 boundary and returns to invoice sent for a replacement', () => {
  const original = thread([received, myInvoice]);
  const expiryMs = (NOW + 3600) * 1000;
  expect(shopOrderStatus(original, { nowMs: expiryMs - 1 })).toBe('invoiceSent');
  expect(shopOrderStatus(original, { nowMs: expiryMs })).toBe('invoiceExpired');
  expect(shopOrderStatus(original, { nowMs: expiryMs, walletPaid: true })).toBe('paid');
  const replacement = row(true, 30, {
    type: 'payment',
    payment: { method: 'lightning', value: bolt11('lnbc21u', NOW + 3600) },
  });
  expect(shopOrderStatus(thread([received, myInvoice, replacement]), { nowMs: expiryMs })).toBe(
    'invoiceSent',
  );
});

it('uses the durable invoice for a placed-only thread, including expiry and settlement', () => {
  const placedOnly = thread([received]);
  const invoiceRecord = { bolt11: BOLT11, paymentHash: HASH };
  const expiryMs = (NOW + 3600) * 1000;
  expect(shopOrderStatus(placedOnly, { invoiceRecord, nowMs: expiryMs - 1 })).toBe('invoiceSent');
  expect(shopOrderStatus(placedOnly, { invoiceRecord, nowMs: expiryMs })).toBe('invoiceExpired');
  expect(
    shopOrderStatus(placedOnly, {
      invoiceRecord: { ...invoiceRecord, paidAt: expiryMs },
      nowMs: expiryMs,
    }),
  ).toBe('paid');
  expect(
    shopOrderStatus(placedOnly, {
      invoiceRecord: { ...invoiceRecord, bolt11: bolt11('lnbc21u', NOW + 3600) },
      nowMs: expiryMs,
    }),
  ).toBe('invoiceSent');
  expect(
    shopOrderStatus(thread([received, myInvoice]), {
      invoiceRecord: { ...invoiceRecord, bolt11: bolt11('lnbc21u', NOW - 3600) },
    }),
  ).toBe('invoiceSent');
});

it('uses the durable replacement expiry while the expired original remains in relay history', () => {
  const old = bolt11('lnbc21u', NOW - 7200, 3600);
  const current = thread([
    received,
    row(true, 20, { type: 'payment', payment: { method: 'lightning', value: old } }),
  ]);
  expect(shopOrderStatus(current)).toBe('invoiceExpired');
  expect(
    shopOrderStatus(current, {
      invoiceRecord: { bolt11: BOLT11, paymentHash: HASH, sentAt: NOW * 1000, replacesBolt11: old },
    }),
  ).toBe('invoiceSent');
});
