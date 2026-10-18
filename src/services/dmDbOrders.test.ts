// Execute the real DAL SQL against SQLite, including JSON extraction and limits.
import { bech32 } from 'bech32';
import { buyerOrderEntries, groupRowsByConversation } from '../utils/orderThreads';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import { DatabaseSync } from 'node:sqlite';
import { getOrderRows, getShopOrderRows, hasIncomingOrder } from './dmDb';
import { admitOrderLifecycle } from '../contexts/orderRumorIngest';
import { parseOrderEvent, serializeOrder } from '../utils/orderEvents';

let mockDb: DatabaseSync;
jest.mock('./localDb', () => ({
  getLocalDb: async () => ({
    execute: async (sql: string, params: (string | number)[]) => ({
      rows: mockDb.prepare(sql).all(...params),
    }),
  }),
}));

beforeEach(() => {
  mockDb = new DatabaseSync(':memory:');
  mockDb.exec(`CREATE TABLE dm_messages (
    owner TEXT, event_id TEXT, conversation TEXT, created_at INTEGER,
    sender TEXT, content TEXT, from_me INTEGER, wire_kind INTEGER
  );`);
});
afterEach(() => mockDb.close());

function insert(
  id: string,
  orderId: string,
  type: string,
  at: number,
  seller = 'seller',
  owner = 'buyer',
  fromMe = type === '1',
) {
  const content = serializeOrder(
    parseOrderEvent({
      kind: 16,
      content: '',
      tags: [
        ['type', type],
        ['order', orderId],
      ],
    })!,
  );
  mockDb
    .prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)')
    .run(owner, id, seller, at, fromMe ? owner : seller, content, fromMe ? 1 : 0);
}

it('bounds buyer lifecycle history after 600 newer updates', async () => {
  insert('original', 'purchase', '1', 1);
  insert('second', 'other-purchase', '1', 2);
  insert('invoice', 'purchase', '2', 3);
  for (let i = 0; i < 600; i++) insert(`status-${i}`, 'purchase', '3', 10 + i);
  insert('unsolicited', 'unknown', '2', 1000);
  insert('impostor', 'purchase', '2', 1001, 'stranger');
  insert('other-account', 'purchase', '1', 1002, 'seller', 'other-buyer');
  mockDb
    .prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)')
    .run('buyer', 'bad-json', 'seller', 1003, 'buyer', '{broken', 1);
  const rows = await getOrderRows('buyer');
  expect(rows).toHaveLength(4);
  expect(rows.map((row) => row.eventId)).toEqual(
    expect.arrayContaining(['original', 'second', 'invoice']),
  );
  expect(rows[0].eventId).toBe('status-599');
  expect(rows.map((row) => row.eventId)).not.toEqual(expect.arrayContaining(['unsolicited']));
});

it('limits by newest placed orders, including older invoices only for selected orders', async () => {
  insert('old', 'old-order', '1', 1);
  insert('new', 'new-order', '1', 2);
  insert('new-invoice', 'new-order', '2', 3);
  insert('old-invoice', 'old-order', '2', 4);
  expect((await getOrderRows('buyer', 1)).map((row) => row.eventId)).toEqual([
    'new-invoice',
    'new',
  ]);
});

it('bounds seller lifecycle bursts while retaining each kind and placed orders', async () => {
  insert('incoming', 'purchase', '1', 1, 'buyer', 'seller', false);
  insert('second-incoming', 'second-purchase', '1', 2, 'buyer', 'seller', false);
  insert('invoice', 'purchase', '2', 3, 'buyer', 'seller', true);
  for (let i = 0; i < 600; i++)
    insert(`status-${i}`, 'purchase', '3', 10 + i, 'buyer', 'seller', true);
  insert('shipping', 'purchase', '4', 700, 'buyer', 'seller', true);
  const receipt = serializeOrder({
    kind: 17,
    type: 'receipt',
    orderId: 'purchase',
    message: '',
    items: [],
  });
  mockDb
    .prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 17)')
    .run('seller', 'receipt', 'buyer', 701, 'buyer', receipt, 0);
  insert('unsolicited', 'unknown', '2', 1000, 'buyer', 'seller', true);
  insert('other-buyer', 'purchase', '2', 1001, 'stranger', 'seller', false);
  insert('other-account', 'purchase', '1', 1002, 'buyer', 'other-seller', false);
  insert('outgoing-purchase', 'my-purchase', '1', 1003, 'merchant', 'seller', true);
  mockDb
    .prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)')
    .run('seller', 'bad-json', 'buyer', 1004, 'buyer', '{broken', 0);
  const rows = await getShopOrderRows('seller');
  expect(rows).toHaveLength(6);
  expect(rows.map((row) => row.eventId)).toEqual(
    expect.arrayContaining(['incoming', 'second-incoming', 'invoice', 'shipping', 'receipt']),
  );
  expect(rows[0].eventId).toBe('receipt');
});

it('limits seller history by incoming orders and isolates identical ids across buyers', async () => {
  insert('old', 'same-id', '1', 1, 'older-buyer', 'seller', false);
  insert('new', 'same-id', '1', 2, 'newer-buyer', 'seller', false);
  insert('new-invoice', 'same-id', '2', 3, 'newer-buyer', 'seller', true);
  insert('old-invoice', 'same-id', '2', 4, 'older-buyer', 'seller', true);
  expect((await getShopOrderRows('seller', 1)).map((row) => row.eventId)).toEqual([
    'new-invoice',
    'new',
  ]);
});

it.each(['receipt', 'cancelled'])(
  'admits seller %s from incoming account history without any invoice record',
  async (type) => {
    // The same id under another account/buyer or in an outgoing row is insufficient.
    insert('other-account', 'sale', '1', 1, 'buyer', 'other-seller', false);
    insert('other-buyer', 'sale', '1', 2, 'stranger', 'seller', false);
    insert('outgoing', 'sale', '1', 3, 'merchant', 'seller', true);
    insert('not-placed', 'sale', '3', 4, 'buyer', 'seller', false);
    mockDb
      .prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)')
      .run('seller', 'invalid', 'buyer', 5, 'buyer', '{broken', 0);
    const rumor = {
      kind: type === 'receipt' ? 17 : 16,
      content: '',
      tags: [
        ['order', 'sale'],
        ...(type === 'receipt'
          ? [['subject', 'order-receipt']]
          : [
              ['type', '3'],
              ['status', 'cancelled'],
            ]),
      ],
    };
    expect(await hasIncomingOrder('seller', 'buyer', 'sale')).toBe(false);
    expect(await admitOrderLifecycle('seller', 'buyer', false, rumor)).toBe(false);
    insert('incoming', 'sale', '1', 6, 'buyer', 'seller', false);
    expect(await admitOrderLifecycle('seller', 'buyer', false, rumor)).toBe(true);
    expect(await hasIncomingOrder('seller', 'buyer', 'different')).toBe(false);
  },
);

it('retains cancellation even when later status updates arrive', async () => {
  insert('incoming', 'purchase', '1', 1, 'buyer', 'seller', false);
  const cancelled = serializeOrder({
    kind: 16,
    type: 'status',
    orderId: 'purchase',
    message: '',
    items: [],
    status: 'cancelled',
  });
  mockDb
    .prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)')
    .run('seller', 'cancelled', 'buyer', 2, 'buyer', cancelled, 0);
  insert('later-status', 'purchase', '3', 3, 'buyer', 'seller', false);
  expect((await getShopOrderRows('seller')).map((row) => row.eventId)).toEqual([
    'later-status',
    'cancelled',
    'incoming',
  ]);
});

it('retains the earliest placed goods when a buyer resends a paid order id', async () => {
  const put = (id: string, at: number, amountSats: number, quantity: number, address: string) => {
    mockDb.prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)').run(
      'seller',
      id,
      'buyer',
      at,
      'buyer',
      serializeOrder({
        kind: 16,
        type: 'order',
        orderId: 'purchase',
        message: address,
        amountSats,
        items: [{ ref: '30402:seller:goods', quantity }],
      }),
      0,
    );
  };
  put('original', 1, 21, 1, 'Original address');
  insert('invoice', 'purchase', '2', 2, 'buyer', 'seller', true);
  insert('confirmed', 'purchase', '3', 3, 'buyer', 'seller', true);
  put('resend', 4, 210, 10, 'Changed address');
  const rows = await getShopOrderRows('seller');
  expect(rows.map((row) => row.eventId)).toEqual(['confirmed', 'invoice', 'original']);
  expect(JSON.parse(rows[2].content)).toMatchObject({
    amountSats: 21,
    items: [{ quantity: 1 }],
    message: 'Original address',
  });
});

it('returns bounded lifecycle rows with a one-purchase limit after 1,000 merchant updates', async () => {
  insert('placed', 'purchase', '1', 1);
  for (let n = 0; n < 1000; n++) insert(`update-${n}`, 'purchase', '3', 10 + n);
  insert('invoice', 'purchase', '2', 1010);
  insert('shipping', 'purchase', '4', 1011);
  const rows = await getOrderRows('buyer', 1);
  expect(rows.map((row) => row.eventId)).toEqual(['shipping', 'invoice', 'update-999', 'placed']);
});

it('keeps payment correlation for superseded invoices within the selected buyer orders', async () => {
  const now = Math.floor(Date.now() / 1000);
  const words = (value: number, length: number) =>
    Array.from({ length }, (_, i) => Math.floor(value / 32 ** (length - i - 1)) % 32);
  const invoice = (seed: number, timestamp: number) =>
    bech32.encode(
      'lnbc21u',
      [
        ...words(timestamp, 7),
        1,
        1,
        20,
        ...bech32.toWords(Buffer.alloc(32, seed)),
        ...Array(104).fill(0),
      ],
      2000,
    );
  const original = invoice(1, now - 7200);
  const replacement = invoice(2, now);
  insert('older-purchase', 'old', '1', 1);
  insert('placed', 'purchase', '1', 2);
  mockDb.exec(
    "UPDATE dm_messages SET content = json_set(content, '$.amountSats', 2100) WHERE event_id = 'placed'",
  );
  const put = (id: string, value: string, at: number, orderId = 'purchase') => {
    mockDb.prepare('INSERT INTO dm_messages VALUES (?, ?, ?, ?, ?, ?, ?, 16)').run(
      'buyer',
      id,
      'seller',
      at,
      'seller',
      serializeOrder({
        kind: 16,
        type: 'payment',
        orderId,
        items: [],
        message: '',
        amountSats: 2100,
        payment: { method: 'lightning', value },
      }),
      0,
    );
  };
  put('old-invoice', original, 3);
  put('replacement', replacement, 4);
  for (let i = 0; i < 1000; i++) put(`replay-${i}`, replacement, 5 + i);
  put('excluded-order-invoice', invoice(3, now), 2000, 'old');
  const rows = await getOrderRows('buyer', 1);
  expect(rows.map((r) => r.eventId)).toEqual(['replay-999', 'old-invoice', 'placed']);
  const conversations = groupRowsByConversation(
    rows.map((r) => ({
      id: r.eventId,
      conversation: r.conversation,
      fromMe: r.fromMe,
      text: r.content,
      wireKind: r.wireKind,
      createdAt: r.createdAt,
    })),
  );
  expect(buyerOrderEntries(conversations)[0].status).toBe('payNow');
  const paidHash = paymentHashFromBolt11(original);
  const [paid] = buyerOrderEntries(
    conversations,
    (bolt11) => paymentHashFromBolt11(bolt11) === paidHash,
  );
  expect(paid.status).toBe('paid');
  expect(paid.paymentRequest).toBeUndefined();
});
