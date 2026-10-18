import AsyncStorage from '@react-native-async-storage/async-storage';
import { resetSellerStore } from '../services/sellerEventStore';
import { ingestInboxWraps } from './dmWrapIngest';
import { parseOrderEvent, serializeOrder } from '../utils/orderEvents';
import {
  admitUnfollowedOrder,
  ORDER_RUMOR_MAX_CHARS,
  ORDER_RUMOR_RATE_LIMIT,
} from './orderRumorIngest';
import { NWC_SHARE_KIND } from '../utils/nwcShareMessage';
import type { DmMessageRow } from '../services/dmDb';
import type { DecodedRumor } from '../utils/nip17Unwrap';

const mockWelcome = jest.fn(async (rumor: { kind: number }) => rumor.kind === 444);
jest.mock('../services/marmotWelcomeRouter', () => ({
  routeMarmotWelcome: (...args: unknown[]) => mockWelcome(...(args as [{ kind: number }])),
}));
/**
 * Unit tests for the shared NIP-17 inbox-wrap ingest engine (#848) — the
 * seam where refreshDmInbox (nsec + Amber) and the cold thread-open path
 * persist decrypted rumors into the encrypted DM store. Covers the gate
 * ORDER (DB known-id → skip-set → decrypt → group-route → follow-gate),
 * the #743 skip-set semantics, Amber permission-denial draining, and the
 * abort contract (F1/#849: decrypted DM rows ARE persisted even on abort
 * since they're idempotent + owner-keyed; entries + skip-set writes stay
 * abort-suppressed, as those are partial session state #412 drops).
 */

const mockSelectKnown = jest.fn();
const mockUpsert = jest.fn();
const mockOutgoingOrders = jest.fn();
jest.mock('../services/dmDb', () => ({
  getOutgoingOrderRows: (...args: unknown[]) => mockOutgoingOrders(...args),
  hasIncomingOrder: jest.fn().mockResolvedValue(false),
  selectKnownEventIds: (...args: unknown[]) => mockSelectKnown(...args),
  upsertDmMessages: (...args: unknown[]) => mockUpsert(...args),
}));

const mockRouteGroup = jest.fn();
jest.mock('./nostrGroupRouting', () => ({
  tryRouteGroupRumor: (...args: unknown[]) => mockRouteGroup(...args),
}));

// Pacing is unit-tested in nostrDecryptPacing.test — stub it here so wrap
// counts, not timers, drive these tests.
jest.mock('./nostrDecryptPacing', () => ({
  NIP17_LOOP_YIELD_EVERY: 8,
  createYieldScheduler: jest.fn(() => ({
    maybeYield: jest.fn(async () => {}),
    yieldCount: 0,
    dispose: jest.fn(),
  })),
}));

const mockLoadSkipSet = jest.fn();
const mockWriteSkipSet = jest.fn();
jest.mock('./nostrDmCache', () => ({
  loadNip17SkipSet: (...args: unknown[]) => mockLoadSkipSet(...args),
  writeNip17SkipSet: (...args: unknown[]) => mockWriteSkipSet(...args),
}));

// partnerFromRumor / textForRumor are exercised against handcrafted rumors:
// the test rumor carries its own partnership verdict.
jest.mock('../utils/nip17Unwrap', () => ({
  partnerFromRumor: (rumor: { partnership?: { partnerPubkey: string; fromMe: boolean } }) =>
    rumor.partnership ?? null,
  rumorEventId: (rumor: { kind: number }) =>
    ({ 16: 'unique-order-rumor', 7: 'reaction-rumor' })[rumor.kind],
  textForRumor: (rumor: DecodedRumor) => {
    const { parseOrderEvent, serializeOrder } = jest.requireActual('../utils/orderEvents');
    const order = parseOrderEvent(rumor);
    return order ? serializeOrder(order) : rumor.content;
  },
}));

const OWNER = 'f'.repeat(64);
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);

type TestRumor = {
  kind: number;
  tags?: string[][];
  created_at: number;
  content: string;
  partnership?: { partnerPubkey: string; fromMe: boolean };
  isGroup?: boolean;
};

const wrap = (id: string) => ({ id });
// Cast through unknown: the mocked partnerFromRumor/textForRumor above read
// the TestRumor shape, so DecodedRumor's envelope fields are irrelevant here.
const rumorFrom = (partner: string, over: Partial<TestRumor> = {}): DecodedRumor =>
  ({
    kind: 14,
    pubkey: partner,
    created_at: 100,
    content: `msg-from-${partner.slice(0, 4)}`,
    partnership: { partnerPubkey: partner, fromMe: false },
    ...over,
  }) as unknown as DecodedRumor;

beforeEach(async () => {
  await AsyncStorage.clear();
  resetSellerStore();
  jest.clearAllMocks();
  mockOutgoingOrders.mockImplementation(async (owner, seller, ids) => [
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
  mockSelectKnown.mockResolvedValue(new Set<string>());
  mockUpsert.mockResolvedValue(undefined);
  mockLoadSkipSet.mockResolvedValue(new Set<string>());
  mockWriteSkipSet.mockResolvedValue(undefined);
  mockRouteGroup.mockImplementation(async (rumor: TestRumor) => ({
    kind: rumor.isGroup ? 'routed' : 'not-group',
  }));
});

describe('dmWrapIngest.ingestInboxWraps', () => {
  it('stores a wrapped reaction with its rumor id but emits no inbox entry (#1321)', async () => {
    const unwrap = jest.fn(async () => rumorFrom(ALICE, { kind: 7, content: '{"content":"🎉"}' }));
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w-react')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
    });
    expect(res.entries).toEqual([]);
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      eventId: 'w-react',
      conversation: ALICE,
      wireKind: 7,
      rumorId: 'reaction-rumor',
    });
  });

  it('stores followed 1:1 rumors as rows and emits matching entries', async () => {
    const unwrap = jest.fn(async () => rumorFrom(ALICE));
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w1')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
    });
    expect(res.entries).toEqual([
      { id: 'w1', partnerPubkey: ALICE, fromMe: false, createdAt: 100, text: `msg-from-${ALICE.slice(0, 4)}`, wireKind: 14 }, // prettier-ignore
    ]);
    // A plain DM's preview IS its render text — no duplicate string stored.
    expect(res.entries[0]).not.toHaveProperty('renderText');
    expect(res.stored).toBe(1);
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows[0]).toEqual({
      owner: OWNER,
      eventId: 'w1',
      conversation: ALICE,
      createdAt: 100,
      sender: ALICE, // not fromMe → sender is the partner
      content: `msg-from-${ALICE.slice(0, 4)}`,
      fromMe: false,
      wireKind: 14,
    });
  });

  it('emits a friendly order preview for a kind-16 row but stores the raw order JSON (#market)', async () => {
    // The cold-start / refreshDmInbox path that builds the conversation list:
    // the in-memory inbox entry must show a readable summary, never the raw
    // order-JSON blob (textForRumor returns order JSON for kind 16/17). The
    // stored row keeps the raw JSON so the thread renderer + dmInbox projection
    // re-derive from it.
    const orderRumor = {
      ...rumorFrom(ALICE),
      kind: 16,
      content: '',
      tags: [
        ['p', OWNER],
        ['type', '1'],
        ['order', 'abc-12345678'],
        ['amount', '21'],
      ],
    };
    const orderJson = serializeOrder(parseOrderEvent(orderRumor)!);
    const unwrap = jest.fn(async () => orderRumor);
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('o1')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
    });
    expect(res.entries).toEqual([
      expect.objectContaining({ text: '🛒 Order Placed · 21 sats', wireKind: 16 }),
    ]);
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows[0].content).toBe(orderJson); // raw order JSON persisted
    expect(rows[0].wireKind).toBe(16);
  });

  it('drops a kind-16 that is not a parseable order before storage or inbox projection', async () => {
    // textForRumor falls back to rumor.content for a non-order kind-16 (e.g. a
    // repost or malformed payload); that raw text must not become renderText.
    const raw = 'nostr+walletconnect://relay?secret=cafebabe';
    const unwrap = jest.fn(async () => rumorFrom(ALICE, { kind: 16, content: raw }));
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('m1')],
      unwrap,
      passesFollowGate: () => true,
    });
    expect(res.entries).toEqual([]);
    expect(res.stored).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('never carries an NWC wallet-share secret into the inbox entry as renderText', async () => {
    const secret = 'nostr+walletconnect://relay?secret=deadbeef';
    const unwrap = jest.fn(async () => rumorFrom(ALICE, { kind: NWC_SHARE_KIND, content: secret }));
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('n1')],
      unwrap,
      passesFollowGate: () => true,
    });
    expect(res.entries[0]).not.toHaveProperty('renderText');
    expect(res.entries[0].text).not.toContain('deadbeef');
    // The raw content still reaches the encrypted store for the thread view.
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows[0].content).toBe(secret);
  });

  it('skips decrypt for DB-known wraps (decrypt-once) and reports them', async () => {
    mockOutgoingOrders.mockImplementation(async (owner, seller, ids) => [
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
    mockSelectKnown.mockResolvedValue(new Set(['w1']));
    const unwrap = jest.fn(async () => rumorFrom(ALICE));
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w1'), wrap('w2')],
      unwrap,
      passesFollowGate: () => true,
    });
    expect(unwrap).toHaveBeenCalledTimes(1); // only w2
    expect(res.alreadyKnown).toBe(1);
    expect(res.misses).toBe(1);
  });

  it('respects the #743 skip-set by default and bypasses it on user intent', async () => {
    mockLoadSkipSet.mockResolvedValue(new Set(['w1']));
    const unwrap = jest.fn(async () => rumorFrom(ALICE));
    const respected = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w1')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
    });
    expect(unwrap).not.toHaveBeenCalled();
    expect(respected.skipHits).toBe(1);

    const bypassed = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w1')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
      bypassSkipSet: true,
    });
    expect(unwrap).toHaveBeenCalledTimes(1);
    expect(bypassed.skipHits).toBe(0);
  });

  it('adds group-routed and non-followed rumors to the skip-set, stores neither', async () => {
    const unwrap = jest.fn(async (w: { id: string }) =>
      w.id === 'group' ? rumorFrom(ALICE, { isGroup: true }) : rumorFrom(BOB),
    );
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('group'), wrap('nonfollow')],
      unwrap,
      passesFollowGate: (pk) => pk !== BOB,
      skipKey: 'skip_key',
    });
    expect(res.entries).toEqual([]);
    expect(mockUpsert).not.toHaveBeenCalled();
    const [skipKey, persisted] = mockWriteSkipSet.mock.calls[0];
    expect(skipKey).toBe('skip_key');
    expect([...persisted].sort()).toEqual(['group', 'nonfollow']);
  });

  it('never touches the skip-set when no skipKey is given (thread-open path)', async () => {
    const unwrap = jest.fn(async () => rumorFrom(BOB, { isGroup: true }));
    await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('g1')],
      unwrap,
      passesFollowGate: () => true,
    });
    expect(mockLoadSkipSet).not.toHaveBeenCalled();
    expect(mockWriteSkipSet).not.toHaveBeenCalled();
  });

  it('stops decrypting after an Amber PERMISSION_NOT_GRANTED but keeps prior rows', async () => {
    const unwrap = jest.fn(async (w: { id: string }) => {
      if (w.id === 'denied') {
        const err = new Error('PERMISSION_NOT_GRANTED') as Error & { code: string };
        err.code = 'PERMISSION_NOT_GRANTED';
        throw err;
      }
      return rumorFrom(ALICE);
    });
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('ok'), wrap('denied'), wrap('after')],
      unwrap,
      passesFollowGate: () => true,
      stopOnPermissionDenied: true,
    });
    expect(res.permissionDenied).toBe(true);
    expect(unwrap.mock.calls.map((c) => c[0].id)).toEqual(['ok', 'denied']); // 'after' drained
    expect(res.stored).toBe(1); // the pre-denial decrypt still persisted
    expect(mockUpsert.mock.calls[0][0].map((r: DmMessageRow) => r.eventId)).toEqual(['ok']);
  });

  it('treats an ordinary unwrap throw as a skip, not a permission denial', async () => {
    const unwrap = jest.fn(async (w: { id: string }) => {
      if (w.id === 'boom') throw new Error('bad wrap');
      return rumorFrom(ALICE);
    });
    const onSkip = jest.fn();
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('boom'), wrap('ok')],
      unwrap,
      passesFollowGate: () => true,
      stopOnPermissionDenied: true,
      onSkip,
    });
    expect(res.permissionDenied).toBe(false);
    expect(onSkip).toHaveBeenCalledWith('bad wrap', 'boom');
    expect(res.stored).toBe(1);
  });

  it('an aborted run emits no entries and persists no skip-set changes', async () => {
    const controller = new AbortController();
    const unwrap = jest.fn(async () => {
      controller.abort(); // abort mid-run, after the first decrypt started
      return rumorFrom(BOB, { isGroup: true }); // group → routed, no DM row
    });
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w1'), wrap('w2')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
      signal: controller.signal,
    });
    // Entries (UI merge) and skip-set growth stay abort-suppressed — those are
    // partial session state #412 intentionally drops. The decrypt above was a
    // group rumor (routed, no DM row), so there's nothing to persist either.
    expect(res.entries).toEqual([]);
    expect(res.stored).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockWriteSkipSet).not.toHaveBeenCalled();
  });

  it('an aborted run STILL persists the 1:1 rows it decrypted before aborting (F1, #849)', async () => {
    // The F1 fix: a post-login cold rebuild aborted by a tab blur must not
    // throw away the rows it already decrypted (idempotent, owner-keyed). The
    // skip-set + emitted entries stay suppressed, but the durable DM rows land
    // in the encrypted DB so the next sweep paints them instead of re-decrypting.
    const controller = new AbortController();
    const unwrap = jest.fn(async () => {
      controller.abort(); // abort right after this real DM decrypt
      return rumorFrom(ALICE); // followed 1:1 → produces a storable row
    });
    const res = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('w1'), wrap('w2')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'skip_key',
      signal: controller.signal,
    });
    // Decrypted-and-persisted survives the abort...
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].map((r: DmMessageRow) => r.eventId)).toEqual(['w1']);
    expect(res.stored).toBe(1);
    // ...while the UI-merge entries + skip-set growth stay abort-suppressed.
    expect(res.entries).toEqual([]);
    expect(mockWriteSkipSet).not.toHaveBeenCalled();
  });
});

it.each([true, false])(
  'backfill routes kind-444 before the DM gate (followed=%s)',
  async (followed) => {
    const welcome = { ...rumorFrom(BOB, { kind: 444 }), pubkey: BOB };
    const gate = jest.fn(() => false);
    const result = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('welcome-wrap')],
      unwrap: () => welcome,
      passesFollowGate: gate,
      isFollowed: () => followed,
      skipKey: 'skip_key',
      isColdStart: true,
    });
    expect(mockWelcome).toHaveBeenCalledWith(
      welcome,
      OWNER,
      'welcome-wrap',
      followed,
      false,
      expect.any(Function),
    );
    expect(gate).not.toHaveBeenCalled();
    expect(mockRouteGroup).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
    expect(mockWriteSkipSet).toHaveBeenCalledWith('skip_key', new Set(['welcome-wrap']));
  },
);

// Real Gamma tags exercise classification and address stripping at the seam.
const sellerInvoice: DecodedRumor = {
  pubkey: BOB,
  kind: 16,
  created_at: 100,
  content: '',
  tags: [
    ['p', OWNER],
    ['type', '2'],
    ['order', 'purchase'],
    ['payment', 'lightning', 'lnbc-invoice'],
    ['address', 'PRIVATE DELIVERY ADDRESS'],
  ],
  ...{ partnership: { partnerPubkey: BOB, fromMe: false } },
};

it.each([false, true])(
  'stores a non-friend invoice independently of Messages visibility (%s)',
  async (includeNonFollows) => {
    const result = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('seller-invoice')],
      unwrap: () => sellerInvoice,
      passesFollowGate: () => includeNonFollows,
      skipKey: 'orders-skip',
      isFollowed: () => false,
    });
    expect(result.stored).toBe(1);
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows[0].content).toBe(serializeOrder(parseOrderEvent(sellerInvoice)!));
    expect(rows[0].content).not.toContain('PRIVATE DELIVERY ADDRESS');
    expect(result.entries).toHaveLength(includeNonFollows ? 1 : 0);
    if (includeNonFollows) {
      expect(result.entries[0].text).toBe('💳 Payment');
      expect(result.entries[0].text).not.toContain('lnbc');
    }
    expect(mockWriteSkipSet).not.toHaveBeenCalled();
  },
);

it.each([
  {
    kind: 16,
    tags: [
      ['type', '1'],
      ['order', 'purchase'],
    ],
  },
  {
    kind: 16,
    tags: [
      ['type', '3'],
      ['order', 'purchase'],
      ['status', 'confirmed'],
    ],
  },
  {
    kind: 16,
    tags: [
      ['type', '4'],
      ['order', 'purchase'],
      ['status', 'shipped'],
    ],
  },
  {
    kind: 17,
    tags: [
      ['subject', 'order-receipt'],
      ['order', 'purchase'],
    ],
  },
])('retains non-friend lifecycle events for Orders ($kind $tags)', async (event) => {
  const result = await ingestInboxWraps({
    owner: OWNER,
    wraps: [wrap('lifecycle')],
    unwrap: () => ({ ...sellerInvoice, ...event, tags: [['p', OWNER], ...event.tags] }),
    passesFollowGate: () => false,
  });
  expect(result.stored).toBe(1);
  expect(result.entries).toEqual([]);
});

it('does not exempt oversized orders or reposts from the free-text follow gate', async () => {
  const result = await ingestInboxWraps({
    owner: OWNER,
    wraps: [wrap('large'), wrap('repost')],
    unwrap: (w) =>
      w.id === 'large'
        ? { ...sellerInvoice, content: 'x'.repeat(ORDER_RUMOR_MAX_CHARS + 1) }
        : { ...sellerInvoice, tags: [...sellerInvoice.tags, ['k', '1']] },
    passesFollowGate: () => false,
  });
  expect(result.stored).toBe(0);
  expect(result.entries).toEqual([]);
});

it.each([false, true])(
  'drops unsolicited backfill lifecycle events with Messages allowed=%s',
  async (allowed) => {
    mockOutgoingOrders.mockResolvedValue([]);
    const result = await ingestInboxWraps({
      owner: OWNER,
      wraps: [wrap('stranger-invoice')],
      unwrap: () => sellerInvoice,
      passesFollowGate: () => allowed,
    });
    expect(result.stored).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
  },
);
it('stores one row for 100 distinct gift wraps of the same order rumor', async () => {
  const order = rumorFrom(ALICE, {
    kind: 16,
    tags: [
      ['p', OWNER],
      ['order', 'batch-order'],
      ['type', '1'],
    ],
    content: '',
  });
  const res = await ingestInboxWraps({
    owner: OWNER,
    wraps: Array.from({ length: 100 }, (_, n) => wrap(`duplicate-${n}`)),
    unwrap: async () => order,
    passesFollowGate: () => true,
  });
  expect(res.stored).toBe(1);
  expect(res.entries).toHaveLength(1);
  expect(mockUpsert.mock.calls[0][0]).toHaveLength(1);
});

it('releases batch delivery claims after a failed encrypted payload write', async () => {
  const order = rumorFrom(ALICE, {
    kind: 16,
    tags: [
      ['p', OWNER],
      ['order', 'batch-order'],
      ['type', '1'],
    ],
    content: '',
  });
  const params = {
    owner: OWNER,
    wraps: [wrap('failed-order')],
    unwrap: async () => order,
    passesFollowGate: () => true,
  };
  mockUpsert.mockRejectedValueOnce(new Error('encrypted store unavailable'));
  await expect(ingestInboxWraps(params)).rejects.toThrow('encrypted store unavailable');
  const retry = await ingestInboxWraps(params);
  expect(retry.stored).toBe(1);
  expect(mockUpsert).toHaveBeenCalledTimes(2);
});

it.each(['malformed', 'limited', 'over-cap'])(
  'remembers %s order wraps in the skip-set across refreshes',
  async (reason) => {
    const order = rumorFrom(ALICE, {
      kind: 16,
      tags:
        reason === 'malformed'
          ? []
          : [
              ['type', '1'],
              ['order', 'limited'],
              ...(reason === 'over-cap'
                ? Array.from({ length: 51 }, () => ['item', 'product', '1'])
                : []),
            ],
    });
    if (reason === 'limited') {
      const { orderBudgetKey } = jest.requireActual('../services/orderAdmission');
      await AsyncStorage.setItem(
        orderBudgetKey(OWNER),
        JSON.stringify({
          accepted: Array.from({ length: 5 }, (_, n) => ({
            id: String(n),
            sender: ALICE,
            at: Date.now(),
            stored: true,
          })),
          dropped: 0,
          droppedSince: Date.now(),
        }),
      );
    }
    const unwrap = jest.fn(() => order);
    const params = {
      owner: OWNER,
      wraps: [wrap('rejected-order')],
      unwrap,
      passesFollowGate: () => true,
      skipKey: 'orders-skip',
    };
    expect((await ingestInboxWraps(params)).stored).toBe(0);
    expect(mockWriteSkipSet).toHaveBeenCalledWith('orders-skip', new Set(['rejected-order']));
    mockLoadSkipSet.mockResolvedValue(mockWriteSkipSet.mock.calls[0][1]);
    expect((await ingestInboxWraps(params)).skipHits).toBe(1);
    expect(unwrap).toHaveBeenCalledTimes(1);
  },
);

it('keeps order wraps retryable after a budget storage failure', async () => {
  const unwrap = jest.fn(() =>
    rumorFrom(BOB, {
      kind: 16,
      tags: [
        ['type', '1'],
        ['order', 'retry-storage'],
      ],
    }),
  );
  const storage = jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('storage'));
  const params = {
    owner: OWNER,
    wraps: [wrap('retry-storage')],
    unwrap,
    passesFollowGate: () => true,
    skipKey: 'orders-skip',
  };
  expect((await ingestInboxWraps(params)).stored).toBe(0);
  expect(mockWriteSkipSet).not.toHaveBeenCalled();
  storage.mockRestore();
  expect((await ingestInboxWraps(params)).stored).toBe(1);
  expect(unwrap).toHaveBeenCalledTimes(2);
});

it('retries a rate-limited incoming order on ordinary refresh after the window expires', async () => {
  const owner = 'rate-limited-backfill';
  const now = jest.spyOn(Date, 'now').mockReturnValue(100_000);
  try {
    for (let i = 0; i < ORDER_RUMOR_RATE_LIMIT; i++) admitUnfollowedOrder(owner);
    const params = {
      owner,
      wraps: [wrap('retryable-invoice')],
      unwrap: jest.fn(() => sellerInvoice),
      passesFollowGate: () => false,
      isFollowed: () => false,
      skipKey: 'rate-limited-skip',
    };
    expect((await ingestInboxWraps(params)).stored).toBe(0);
    expect(mockWriteSkipSet).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    now.mockReturnValue(160_000);
    expect((await ingestInboxWraps(params)).stored).toBe(1);
    expect(params.unwrap).toHaveBeenCalledTimes(2);
    expect(mockWriteSkipSet).not.toHaveBeenCalled();
  } finally {
    now.mockRestore();
  }
});

it('stores sent copies to non-friends without consuming or depending on the incoming budget', async () => {
  const owner = 'outgoing-backfill-budget';
  const params = {
    owner,
    wraps: [wrap('outgoing-invoice')],
    unwrap: () => ({
      ...sellerInvoice,
      pubkey: owner,
      partnership: { partnerPubkey: BOB, fromMe: true },
    }),
    passesFollowGate: () => false,
    isFollowed: () => false,
    skipKey: 'outgoing-skip',
  };
  expect((await ingestInboxWraps(params)).stored).toBe(1);
  for (let i = 0; i < ORDER_RUMOR_RATE_LIMIT; i++) {
    expect(admitUnfollowedOrder(owner)).toBe(true);
  }
  expect(admitUnfollowedOrder(owner)).toBe(false);
  expect((await ingestInboxWraps(params)).stored).toBe(1);
  expect(mockWriteSkipSet).not.toHaveBeenCalled();
});
