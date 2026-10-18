// Exercise the real admission queries and persistence SQL, not mocked order history.
import { DatabaseSync } from 'node:sqlite';
import { bech32 } from 'bech32';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { ingestInboxWraps } from './dmWrapIngest';
import { getOrderRows, getShopOrderRows, upsertDmMessages } from '../services/dmDb';
import { parseOrderEvent, serializeOrder } from '../utils/orderEvents';
import { buyerOrderEntries, groupRowsByConversation } from '../utils/orderThreads';
import type { DecodedRumor } from '../utils/nip17Unwrap';

let mockDb: DatabaseSync;
jest.mock('../services/localDb', () => ({
  getLocalDb: async () => {
    const db = {
      execute: async (sql: string, params: (string | number | null)[] = []) => ({
        rows: mockDb.prepare(sql).all(...params),
      }),
    };
    return { ...db, transaction: async (fn: (tx: typeof db) => Promise<void>) => fn(db) };
  },
}));
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
}));
jest.mock('./nostrEventBus', () => ({ notifyDmMessage: jest.fn() }));
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: jest.fn().mockResolvedValue({ kind: 'not-group' }),
}));
jest.mock('../services/marmotWelcomeRouter', () => ({
  routeMarmotWelcome: jest.fn().mockResolvedValue(false),
}));
jest.mock('./nostrDecryptPacing', () => ({
  NIP17_LOOP_YIELD_EVERY: 8,
  createYieldScheduler: () => ({ maybeYield: async () => {}, yieldCount: 0, dispose: () => {} }),
}));

const BUYER = 'a'.repeat(64);
const SELLER = 'b'.repeat(64);
const NOW = 1_800_000_000;
const EXPIRY = NOW + 3600;
const words = (value: number, length: number) =>
  Array.from({ length }, (_, i) => Math.floor(value / 32 ** (length - i - 1)) % 32);
// Real BOLT11 encoding: 21 sats, one-hour default expiry.
const INVOICE = bech32.encode(
  'lnbc210n',
  [...words(NOW, 7), 1, 1, 20, ...bech32.toWords(Buffer.alloc(32, 1)), ...Array(104).fill(0)],
  2000,
);
const payment = (seller = SELLER, orderId = 'purchase'): DecodedRumor => ({
  pubkey: seller,
  kind: 16,
  created_at: NOW,
  content: '',
  tags: [
    ['p', BUYER],
    ['type', '2'],
    ['order', orderId],
    ['amount', '21'],
    ['payment', 'lightning', INVOICE],
  ],
});

beforeEach(async () => {
  jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
  await AsyncStorage.clear();
  mockDb = new DatabaseSync(':memory:');
  mockDb.exec(`CREATE TABLE dm_messages (
    owner TEXT, event_id TEXT, conversation TEXT, created_at INTEGER,
    sender TEXT, content TEXT, from_me INTEGER, wire_kind INTEGER,
    delivery_status TEXT, rumor_id TEXT, protocol TEXT, reply_to TEXT,
    edited_at INTEGER, edit_id TEXT, PRIMARY KEY (owner, event_id)
  );`);
  await upsertDmMessages([
    {
      owner: BUYER,
      eventId: 'placed',
      conversation: SELLER,
      sender: BUYER,
      fromMe: true,
      wireKind: 16,
      createdAt: NOW - 100,
      content: serializeOrder(
        parseOrderEvent({
          kind: 16,
          content: '',
          tags: [
            ['type', '1'],
            ['order', 'purchase'],
            ['amount', '21'],
          ],
        })!,
      ),
    },
  ]);
});
afterEach(() => {
  mockDb.close();
  jest.restoreAllMocks();
});

async function entries(nowMs = NOW * 1000) {
  const rows = await getOrderRows(BUYER);
  return buyerOrderEntries(
    groupRowsByConversation(rows.map((r) => ({ ...r, text: r.content, id: r.eventId }))),
    () => false,
    nowMs,
  );
}

async function ingest(mode: string, rumor: DecodedRumor, id: string) {
  if (mode === 'cold') {
    await ingestInboxWraps({
      owner: BUYER,
      wraps: [{ id }],
      unwrap: () => rumor,
      passesFollowGate: () => false,
      isColdStart: true,
    });
  } else {
    const writes: Promise<void>[] = [];
    const surface = createLiveRumorSurfacer({
      viewerPubkey: BUYER,
      isCancelled: () => false,
      shouldAbort: () => false,
      isFollowHydrated: () => true,
      followPubkeysRef: { current: new Set() },
      followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
      isFreshArrival: () => false,
      queueInboxEntry: jest.fn(),
      knownWrapIds: new Set(),
      chainWrite: (task) => writes.push(task()),
    });
    await surface(rumor, id);
    await Promise.all(writes);
  }
}

it.each(['live', 'cold'])(
  '%s ingest changes a placed order to Pay now, retaining the request after expiry',
  async (mode) => {
    expect((await entries())[0].status).toBe('awaitingInvoice');
    await ingest(mode, payment(), 'invoice');
    expect(await entries()).toEqual([
      expect.objectContaining({
        orderId: 'purchase',
        sellerPubkey: SELLER,
        status: 'payNow',
        jumpToRowId: 'invoice',
        paymentRequest: expect.objectContaining({ type: 'payment' }),
      }),
    ]);
    expect((await entries(EXPIRY * 1000 - 1))[0].status).toBe('payNow');
    // Expiry is independent of admission: the valid request stays stored.
    expect((await entries(EXPIRY * 1000))[0].status).toBe('invoiceExpired');
    expect((await getOrderRows(BUYER)).map((r) => r.eventId)).toContain('invoice');
  },
);

it.each(['live', 'cold'])(
  '%s ingest rejects a different seller and an unknown order id',
  async (mode) => {
    await ingest(mode, payment('c'.repeat(64)), 'impostor');
    await ingest(mode, payment(SELLER, 'unknown'), 'unknown');
    expect((await getOrderRows(BUYER)).map((r) => r.eventId)).toEqual(['placed']);
    expect((await entries())[0].status).toBe('awaitingInvoice');
  },
);

it.each([false, true])(
  'cold history admits same-batch payment (update first: %s)',
  async (updateFirst) => {
    mockDb.exec('DELETE FROM dm_messages');
    const placed: DecodedRumor = {
      ...payment(BUYER),
      created_at: NOW - 100,
      tags: [
        ['p', SELLER],
        ['type', '1'],
        ['order', 'purchase'],
        ['amount', '21'],
      ],
    };
    const batch = [
      { id: 'placed', rumor: placed },
      { id: 'invoice', rumor: payment() },
    ];
    if (updateFirst) batch.reverse();
    await ingestInboxWraps({
      owner: BUYER,
      wraps: batch,
      unwrap: (wrap) => wrap.rumor,
      passesFollowGate: () => false,
      isColdStart: true,
    });
    expect((await entries())[0].status).toBe('payNow');
  },
);

it.each([false, true])(
  'cold history admits buyer cancellation (update first: %s)',
  async (updateFirst) => {
    const placed: DecodedRumor = {
      ...payment(BUYER),
      tags: [
        ['p', SELLER],
        ['type', '1'],
        ['order', 'purchase'],
      ],
    };
    const cancelled: DecodedRumor = {
      ...placed,
      created_at: NOW + 1,
      tags: [
        ['p', SELLER],
        ['type', '3'],
        ['order', 'purchase'],
        ['status', 'cancelled'],
      ],
    };
    const batch = [
      { id: 'incoming', rumor: placed },
      { id: 'cancelled', rumor: cancelled },
    ];
    if (updateFirst) batch.reverse();
    const result = await ingestInboxWraps({
      owner: SELLER,
      wraps: batch,
      unwrap: (wrap) => wrap.rumor,
      passesFollowGate: () => false,
      isColdStart: true,
    });
    expect(result.stored).toBe(2);
    expect((await getShopOrderRows(SELLER)).map((row) => row.eventId)).toEqual([
      'cancelled',
      'incoming',
    ]);
  },
);

it('does not let same-batch history authorize another seller or an unknown order', async () => {
  mockDb.exec('DELETE FROM dm_messages');
  const placed: DecodedRumor = {
    ...payment(BUYER),
    tags: [
      ['p', SELLER],
      ['type', '1'],
      ['order', 'purchase'],
      ['amount', '21'],
    ],
  };
  const batch = [
    { id: 'placed', rumor: placed },
    { id: 'impostor', rumor: payment('c'.repeat(64)) },
    { id: 'unknown', rumor: payment(SELLER, 'unknown') },
  ];
  const unwrap = jest.fn((wrap: (typeof batch)[number]) => wrap.rumor);
  await ingestInboxWraps({
    owner: BUYER,
    wraps: batch,
    unwrap,
    passesFollowGate: () => false,
    isColdStart: true,
  });
  expect(unwrap).toHaveBeenCalledTimes(3);
  expect((await getOrderRows(BUYER)).map((row) => row.eventId)).toEqual(['placed']);
});
