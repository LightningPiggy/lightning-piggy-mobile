// DAL over the encrypted dm_messages table. getLocalDb is mocked with a fake
// op-sqlite DB (execute + transaction) so these cover the SQL/params/mapping
// without the native module — the encrypted open itself is verified on-device
// (localDb / #700).
import {
  subscribeDmStorage,
  subscribeDmDeletions,
  deleteDmMessagesByIds,
  selectKnownEventIds,
  upsertDmMessages,
  upsertDmMessagesIf,
  importDmMessages,
  updateDmDeliveryStatuses,
  getConversationMessages,
  getConversationMessageWindow,
  getOutgoingOrderRows,
  getShopOrderRows,
  getInboxLatest,
  selectDmWrapIds,
  hasStoredWraps,
  hasConversationWith,
  deleteDmMessagesForOwner,
  deleteMarmotMessages,
  type DmMessageRow,
  getConversationForEvent,
} from './dmDb';
import { dmOwnerEpoch, isDmOwnerRetired, reviveDmOwner } from './dmOwnerGuard';

const mockExecute = jest.fn();
const mockTransaction = jest.fn(
  async (fn: (tx: { execute: typeof mockExecute }) => Promise<void>) => {
    await fn({ execute: mockExecute });
  },
);
jest.mock('./localDb', () => ({
  getLocalDb: jest.fn(() =>
    Promise.resolve({ execute: mockExecute, transaction: mockTransaction }),
  ),
}));

const OWNER = 'owner1';

const row = (over: Partial<DmMessageRow> = {}): DmMessageRow => ({
  owner: OWNER,
  eventId: 'e1',
  conversation: 'convA',
  createdAt: 100,
  sender: 's1',
  content: 'hi',
  fromMe: false,
  wireKind: 14,
  ...over,
});

// op-sqlite shape: { rows: Array<Record<string, Scalar>> }
const rowsResult = (rows: Record<string, unknown>[]) => ({ rows });

beforeEach(() => {
  jest.clearAllMocks();
  mockExecute.mockResolvedValue(rowsResult([]));
});

describe('dmDb', () => {
  describe('selectKnownEventIds', () => {
    it('returns empty set (no query) for an empty input', async () => {
      expect((await selectKnownEventIds(OWNER, [])).size).toBe(0);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('returns the set of ids already stored, scoped to the owner', async () => {
      mockExecute.mockResolvedValueOnce(rowsResult([{ event_id: 'a' }, { event_id: 'c' }]));
      const known = await selectKnownEventIds(OWNER, ['a', 'b', 'c']);
      expect([...known].sort()).toEqual(['a', 'c']);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('WHERE owner = ? AND event_id IN (?,?,?)');
      expect(params).toEqual([OWNER, 'a', 'b', 'c']);
    });

    it('chunks large id lists under the SQLite variable limit', async () => {
      const ids = Array.from({ length: 1200 }, (_, i) => `id${i}`);
      await selectKnownEventIds(OWNER, ids);
      // 1200 / 500 → 3 chunked queries
      expect(mockExecute).toHaveBeenCalledTimes(3);
    });
  });

  describe('upsertDmMessages', () => {
    it('no-ops on empty input', async () => {
      await upsertDmMessages([]);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('writes nothing when persistIf fails inside the transaction', async () => {
      expect(await upsertDmMessagesIf([row({ eventId: 'e1' })], () => false)).toBe(false);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('upserts received rows in one transaction, keeping any existing tick (COALESCE)', async () => {
      await upsertDmMessages([row({ eventId: 'e1' }), row({ eventId: 'e2' })]);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // Received (fromMe=false) rows skip the local-echo lookup → one
      // statement per row.
      expect(mockExecute).toHaveBeenCalledTimes(2);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('INSERT INTO dm_messages');
      expect(sql).toContain('ON CONFLICT(owner, event_id) DO UPDATE');
      expect(sql).toContain('COALESCE(excluded.delivery_status, dm_messages.delivery_status)');
      expect(sql).toContain('COALESCE(excluded.rumor_id, dm_messages.rumor_id)');
      expect(sql).toContain('protocol        = COALESCE(excluded.protocol, dm_messages.protocol)');
      expect(params).toEqual([
        OWNER, 'e1', 'convA', 100, 's1', 'hi', 0, 14, null, null, null, null, null, null,
      ]); // prettier-ignore
    });

    it('serialises deliveryStatus / rumorId onto optimistic local- rows (#850)', async () => {
      const status = { delivered: true, relayResults: { 'wss://r': 'ok' as const } };
      await upsertDmMessages([
        row({ eventId: 'local-1', fromMe: true, deliveryStatus: status, rumorId: 'rum1' }),
      ]);
      // local- rows never echo-match themselves (the lookup is skipped for
      // local- ids), so a single INSERT.
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [, params] = mockExecute.mock.calls[0];
      expect(params[8]).toBe(JSON.stringify(status));
      expect(params[9]).toBe('rum1');
    });

    it('retires the matched local- row when its echo lands, inheriting tick + rumorId', async () => {
      const status = { delivered: true, relayResults: {} };
      // Echo lookup returns the pending local- row for this send.
      mockExecute.mockResolvedValueOnce(
        rowsResult([
          {
            event_id: 'local-42',
            delivery_status: JSON.stringify(status),
            rumor_id: 'rum42',
            created_at: 99,
          },
        ]),
      );
      await upsertDmMessages([row({ eventId: 'wrap42', fromMe: true, createdAt: 100 })]);
      // SELECT (echo lookup) + DELETE (retire local-) + INSERT (echo row)
      expect(mockExecute).toHaveBeenCalledTimes(3);
      const [selectSql, selectParams] = mockExecute.mock.calls[0];
      expect(selectSql).toContain(`event_id LIKE 'local-%'`);
      expect(selectSql).toContain('from_me = 1');
      // Sargable window (Copilot #990): BETWEEN, not ABS(created_at - ?).
      expect(selectSql).toContain('created_at BETWEEN ? - 30 AND ? + 30');
      // Same-protocol only: a NIP-17 echo never retires a NIP-04 local- row.
      expect(selectSql).toContain(
        "COALESCE(protocol, CASE WHEN wire_kind = 4 THEN 'nip04' ELSE 'nip17' END) = ?",
      );
      expect(selectSql).toContain('(content = ? OR (rumor_id IS NOT NULL AND rumor_id = ?))');
      expect(selectParams).toEqual([OWNER, 'convA', 'hi', null, 'nip17', 100, 100]);
      const [deleteSql, deleteParams] = mockExecute.mock.calls[1];
      expect(deleteSql).toContain('DELETE FROM dm_messages');
      expect(deleteParams).toEqual([OWNER, 'local-42']);
      const [, insertParams] = mockExecute.mock.calls[2];
      expect(insertParams[1]).toBe('wrap42');
      expect(insertParams[8]).toBe(JSON.stringify(status)); // inherited tick
      expect(insertParams[9]).toBe('rum42'); // inherited rumorId
    });

    it('does not retire a local- row outside the echo window', async () => {
      // Lookup returns nothing (the SQL window filter excluded it) → no DELETE.
      await upsertDmMessages([row({ eventId: 'wrap43', fromMe: true, createdAt: 100 })]);
      expect(mockExecute).toHaveBeenCalledTimes(2); // SELECT + INSERT, no DELETE
    });
  });

  describe('importDmMessages (blob migration, #850)', () => {
    it('no-ops on empty input', async () => {
      await importDmMessages([]);
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('fill-only: the EXISTING row wins; import only supplies a missing tick/rumorId', async () => {
      const status = { delivered: true, relayResults: {} };
      await importDmMessages([row({ eventId: 'e1', deliveryStatus: status, rumorId: 'r1' })]);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      // Reversed COALESCE order vs upsert: dm_messages (existing) first.
      expect(sql).toContain('COALESCE(dm_messages.delivery_status, excluded.delivery_status)');
      expect(sql).toContain('COALESCE(dm_messages.rumor_id, excluded.rumor_id)');
      expect(params[8]).toBe(JSON.stringify(status));
      expect(params[9]).toBe('r1');
    });
  });

  describe('updateDmDeliveryStatuses (#856 tick persist, #850 store-backed)', () => {
    it('no-ops on an empty map', async () => {
      await updateDmDeliveryStatuses(OWNER, {});
      expect(mockTransaction).not.toHaveBeenCalled();
    });

    it('fills only rows without an existing status (delivery_status IS NULL)', async () => {
      const status = { delivered: true, relayResults: {} };
      await updateDmDeliveryStatuses(OWNER, { e1: status });
      expect(mockExecute).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('UPDATE dm_messages SET delivery_status = ?');
      expect(sql).toContain('delivery_status IS NULL');
      expect(params).toEqual([JSON.stringify(status), OWNER, 'e1']);
    });
  });

  describe('hasConversationWith (#850 order-trust check)', () => {
    it('is true when any row exists for (owner, conversation)', async () => {
      mockExecute.mockResolvedValueOnce(rowsResult([{ present: 1 }]));
      expect(await hasConversationWith(OWNER, 'convA')).toBe(true);
      const [sql, params] = mockExecute.mock.calls[0];
      // Reaction rows (#1321) alone don't make a conversation.
      expect(sql).toContain(
        'WHERE owner = ? AND conversation = ? AND wire_kind NOT IN (7, 5) LIMIT 1',
      );
      expect(params).toEqual([OWNER, 'convA']);
    });

    it('is false when no row exists', async () => {
      expect(await hasConversationWith(OWNER, 'convZ')).toBe(false);
    });
  });

  describe('tapped message window', () => {
    it('falls back without reading history when the target is absent in this account/thread', async () => {
      mockExecute.mockResolvedValueOnce(rowsResult([]));
      expect(await getConversationMessageWindow(OWNER, 'convA', 'marmot', 'gone')).toEqual([]);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockExecute.mock.calls[0][1]).toEqual([OWNER, 'convA', 'marmot', 'gone']);
    });
    it('always includes the target when the bounded timestamp window is full', async () => {
      mockExecute
        .mockResolvedValueOnce(
          rowsResult([
            {
              owner: OWNER,
              event_id: 'tapped',
              conversation: 'convA',
              created_at: 200,
              sender: 'peer',
              content: 'old',
              from_me: 0,
              wire_kind: 9,
              protocol: 'marmot',
            },
          ]),
        )
        .mockResolvedValueOnce(rowsResult([]));
      const window = await getConversationMessageWindow(OWNER, 'convA', 'marmot', 'tapped');
      expect(window.map((m) => m.eventId)).toEqual(['tapped']);
      expect(mockExecute.mock.calls[1][1]).toEqual([
        OWNER,
        'convA',
        'marmot',
        200,
        OWNER,
        'convA',
        'marmot',
        200,
      ]);
    });
  });

  describe('getConversationMessages', () => {
    it('reads newest-first with a default limit, mapping rows', async () => {
      mockExecute.mockResolvedValueOnce(
        rowsResult([
          {
            owner: OWNER,
            event_id: 'e2',
            conversation: 'convA',
            created_at: 200,
            sender: 's',
            content: 'b',
            from_me: 1,
            wire_kind: 14,
          },
        ]),
      );
      const out = await getConversationMessages(OWNER, 'convA');
      expect(out).toEqual([
        {
          owner: OWNER,
          eventId: 'e2',
          conversation: 'convA',
          createdAt: 200,
          sender: 's',
          content: 'b',
          fromMe: true,
          wireKind: 14,
        },
      ]);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('WHERE owner = ? AND conversation = ?');
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(params).toEqual([OWNER, 'convA', 50]);
    });

    it('filters by protocol before the LIMIT so threads get separate windows (#1118)', async () => {
      // Effective protocol: explicit column (Marmot) wins, else wire_kind 4 → NIP-04.
      for (const [i, protocol] of (['nip04', 'nip17', 'marmot'] as const).entries()) {
        await getConversationMessages(OWNER, 'convA', { limit: 500, protocol });
        const [sql, params] = mockExecute.mock.calls[i];
        expect(sql).toContain(
          "AND COALESCE(protocol, CASE WHEN wire_kind = 4 THEN 'nip04' ELSE 'nip17' END) = ? ORDER BY created_at DESC LIMIT ?",
        );
        expect(params).toEqual([OWNER, 'convA', protocol, 500]);
      }
    });

    it('pages backwards with beforeCreatedAt', async () => {
      await getConversationMessages(OWNER, 'convA', { limit: 20, beforeCreatedAt: 150 });
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('created_at < ?');
      expect(params).toEqual([OWNER, 'convA', 150, 20]);
    });

    it('parses delivery_status JSON + rumor_id off the row; corrupt JSON degrades to none', async () => {
      const status = { delivered: true, relayResults: {} };
      mockExecute.mockResolvedValueOnce(
        rowsResult([
          {
            owner: OWNER,
            event_id: 'sent1',
            conversation: 'convA',
            created_at: 300,
            sender: OWNER,
            content: 'yo',
            from_me: 1,
            wire_kind: 14,
            delivery_status: JSON.stringify(status),
            rumor_id: 'rumX',
          },
          {
            owner: OWNER,
            event_id: 'sent2',
            conversation: 'convA',
            created_at: 301,
            sender: OWNER,
            content: 'yo2',
            from_me: 1,
            wire_kind: 14,
            delivery_status: '{corrupt',
            rumor_id: null,
          },
        ]),
      );
      const out = await getConversationMessages(OWNER, 'convA');
      expect(out[0].deliveryStatus).toEqual(status);
      expect(out[0].rumorId).toBe('rumX');
      expect(out[1].deliveryStatus).toBeUndefined();
      expect(out[1].rumorId).toBeUndefined();
    });
  });

  describe('getOutgoingOrderRows', () => {
    it('returns nothing (no query) for an empty id list', async () => {
      expect(await getOutgoingOrderRows(OWNER, 'convA', [])).toEqual([]);
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it('reads only our own kind-16 rows in the conversation, one escaped LIKE per id', async () => {
      mockExecute.mockResolvedValueOnce(
        rowsResult([
          { owner: OWNER, event_id: 'o1', conversation: 'convA', created_at: 5, sender: OWNER, content: '{"orderId":"abc"}', from_me: 1, wire_kind: 16 }, // prettier-ignore
        ]),
      );
      const rows = await getOutgoingOrderRows(OWNER, 'convA', ['abc', 'x_y%']);
      expect(rows.map((r) => r.eventId)).toEqual(['o1']);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('owner = ? AND conversation = ? AND from_me = 1 AND wire_kind = 16');
      expect(sql).toContain("content LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'");
      expect(params).toEqual([OWNER, 'convA', '%"orderId":"abc"%', '%"orderId":"x\\_y\\%"%']);
    });
  });

  describe('getShopOrderRows', () => {
    it('bounds incoming placed orders and reads their lifecycle rows in both directions', async () => {
      mockExecute.mockResolvedValueOnce(
        rowsResult([
          { owner: OWNER, event_id: 'o1', conversation: 'buyer', created_at: 9, sender: 'buyer', content: '{}', from_me: 0, wire_kind: 16 }, // prettier-ignore
        ]),
      );
      const rows = await getShopOrderRows(OWNER, 50);
      expect(rows.map((r) => [r.eventId, r.fromMe])).toEqual([['o1', false]]);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain(
        'owner = ? AND sender = conversation AND from_me = 0 AND wire_kind = 16',
      );
      expect(sql).toContain('owner = ? AND wire_kind IN (16, 17)');
      expect(sql).toContain('ORDER BY created_at DESC');
      expect(sql).toContain('LIMIT ?');
      expect(params).toEqual([OWNER, 50, OWNER]);
    });
  });

  describe('getInboxLatest', () => {
    it('selects the latest row per conversation (MAX(created_at) join), owner-scoped', async () => {
      mockExecute.mockResolvedValueOnce(
        rowsResult([
          {
            owner: OWNER,
            event_id: 'e9',
            conversation: 'convB',
            created_at: 900,
            sender: 's',
            content: 'z',
          },
        ]),
      );
      const out = await getInboxLatest(OWNER);
      expect(out[0].conversation).toBe('convB');
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('MAX(created_at)');
      // One latest row per (partner, protocol): NIP-04, NIP-17 and Marmot are separate threads.
      expect(sql).toContain(
        "GROUP BY conversation, COALESCE(protocol, CASE WHEN wire_kind = 4 THEN 'nip04' ELSE 'nip17' END)",
      );
      expect(sql).toContain('WHERE m.owner = ?');
      // Marmot invite gift wraps never become a thread's latest (#1269).
      // …and neither do wrapped reactions / retractions (#1321).
      expect(sql).toContain('WHERE owner = ? AND wire_kind NOT IN (444, 7, 5)');
      expect(sql).toContain('WHERE m.owner = ? AND m.wire_kind NOT IN (444, 7, 5)');
      expect(params).toEqual([OWNER, OWNER]);
    });
  });

  describe('selectDmWrapIds', () => {
    it('returns NIP-17 wrap ids only (kind-4 + optimistic local- rows excluded)', async () => {
      mockExecute.mockResolvedValueOnce(rowsResult([{ event_id: 'w1' }, { event_id: 'w2' }]));
      const out = await selectDmWrapIds(OWNER);
      expect(out).toEqual(['w1', 'w2']);
      const [sql, params] = mockExecute.mock.calls[0];
      // NIP-17 rows only — Marmot rows are keyed by app-event id, not wrap id.
      expect(sql).toContain(
        "COALESCE(protocol, CASE WHEN wire_kind = 4 THEN 'nip04' ELSE 'nip17' END) = 'nip17'",
      );
      expect(sql).toContain(`event_id NOT LIKE 'local-%'`);
      expect(params).toEqual([OWNER]);
    });
  });

  describe('hasStoredWraps', () => {
    it('is false on an empty store and true once a wrap row exists', async () => {
      expect(await hasStoredWraps(OWNER)).toBe(false);
      mockExecute.mockResolvedValueOnce(rowsResult([{ present: 1 }]));
      expect(await hasStoredWraps(OWNER)).toBe(true);
      const [sql] = mockExecute.mock.calls[0];
      expect(sql).toContain('LIMIT 1');
      expect(sql).toContain(
        "COALESCE(protocol, CASE WHEN wire_kind = 4 THEN 'nip04' ELSE 'nip17' END) = 'nip17'",
      );
      // A first-ever optimistic send must not fake a completed ingest (#850).
      expect(sql).toContain(`event_id NOT LIKE 'local-%'`);
    });
  });

  describe('deleteMarmotMessages', () => {
    it('deletes Marmot rows by id in the conversation, only those the sender wrote', async () => {
      mockExecute.mockResolvedValueOnce(rowsResult([{ event_id: 'm1' }]));
      expect(await deleteMarmotMessages(OWNER, 'convA', ['m1', 'm2'], 'peer')).toEqual(['m1']);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain("protocol = 'marmot'");
      expect(sql).toContain('conversation = ?');
      expect(sql).toContain('sender = ?');
      // By rumor id too: our own `local-` send row carries the Marmot id there (#1237).
      expect(sql).toContain('(event_id IN (?,?) OR rumor_id IN (?,?))');
      expect(sql).toContain('RETURNING event_id');
      expect(params).toEqual([OWNER, 'convA', 'peer', 'm1', 'm2', 'm1', 'm2']);
    });
    it('an admin removal (null sender) takes any member’s message', async () => {
      await deleteMarmotMessages(OWNER, 'convA', ['m1'], null);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).not.toContain('sender = ?');
      expect(params).toEqual([OWNER, 'convA', 'm1', 'm1']);
    });
    it('chunks so both id lists stay under the SQLite variable cap', async () => {
      const ids = Array.from({ length: 600 }, (_, i) => `m${i}`);
      await deleteMarmotMessages(OWNER, 'convA', ids, 'peer');
      expect(mockExecute).toHaveBeenCalledTimes(3);
      for (const [, params] of mockExecute.mock.calls) expect(params.length).toBeLessThan(999);
    });
    it('does nothing for no ids', async () => {
      await deleteMarmotMessages(OWNER, 'convA', [], 'peer');
      expect(mockExecute).not.toHaveBeenCalled();
    });
  });

  describe('deleteDmMessagesForOwner', () => {
    it("deletes only the owner's rows, in a transaction (ordered against upserts)", async () => {
      await deleteDmMessagesForOwner(OWNER);
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      const [sql, params] = mockExecute.mock.calls[0];
      expect(sql).toContain('DELETE FROM dm_messages WHERE owner = ?');
      expect(params).toEqual([OWNER]);
    });

    it('changes the owner epoch at once, so an in-flight write can tell', async () => {
      const before = dmOwnerEpoch(OWNER);
      const wipe = deleteDmMessagesForOwner(OWNER);
      expect(dmOwnerEpoch(OWNER)).toBe(before + 1); // before the DELETE resolves
      await wipe;
      expect(dmOwnerEpoch(OWNER.toUpperCase())).toBe(before + 1);
    });

    it('retires the owner until it signs in again', async () => {
      reviveDmOwner(OWNER);
      expect(isDmOwnerRetired(OWNER)).toBe(false);
      await deleteDmMessagesForOwner(OWNER);
      expect(isDmOwnerRetired(OWNER.toUpperCase())).toBe(true);
      reviveDmOwner(OWNER);
      expect(isDmOwnerRetired(OWNER)).toBe(false);
    });
  });
});

describe('getConversationForEvent (#1154)', () => {
  it('returns the conversation and wire kind of a stored event, scoped to the owner', async () => {
    mockExecute.mockResolvedValueOnce(
      rowsResult([{ conversation: 'b'.repeat(64), wire_kind: 14, from_me: 0 }]),
    );
    await expect(getConversationForEvent('a'.repeat(64), 'wrap')).resolves.toEqual({
      conversation: 'b'.repeat(64),
      wireKind: 14,
      fromMe: false,
    });
    expect(mockExecute.mock.calls.at(-1)?.[1]).toEqual(['a'.repeat(64), 'wrap']);
  });

  it('says when the stored event is our own (a sent copy)', async () => {
    mockExecute.mockResolvedValueOnce(
      rowsResult([{ conversation: 'b'.repeat(64), wire_kind: 14, from_me: 1 }]),
    );
    await expect(getConversationForEvent('a'.repeat(64), 'wrap')).resolves.toMatchObject({
      fromMe: true,
    });
  });

  it('returns null until the event has been stored', async () => {
    mockExecute.mockResolvedValueOnce(rowsResult([]));
    await expect(getConversationForEvent('a'.repeat(64), 'wrap')).resolves.toBeNull();
  });
});

it('signals each owner once after a committed upsert and unsubscribes', async () => {
  const listener = jest.fn();
  const unsubscribe = subscribeDmStorage(listener);
  mockExecute.mockImplementationOnce(async () => {
    expect(listener).not.toHaveBeenCalled();
    return rowsResult([]);
  });
  await upsertDmMessages([row(), row({ eventId: 'e2' }), row({ owner: 'owner2' })]);
  // Each owner gets its own committed rows (#1623 tracks our sends from them).
  expect(listener.mock.calls).toEqual([
    [OWNER, [row(), row({ eventId: 'e2' })]],
    ['owner2', [row({ owner: 'owner2' })]],
  ]);
  unsubscribe();
  await upsertDmMessages([row()]);
  expect(listener).toHaveBeenCalledTimes(2);
});

it('does not signal storage changes for empty or failed transactions', async () => {
  const listener = jest.fn();
  const unsubscribe = subscribeDmStorage(listener);
  try {
    await upsertDmMessages([]);
    mockTransaction.mockRejectedValueOnce(new Error('rollback'));
    await expect(upsertDmMessages([row()])).rejects.toThrow('rollback');
    expect(listener).not.toHaveBeenCalled();
  } finally {
    unsubscribe();
  }
});

it('signals imported rows after commit so placeholders can resolve', async () => {
  const listener = jest.fn();
  const unsubscribe = subscribeDmStorage(listener);
  try {
    await importDmMessages([row()]);
    expect(listener).toHaveBeenCalledWith(OWNER, [row()]);
  } finally {
    unsubscribe();
  }
});

describe('subscribeDmDeletions', () => {
  it('fires once with owner + ids after the deletes land, then unsubscribes', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeDmDeletions(listener);
    mockExecute.mockImplementationOnce(async () => {
      expect(listener).not.toHaveBeenCalled();
      return rowsResult([]);
    });
    await deleteDmMessagesByIds(OWNER, ['w1', 'w2']);
    expect(listener.mock.calls).toEqual([[OWNER, ['w1', 'w2']]]);
    unsubscribe();
    await deleteDmMessagesByIds(OWNER, ['w3']);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire on upserts, imports or an empty delete', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeDmDeletions(listener);
    try {
      await upsertDmMessages([row()]);
      await importDmMessages([row({ eventId: 'e2' })]);
      await deleteDmMessagesByIds(OWNER, []);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it('does not fire when the delete fails', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeDmDeletions(listener);
    try {
      mockExecute.mockRejectedValueOnce(new Error('db'));
      await expect(deleteDmMessagesByIds(OWNER, ['w1'])).rejects.toThrow('db');
      expect(listener).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
