import { bech32 } from 'bech32';
import {
  buyerOrderEntries,
  buyerOrderStatus,
  groupRowsByConversation,
  orderThreads,
  payNowCount,
  type OrderRowInput,
} from './orderThreads';
import { serializeOrder, type ParsedOrderEvent } from './orderEvents';

const SELLER = 'b'.repeat(64);
// Use real BOLT11 encoding so amount checks exercise the decoder.
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

beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000));
afterEach(() => jest.restoreAllMocks());

function row(
  fromMe: boolean,
  createdAt: number,
  order: Partial<ParsedOrderEvent> & Pick<ParsedOrderEvent, 'type'>,
  id = `r${createdAt}`,
): OrderRowInput {
  const full: ParsedOrderEvent = {
    kind: order.type === 'receipt' ? 17 : 16,
    orderId: 'o-1',
    items: [],
    message: '',
    ...order,
  };
  return { id, fromMe, createdAt, wireKind: full.kind, text: serializeOrder(full) };
}
const placed = (fromMe: boolean) =>
  row(fromMe, 10, {
    type: 'order',
    amountSats: 2100,
    items: [{ ref: `30402:${SELLER}:mug`, quantity: 2 }],
  });
const invoice = (fromMe: boolean) =>
  row(fromMe, 20, {
    type: 'payment',
    amountSats: 2100,
    payment: { method: 'lightning', value: BOLT11 },
  });

describe('orderThreads — direction-aware', () => {
  it('buyer role keeps orders I placed and reads the seller replies', () => {
    const threads = orderThreads([placed(true), invoice(false)], 'buyer');
    expect([...threads.keys()]).toEqual(['o-1']);
    expect(threads.get('o-1')).toMatchObject({
      role: 'buyer',
      placedAt: 10,
      placedRowId: 'r10',
      invoice: { bolt11: BOLT11, amountSats: 2100, rowId: 'r20' },
    });
  });

  it('seller role keeps orders I received and reads my replies', () => {
    const threads = orderThreads([placed(false), invoice(true)], 'seller');
    expect(threads.get('o-1')?.invoice?.bolt11).toBe(BOLT11);
    // Viewed from the wrong side there is no order.
    expect(orderThreads([placed(false), invoice(true)], 'buyer').size).toBe(0);
  });

  it('ignores a payment request from the buyer side and non-order rows', () => {
    const threads = orderThreads(
      [placed(true), invoice(true), { fromMe: false, text: 'hello', createdAt: 5, wireKind: 14 }],
      'buyer',
    );
    expect(threads.get('o-1')?.invoice).toBeUndefined();
  });

  it('either side can cancel; only the merchant sets status / shipping', () => {
    const threads = orderThreads(
      [
        placed(true),
        row(true, 30, { type: 'status', status: 'confirmed' }), // buyer can't confirm
        row(false, 40, { type: 'shipping', status: 'shipped' }),
      ],
      'buyer',
    );
    expect(threads.get('o-1')?.status).toBeUndefined();
    expect(threads.get('o-1')?.shipping).toBe('shipped');
    const cancelled = orderThreads(
      [placed(true), row(true, 30, { type: 'status', status: 'cancelled' })],
      'buyer',
    );
    expect(cancelled.get('o-1')?.cancelled).toBe(true);
  });
});

describe('buyerOrderStatus', () => {
  const thread = (rows: OrderRowInput[]) => orderThreads(rows, 'buyer').get('o-1')!;

  it('walks Awaiting invoice → Pay now → Paid → Shipped → Completed', () => {
    expect(buyerOrderStatus(thread([placed(true)]))).toBe('awaitingInvoice');
    expect(buyerOrderStatus(thread([placed(true), invoice(false)]))).toBe('payNow');
    expect(buyerOrderStatus(thread([placed(true), invoice(false)]), { invoicePaid: true })).toBe(
      'paid',
    );
    expect(
      buyerOrderStatus(
        thread([
          placed(true),
          invoice(false),
          row(false, 30, { type: 'status', status: 'confirmed' }),
        ]),
      ),
    ).toBe('paid');
    expect(
      buyerOrderStatus(
        thread([
          placed(true),
          invoice(false),
          row(true, 25, { type: 'receipt', payment: { method: 'lightning', value: BOLT11 } }),
        ]),
      ),
    ).toBe('paid');
    expect(
      buyerOrderStatus(
        thread([placed(true), row(false, 40, { type: 'shipping', status: 'shipped' })]),
      ),
    ).toBe('shipped');
    expect(
      buyerOrderStatus(
        thread([placed(true), row(false, 50, { type: 'status', status: 'completed' })]),
      ),
    ).toBe('completed');
  });

  it('cancelled wins', () => {
    expect(
      buyerOrderStatus(
        thread([
          placed(true),
          invoice(false),
          row(false, 30, { type: 'status', status: 'cancelled' }),
        ]),
      ),
    ).toBe('cancelled');
  });
});

describe('buyerOrderEntries', () => {
  it.each([
    ['explicit expiry', bolt11('lnbc21u', NOW - 61, 60)],
    ['default one-hour expiry', bolt11('lnbc21u', NOW - 3600)],
  ])('does not prompt for payment after %s', (_scenario, expiredInvoice) => {
    const rows = [
      placed(true),
      row(false, 20, {
        type: 'payment',
        payment: { method: 'lightning', value: expiredInvoice },
      }),
    ];
    const conversations = new Map([[SELLER, rows]]);
    const entries = buyerOrderEntries(conversations);
    expect(entries[0]).toMatchObject({ status: 'invoiceExpired', jumpToRowId: 'r10' });
    expect(entries[0].paymentRequest).toBeUndefined();
    expect(payNowCount(entries)).toBe(0);
    // Expiry does not undo a settled payment.
    expect(buyerOrderEntries(conversations, () => true)[0].status).toBe('paid');
  });

  it('updates the chip, badge and jump target at the expiry boundary', () => {
    const conversations = new Map([[SELLER, [placed(true), invoice(false)]]]);
    expect(buyerOrderEntries(conversations, undefined, (NOW + 3600) * 1000 - 1)[0].status).toBe(
      'payNow',
    );
    const entries = buyerOrderEntries(conversations, undefined, (NOW + 3600) * 1000);
    expect(entries[0]).toMatchObject({ status: 'invoiceExpired', jumpToRowId: 'r10' });
    expect(payNowCount(entries)).toBe(0);
  });

  it.each([
    ['larger amount', bolt11('lnbc42u'), 2100],
    ['smaller amount', bolt11('lnbc10u'), 2100],
    ['amountless invoice', bolt11('lnbc'), 2100],
    ['malformed invoice', `lnbc21u1${'q'.repeat(60)}`, 2100],
    ['missing approved amount', BOLT11, undefined],
  ])('does not prompt for payment with %s', (_scenario, paymentInvoice, expectedAmount) => {
    const rows = [
      row(true, 10, { type: 'order', amountSats: expectedAmount }),
      row(false, 20, {
        type: 'payment',
        // An untrusted amount tag must not override the decoded invoice amount.
        amountSats: 2100,
        payment: { method: 'lightning', value: paymentInvoice },
      }),
    ];
    expect(orderThreads(rows, 'buyer').get('o-1')?.invoice).toBeUndefined();
    const isInvoicePaid = jest.fn(() => false);
    const entries = buyerOrderEntries(new Map([[SELLER, rows]]), isInvoicePaid);
    expect(entries[0]).toMatchObject({ status: 'awaitingInvoice', jumpToRowId: 'r10' });
    expect(payNowCount(entries)).toBe(0);
    expect(isInvoicePaid).not.toHaveBeenCalled();
  });

  it('lists my orders newest first across sellers, jumping to the invoice when payable', () => {
    const other = 'c'.repeat(64);
    const older = row(true, 5, { type: 'order', orderId: 'o-0', items: [] }, 'old');
    const entries = buyerOrderEntries(
      new Map([
        [SELLER, [placed(true), invoice(false)]],
        [other, [older]],
      ]),
    );
    expect(entries.map((e) => [e.orderId, e.sellerPubkey, e.status, e.jumpToRowId])).toEqual([
      ['o-1', SELLER, 'payNow', 'r20'],
      ['o-0', other, 'awaitingInvoice', 'old'],
    ]);
    expect(payNowCount(entries)).toBe(1);
  });

  it('a paid invoice (wallet history) is no longer Pay now', () => {
    const entries = buyerOrderEntries(
      new Map([[SELLER, [placed(true), invoice(false)]]]),
      (bolt11) => bolt11 === BOLT11,
    );
    expect(entries[0]).toMatchObject({ status: 'paid', jumpToRowId: 'r10' });
  });

  it.each([false, true])('retains earlier settlement across a reissue (paid=%s)', (paid) => {
    const earlierInvoice = bolt11('lnbc21u', NOW - 3600);
    const replacement = row(false, 30, {
      type: 'payment',
      payment: { method: 'lightning', value: BOLT11 },
    });
    const rows = [
      replacement,
      placed(true),
      row(false, 20, {
        type: 'payment',
        payment: { method: 'lightning', value: earlierInvoice },
      }),
      // A later request with the wrong amount must not enter payment history.
      row(false, 40, {
        type: 'payment',
        payment: { method: 'lightning', value: bolt11('lnbc42u') },
      }),
    ];
    const thread = orderThreads(rows, 'buyer').get('o-1')!;
    expect(thread.invoices.map((invoice) => invoice.bolt11)).toEqual([earlierInvoice, BOLT11]);
    expect(thread.invoice?.rowId).toBe('r30');
    const entries = buyerOrderEntries(
      new Map([[SELLER, rows]]),
      (invoice) => paid && invoice === earlierInvoice,
    );
    expect(entries[0]).toMatchObject({
      status: paid ? 'paid' : 'payNow',
      jumpToRowId: paid ? 'r10' : 'r30',
      paymentExpiresAt: paid ? undefined : NOW + 3600,
    });
    expect(payNowCount(entries)).toBe(paid ? 0 : 1);
  });

  it('groups store rows by conversation', () => {
    const rows = [
      { ...placed(true), conversation: SELLER },
      { ...invoice(false), conversation: SELLER },
      { ...placed(true), conversation: 'x' },
    ];
    const grouped = groupRowsByConversation(rows);
    expect(grouped.get(SELLER)).toHaveLength(2);
    expect(grouped.get('x')).toHaveLength(1);
  });
});

it('returns to Pay now when an expired invoice is replaced at the approved amount', () => {
  const expired = row(false, 20, {
    type: 'payment',
    payment: { method: 'lightning', value: bolt11('lnbc21u', NOW - 3600) },
  });
  const replacement = { ...invoice(false), createdAt: 30, id: 'replacement' };
  const entries = buyerOrderEntries(new Map([[SELLER, [placed(true), expired, replacement]]]));
  expect(entries[0]).toMatchObject({
    status: 'payNow',
    jumpToRowId: 'replacement',
    paymentRequest: { payment: { value: BOLT11 } },
  });
  expect(payNowCount(entries)).toBe(1);
  const current = orderThreads([placed(true), replacement], 'buyer').get('o-1')!;
  expect(buyerOrderStatus(current, { nowMs: (NOW + 3600) * 1000 - 1 })).toBe('payNow');
  expect(buyerOrderStatus(current, { nowMs: (NOW + 3600) * 1000 })).toBe('invoiceExpired');
});
