// Order storage is independent of the Messages Only friends filter.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import type { Event } from 'nostr-tools';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { ingestInboxWraps } from './dmWrapIngest';
import {
  getOutgoingOrderRows,
  hasIncomingOrder,
  selectKnownEventIds,
  upsertDmMessages,
} from '../services/dmDb';
import { addSellerEvents, resetSellerStore } from '../services/sellerEventStore';
import { listNotifications } from '../services/notificationHistory';
import { __resetForTests } from '../services/dmWrapNotificationDedupe';
import { serializeOrder, parseOrderEvent } from '../utils/orderEvents';
import { buildDmSummaries } from '../utils/conversationSummaries';
import type { DecodedRumor } from '../utils/nip17Unwrap';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notification'),
  AndroidImportance: { HIGH: 4 },
  AndroidNotificationVisibility: { PRIVATE: 0 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
}));
jest.mock('../services/dmDb', () => ({
  upsertDmMessages: jest.fn().mockResolvedValue(undefined),
  selectKnownEventIds: jest.fn(),
  getOutgoingOrderRows: jest.fn(),
  hasIncomingOrder: jest.fn(),
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
  createYieldScheduler: jest.fn(() => ({
    maybeYield: jest.fn(async () => {}),
    yieldCount: 0,
    dispose: jest.fn(),
  })),
}));
jest.mock('./nostrDmCache', () => ({
  loadNip17SkipSet: jest.fn(async () => new Set<string>()),
  writeNip17SkipSet: jest.fn(async () => {}),
}));

const SELLER = 'a'.repeat(64);
const STRANGER = 'b'.repeat(64);
const OTHER_SELLER = 'c'.repeat(64);

function myListing(d: string, title: string): Event {
  return {
    id: `${d}`.padEnd(64, '0'),
    sig: 'f'.repeat(128),
    kind: 30402,
    pubkey: SELLER,
    created_at: 1,
    content: '',
    tags: [
      ['d', d],
      ['title', title],
      ['price', '2100', 'SATS'],
    ],
  } as Event;
}

function orderRumor(itemRef: string, qty = 2): DecodedRumor {
  return {
    pubkey: STRANGER,
    kind: 16,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['p', SELLER],
      ['subject', 'Order abc'],
      ['type', '1'],
      ['order', 'order-1'],
      ['amount', '4200'],
      ['item', itemRef, String(qty)],
    ],
  } as DecodedRumor;
}

beforeEach(async () => {
  jest.clearAllMocks();
  (hasIncomingOrder as jest.Mock).mockResolvedValue(false);
  (getOutgoingOrderRows as jest.Mock).mockImplementation(async (owner, seller, ids) => [
    {
      owner,
      sender: owner,
      conversation: seller,
      fromMe: true,
      content: serializeOrder(
        parseOrderEvent({
          kind: 16,
          content: '',
          tags: [
            ['type', '1'],
            ['order', ids[0]],
          ],
        })!,
      ),
    },
  ]);
  await AsyncStorage.clear();
  __resetForTests();
  resetSellerStore();
  addSellerEvents(SELLER, [myListing('mug', 'Mug')]);
  (selectKnownEventIds as jest.Mock).mockResolvedValue(new Set());
});

describe('live gift-wrap path', () => {
  function surfacer(followed = false, isCancelled = () => false, includeNonFollowOrders = false) {
    const writes: Promise<void>[] = [];
    const queueInboxEntry = jest.fn();
    const surface = createLiveRumorSurfacer({
      viewerPubkey: SELLER,
      isCancelled,
      shouldAbort: () => false,
      isFollowHydrated: () => true,
      // The buyer is a stranger: not followed.
      followPubkeysRef: { current: new Set(followed ? [STRANGER] : []) },
      followGateBuffer: { defer: jest.fn(), reevaluate: jest.fn(), clear: jest.fn(), size: 0 },
      isFreshArrival: () => true,
      includeNonFollowOrders: () => includeNonFollowOrders,
      queueInboxEntry,
      knownWrapIds: new Set(),
      seen: new Set(),
      chainWrite: (task) => {
        writes.push(task());
      },
    });
    return { surface, writes, queueInboxEntry };
  }

  it("stores a followed buyer's order and routes its notification to the shop", async () => {
    const { surface, writes } = surfacer(true);
    await surface(orderRumor(`30402:${SELLER}:mug`), 'wrap-mine');
    await Promise.all(writes);
    await new Promise((r) => setTimeout(r, 0));
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ owner: SELLER, conversation: STRANGER, wireKind: 16 }),
    ]);
    const history = await listNotifications(SELLER);
    expect(history).toHaveLength(1);
    expect(history[0].title).toBe('Order for your shop');
    expect(history[0].data).toMatchObject({
      shopOrderId: 'order-1',
      shopBuyerPubkey: STRANGER,
      messageId: 'wrap-mine',
    });
    expect(Notifications.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['my own current listing', `30402:${SELLER}:mug`],
    ["another seller's listing", `30402:${OTHER_SELLER}:mug`],
    ['a listing I no longer have', `30402:${SELLER}:gone`],
    ['a malformed ref', 'mug'],
  ])('stores a stranger order naming %s', async (_label, ref) => {
    const { surface, writes } = surfacer();
    await surface(orderRumor(ref), 'wrap-other');
    await Promise.all(writes);
    await new Promise((r) => setTimeout(r, 0));
    expect(upsertDmMessages).toHaveBeenCalledWith([
      expect.objectContaining({ owner: SELLER, conversation: STRANGER, wireKind: 16 }),
    ]);
  });

  it("keeps the gate for a stranger's ordinary chat message", async () => {
    const { surface, writes } = surfacer();
    await surface(
      {
        pubkey: STRANGER,
        kind: 14,
        content: 'hi',
        tags: [['p', SELLER]],
        created_at: 1,
      } as DecodedRumor,
      'wrap-chat',
    );
    await Promise.all(writes);
    expect(upsertDmMessages).not.toHaveBeenCalled();
  });

  it.each(['receipt', 'cancelled'])(
    'stores a buyer %s from incoming history without a local invoice',
    async (type) => {
      (getOutgoingOrderRows as jest.Mock).mockResolvedValue([]);
      (hasIncomingOrder as jest.Mock).mockImplementation(
        async (owner, buyer, id) => owner === SELLER && buyer === STRANGER && id === 'order-1',
      );
      const rumor = buyerLifecycle(type);
      const { surface, writes } = surfacer();
      await surface(rumor, 'wrap-lifecycle');
      await Promise.all(writes);
      expect(upsertDmMessages).toHaveBeenCalledWith([
        expect.objectContaining({ wireKind: rumor.kind }),
      ]);
    },
  );
  it('retries an order reserved before subscription teardown', async () => {
    const first = surfacer(false, () => true);
    const rumor = orderRumor(`30402:${SELLER}:mug`);
    await first.surface(rumor, 'cancelled-wrap');
    await Promise.all(first.writes);
    expect(upsertDmMessages).not.toHaveBeenCalled();
    const retry = surfacer();
    await retry.surface(rumor, 'cancelled-wrap');
    await Promise.all(retry.writes);
    expect(upsertDmMessages).toHaveBeenCalledTimes(1);
  });

  it('releases a failed live write so the reserved rumor can retry', async () => {
    const { surface, writes } = surfacer();
    (upsertDmMessages as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    await surface(orderRumor(`30402:${SELLER}:mug`), 'failed-wrap');
    await expect(Promise.all(writes)).rejects.toThrow('disk');
    writes.length = 0;
    await surface(orderRumor(`30402:${SELLER}:mug`), 'failed-wrap');
    await Promise.all(writes);
    expect(upsertDmMessages).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])(
    'live stores a non-friend invoice; Messages Only friends=%s',
    async (onlyFriends) => {
      const { surface, writes, queueInboxEntry } = surfacer(false, () => false, !onlyFriends);
      await surface(sellerInvoice(), 'live-invoice');
      await Promise.all(writes);
      expect(upsertDmMessages).toHaveBeenCalledWith([expect.objectContaining({ wireKind: 16 })]);
      const entries = queueInboxEntry.mock.calls.map(([entry]) => entry);
      expect(entries).toHaveLength(onlyFriends ? 0 : 1);
      expect(buildDmSummaries(entries, [], onlyFriends ? new Set() : undefined)).toHaveLength(
        onlyFriends ? 0 : 1,
      );
      const notifications = await listNotifications(SELLER);
      expect(notifications).toHaveLength(onlyFriends ? 0 : 1);
      if (!onlyFriends)
        expect(notifications[0].data).toMatchObject({
          myOrderId: 'buyer-order',
          orderSellerPubkey: STRANGER,
        });
      expect(JSON.stringify(entries)).not.toContain('private');
      expect(JSON.stringify(await listNotifications(SELLER))).not.toContain('private');
    },
  );
});

describe('batch ingest path', () => {
  it.each(['receipt', 'cancelled'])(
    'stores a buyer %s from incoming history without a local invoice',
    async (type) => {
      (getOutgoingOrderRows as jest.Mock).mockResolvedValue([]);
      (hasIncomingOrder as jest.Mock).mockImplementation(
        async (owner, buyer, id) => owner === SELLER && buyer === STRANGER && id === 'order-1',
      );
      const rumor = buyerLifecycle(type);
      const result = await ingestInboxWraps({
        owner: SELLER,
        wraps: [{ id: 'buyer-lifecycle' }],
        unwrap: () => rumor,
        passesFollowGate: () => false,
      });
      expect(result.stored).toBe(1);
      expect(upsertDmMessages).toHaveBeenCalledWith([
        expect.objectContaining({ wireKind: rumor.kind }),
      ]);
    },
  );

  it('retries after an encrypted batch write fails', async () => {
    const rumor = orderRumor(`30402:${SELLER}:mug`);
    const params = {
      owner: SELLER,
      wraps: [{ id: 'retry' }],
      unwrap: () => rumor,
      passesFollowGate: () => false,
    };
    (upsertDmMessages as jest.Mock).mockRejectedValueOnce(new Error('disk'));
    await expect(ingestInboxWraps(params)).rejects.toThrow('disk');
    expect((await ingestInboxWraps(params)).stored).toBe(1);
    expect(upsertDmMessages).toHaveBeenCalledTimes(2);
  });

  it('stores stranger orders irrespective of listing ownership', async () => {
    const rumors: Record<string, DecodedRumor> = {
      mine: orderRumor(`30402:${SELLER}:mug`),
      theirs: orderRumor(`30402:${OTHER_SELLER}:mug`),
    };
    const res = await ingestInboxWraps({
      owner: SELLER,
      wraps: [{ id: 'mine' }, { id: 'theirs' }],
      unwrap: async (wrap: { id: string }) => rumors[wrap.id],
      passesFollowGate: () => false,
      skipKey: 'skip',
    });
    expect(res.entries).toHaveLength(0);
    expect(res.stored).toBe(2);
  });
});

const sellerInvoice = (): DecodedRumor => ({
  pubkey: STRANGER,
  kind: 16,
  created_at: Math.floor(Date.now() / 1000),
  content: 'private delivery text',
  tags: [
    ['p', SELLER],
    ['type', '2'],
    ['order', 'buyer-order'],
    ['amount', '4200'],
    ['payment', 'lightning', 'lnbc1' + 'a'.repeat(60)],
    ['address', 'private address'],
  ],
});

it.each([true, false])(
  'batch admits a non-friend invoice; Messages Only friends=%s',
  async (onlyFriends) => {
    const res = await ingestInboxWraps({
      owner: SELLER,
      wraps: [{ id: 'seller-invoice' }],
      unwrap: sellerInvoice,
      passesFollowGate: () => !onlyFriends,
    });
    expect(res.stored).toBe(1);
    expect(upsertDmMessages).toHaveBeenCalledWith([expect.objectContaining({ wireKind: 16 })]);
    const summaries = buildDmSummaries(res.entries, [], onlyFriends ? new Set() : undefined);
    expect(summaries).toHaveLength(onlyFriends ? 0 : 1);
    if (!onlyFriends) expect(summaries[0].lastComment).toBe('💳 Payment · 4,200 sats');
    expect(JSON.stringify(res.entries)).not.toContain('private');
  },
);

function buyerLifecycle(type: string): DecodedRumor {
  return {
    pubkey: STRANGER,
    kind: type === 'receipt' ? 17 : 16,
    created_at: Math.floor(Date.now() / 1000),
    content: '',
    tags: [
      ['p', SELLER],
      ['order', 'order-1'],
      ...(type === 'receipt'
        ? [['subject', 'order-receipt']]
        : [
            ['type', '3'],
            ['status', 'cancelled'],
          ]),
    ],
  };
}
