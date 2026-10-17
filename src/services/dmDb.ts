import { type ParsedOrderEvent, parseStoredOrder } from '../utils/orderEvents';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';
import { getLocalDb } from './localDb';
import { retireDmOwner } from './dmOwnerGuard';
import type { MarmotEdit } from './marmotEdits';
import { MARMOT_WELCOME_KIND, protocolForWireKind, type DmProtocol } from '../utils/dmProtocol';

// Data-access layer for the `dm_messages` table in the encrypted local DB
// (#695). One row per decrypted DM, keyed by (owner, event_id) — `owner` is
// the signed-in account's pubkey, so multi-account devices keep each
// identity's rows separate (#848). Replaces the single-blob wrap cache whose
// whole-blob parse + re-decrypt froze the Messages tab for ~52s (see
// docs/DATA_STORAGE.adoc). All reads are indexed slice reads — never "load
// the whole inbox into JS".
//
// #850: this store is now the ONLY at-rest home for decrypted DM content.
// The plaintext AsyncStorage blobs (`nostr_dm_conv_v1_*` /
// `nostr_dm_inbox_v1_*`) are retired; what only they used to carry —
// deliveryStatus (#856), rumorId (#857) and the optimistic `local-` send
// rows — lives in the delivery_status / rumor_id columns and in rows whose
// event_id starts with LOCAL_DM_ID_PREFIX.

export interface DmMessageRow {
  /** Account pubkey this row belongs to — every query is scoped by it. */
  owner: string;
  eventId: string;
  conversation: string;
  createdAt: number;
  sender: string;
  content: string;
  /** True when we authored the message (sender === our pubkey). Stored rather
   * than derived so reads don't need our pubkey threaded through. */
  fromMe: boolean;
  /** The inner rumor / event kind (NIP-17 text = 14, file = 15, legacy NIP-04
   * = 4). Load-bearing: the inbox NIP-04/NIP-17 dedup keys on it. */
  wireKind: number;
  /** Per-relay delivery breakdown for our own sent rows (#856). Persisted so
   * the tick survives a cold restart without any plaintext side blob. */
  deliveryStatus?: DeliveryStatus;
  /** NIP-17 inner-rumor event id (#857) — the delivery-store key, stable
   * across the optimistic local- row and the relay echo. Sent rows only. */
  rumorId?: string;
  /** Explicit thread protocol (Marmot). Absent = derived from `wireKind`. */
  protocol?: DmProtocol;
  /** Marmot reply: id of the message this one quotes. */
  replyTo?: string;
  /** Marmot edit: `created_at` of the edit `content` now holds. */
  editedAt?: number;
  /** Marmot edit: id of that edit event (breaks `editedAt` ties). */
  editId?: string;
}

/** Post-commit updates: consumers must not resolve wraps before their rows exist. */
type DmStorageListener = (owner: string, rows: readonly DmMessageRow[]) => void;
const dmStorageListeners = new Set<DmStorageListener>();
/** `rows` are the committed rows for `owner` (empty when not row-specific). */
export function subscribeDmStorage(listener: DmStorageListener): () => void {
  dmStorageListeners.add(listener);
  return () => {
    dmStorageListeners.delete(listener);
  };
}

/** Row deletions, kept apart from upserts so the inbox can drop removed
 * rows without re-rendering on every write. Fired after the deletes land. */
type DmDeletionListener = (owner: string, eventIds: readonly string[]) => void;
const dmDeletionListeners = new Set<DmDeletionListener>();
export function subscribeDmDeletions(listener: DmDeletionListener): () => void {
  dmDeletionListeners.add(listener);
  return () => {
    dmDeletionListeners.delete(listener);
  };
}

function notifyDmDeletions(owner: string, eventIds: readonly string[]): void {
  for (const listener of dmDeletionListeners) {
    try {
      listener(owner, eventIds);
    } catch {
      // A consumer failure must not turn a committed delete into a failed one.
    }
  }
}

function notifyDmStorage(rows: readonly DmMessageRow[]): void {
  for (const owner of new Set(rows.map((row) => row.owner))) {
    const ownerRows = rows.filter((row) => row.owner === owner);
    for (const listener of dmStorageListeners) {
      try {
        listener(owner, ownerRows);
      } catch {
        // A consumer failure must not turn a committed write into a failed one.
      }
    }
  }
}

/** SQL for a row's effective protocol — mirrors `protocolForWireKind`. */
const PROTOCOL_SQL = `COALESCE(protocol, CASE WHEN wire_kind = 4 THEN 'nip04' ELSE 'nip17' END)`;
const isDmProtocol = (v: unknown): v is DmProtocol =>
  v === 'nip04' || v === 'nip17' || v === 'marmot';

/** Prefix of the optimistic send rows ConversationScreen appends before the
 * relay echo lands. Kept as first-class rows (#850) so a send survives a cold
 * restart; `upsertDmMessages` retires them when their echo arrives. */
export const LOCAL_DM_ID_PREFIX = 'local-';

/** Window in seconds to match a real-id echo against a pending optimistic
 * local- row (same fromMe + same text). Single source of truth for both the
 * in-memory merge (nostrDmCache) and the store-level echo retire below. */
export const LOCAL_DM_ECHO_WINDOW_SECS = 30;

// SQLite caps bound variables per statement (historically 999). Chunk IN()
// lists well under that.
const VAR_CHUNK = 500;

const parseDeliveryStatus = (raw: unknown): DeliveryStatus | undefined => {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as DeliveryStatus;
    }
  } catch {
    // Corrupt JSON → treat as no status (tick simply doesn't render).
  }
  return undefined;
};

const serializeDeliveryStatus = (s: DeliveryStatus | undefined): string | null => {
  if (!s) return null;
  try {
    return JSON.stringify(s);
  } catch {
    return null;
  }
};

const toRow = (r: Record<string, unknown>): DmMessageRow => {
  const deliveryStatus = parseDeliveryStatus(r.delivery_status);
  const rumorId = typeof r.rumor_id === 'string' && r.rumor_id.length > 0 ? r.rumor_id : undefined;
  return {
    owner: String(r.owner),
    eventId: String(r.event_id),
    conversation: String(r.conversation),
    createdAt: Number(r.created_at),
    sender: String(r.sender),
    content: String(r.content),
    fromMe: Number(r.from_me) === 1,
    wireKind: Number(r.wire_kind),
    ...(deliveryStatus !== undefined ? { deliveryStatus } : {}),
    ...(rumorId !== undefined ? { rumorId } : {}),
    ...(isDmProtocol(r.protocol) ? { protocol: r.protocol } : {}),
    ...(typeof r.reply_to === 'string' && r.reply_to.length > 0 ? { replyTo: r.reply_to } : {}),
    ...(r.edited_at != null && Number(r.edited_at) > 0 ? { editedAt: Number(r.edited_at) } : {}),
    ...(typeof r.edit_id === 'string' && r.edit_id.length > 0 ? { editId: r.edit_id } : {}),
  };
};

/** SQL (upsert): the stored row's edit outranks the incoming copy's — a later
 * `edited_at`, or the same one with a higher-or-equal edit id (isNewerEdit). */
const KEEP_STORED_EDIT = `dm_messages.edited_at IS NOT NULL AND (excluded.edited_at IS NULL
  OR excluded.edited_at < dm_messages.edited_at
  OR (excluded.edited_at = dm_messages.edited_at
      AND COALESCE(excluded.edit_id, '') <= COALESCE(dm_messages.edit_id, '')))`;

/**
 * Of the given event ids, which are already stored for this owner. This is
 * the decrypt-once gate: ingest checks this first and only decrypts wraps we
 * haven't seen, instead of re-decrypting the whole inbox on every refresh.
 */
export async function selectKnownEventIds(owner: string, eventIds: string[]): Promise<Set<string>> {
  const known = new Set<string>();
  if (eventIds.length === 0) return known;
  const db = await getLocalDb();
  for (let i = 0; i < eventIds.length; i += VAR_CHUNK) {
    const slice = eventIds.slice(i, i + VAR_CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const res = await db.execute(
      `SELECT event_id FROM dm_messages WHERE owner = ? AND event_id IN (${placeholders});`,
      [owner, ...slice],
    );
    for (const r of res.rows ?? []) known.add(String(r.event_id));
  }
  return known;
}

// Minimal shape shared by the DB handle and a transaction context — both
// expose `execute`, which is all the upsert body needs.
type Executor = {
  execute: (
    sql: string,
    params?: (string | number | null)[],
  ) => Promise<{
    rows?: Record<string, unknown>[];
  }>;
};

async function upsertOne(tx: Executor, m: DmMessageRow): Promise<void> {
  let deliveryStatus = m.deliveryStatus;
  let rumorId = m.rumorId;
  // Echo retire (#850, mirrors mergeConversationMessages): a real-id row we
  // authored replaces its pending optimistic local- row — inherit the local-
  // row's delivery tick (#856) + rumorId (#857) when the echo lacks its own,
  // then delete the local- row so the store never shows two bubbles for one
  // send. Only sent rows can match (local- rows are always fromMe).
  if (m.fromMe && !m.eventId.startsWith(LOCAL_DM_ID_PREFIX)) {
    // BETWEEN (not ABS(created_at - ?)) keeps the time-window predicate
    // sargable, so the (owner, conversation, created_at) index narrows the
    // scan as the table grows. Same ±LOCAL_DM_ECHO_WINDOW_SECS rule.
    const res = await tx.execute(
      `SELECT event_id, delivery_status, rumor_id, created_at FROM dm_messages
        WHERE owner = ? AND conversation = ? AND from_me = 1
          AND (content = ? OR (rumor_id IS NOT NULL AND rumor_id = ?))
          AND event_id LIKE '${LOCAL_DM_ID_PREFIX}%'
          AND ${PROTOCOL_SQL} = ?
          AND created_at BETWEEN ? - ${LOCAL_DM_ECHO_WINDOW_SECS} AND ? + ${LOCAL_DM_ECHO_WINDOW_SECS};`,
      // Same protocol only: threads are split per protocol.
      [
        m.owner,
        m.conversation,
        m.content,
        // Or the same send by rumor id: a Marmot edit (#1237) may have changed
        // the local row's text before its original is replayed.
        m.rumorId ?? null,
        protocolForWireKind(m.wireKind, m.protocol),
        m.createdAt,
        m.createdAt,
      ],
    );
    const candidates = res.rows ?? [];
    if (candidates.length > 0) {
      // Closest-in-time match wins, mirroring the in-memory merge.
      const best = candidates.reduce((a, b) =>
        Math.abs(Number(a.created_at) - m.createdAt) <= Math.abs(Number(b.created_at) - m.createdAt)
          ? a
          : b,
      );
      deliveryStatus = deliveryStatus ?? parseDeliveryStatus(best.delivery_status);
      rumorId =
        rumorId ??
        (typeof best.rumor_id === 'string' && best.rumor_id.length > 0 ? best.rumor_id : undefined);
      await tx.execute(`DELETE FROM dm_messages WHERE owner = ? AND event_id = ?;`, [
        m.owner,
        String(best.event_id),
      ]);
    }
  }
  // COALESCE keeps an existing tick/rumorId when a later re-ingest of the
  // same event id supplies neither (#856/#857: a warm relay re-decrypt of an
  // already-ticked echo must not strip the tick).
  await tx.execute(
    `INSERT INTO dm_messages
       (owner, event_id, conversation, created_at, sender, content, from_me, wire_kind,
        delivery_status, rumor_id, protocol, reply_to, edited_at, edit_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, event_id) DO UPDATE SET
       protocol        = COALESCE(excluded.protocol, dm_messages.protocol),
       conversation    = excluded.conversation,
       created_at      = excluded.created_at,
       sender          = excluded.sender,
       -- An edited message keeps its edit when the original is re-ingested
       -- (the history replays on every start): only a newer edit changes it.
       content         = CASE WHEN ${KEEP_STORED_EDIT} THEN dm_messages.content ELSE excluded.content END,
       edited_at       = CASE WHEN ${KEEP_STORED_EDIT} THEN dm_messages.edited_at ELSE excluded.edited_at END,
       edit_id         = CASE WHEN ${KEEP_STORED_EDIT} THEN dm_messages.edit_id ELSE excluded.edit_id END,
       reply_to        = COALESCE(excluded.reply_to, dm_messages.reply_to),
       from_me         = excluded.from_me,
       wire_kind       = excluded.wire_kind,
       delivery_status = COALESCE(excluded.delivery_status, dm_messages.delivery_status),
       rumor_id        = COALESCE(excluded.rumor_id, dm_messages.rumor_id);`,
    [
      m.owner,
      m.eventId,
      m.conversation,
      m.createdAt,
      m.sender,
      m.content,
      m.fromMe ? 1 : 0,
      m.wireKind,
      serializeDeliveryStatus(deliveryStatus),
      rumorId ?? null,
      m.protocol ?? null,
      m.replyTo ?? null,
      m.editedAt ?? null,
      m.editId ?? null,
    ],
  );
}

/**
 * Upsert decrypted messages. Idempotent by (owner, event_id) and batched in
 * one transaction so a large first-sync is a single commit, not N. Retires
 * matched optimistic local- rows (see `upsertOne`) and never downgrades an
 * existing delivery tick / rumorId to NULL.
 */
export async function upsertDmMessages(rows: readonly DmMessageRow[]): Promise<void> {
  await writeDmMessages(rows);
}

/**
 * `upsertDmMessages` for a write that may outlive its account (a background
 * save): `persistIf` is checked inside the write transaction, and false writes
 * nothing. Wipes are transactions too, so a wipe either lands first (and this
 * sees its epoch) or runs after this write and removes it. Returns whether it
 * wrote.
 */
export function upsertDmMessagesIf(
  rows: readonly DmMessageRow[],
  persistIf: () => boolean,
): Promise<boolean> {
  return writeDmMessages(rows, persistIf);
}

async function writeDmMessages(
  rows: readonly DmMessageRow[],
  persistIf?: () => boolean,
): Promise<boolean> {
  if (rows.length === 0) return false;
  const db = await getLocalDb();
  let written = false;
  await db.transaction(async (tx) => {
    if (persistIf?.() === false) return;
    for (const m of rows) await upsertOne(tx as Executor, m);
    written = true;
  });
  if (written) notifyDmStorage(rows);
  return written;
}

/** Import a legacy misfiled group row only if neither its wrap nor its rumor
 * already exists in the direct thread. Keep the check and write in one SQL
 * transaction; existing delivery status and edited content always win. */
export async function importRepairedDmMessage(row: DmMessageRow): Promise<void> {
  const db = await getLocalDb();
  await db.transaction(async (tx) => {
    const existing = await tx.execute(
      `SELECT event_id FROM dm_messages
        WHERE owner = ? AND conversation = ? AND ${PROTOCOL_SQL} = 'nip17'
          AND (event_id = ? OR (? IS NOT NULL AND rumor_id = ?)) LIMIT 1;`,
      [row.owner, row.conversation, row.eventId, row.rumorId ?? null, row.rumorId ?? null],
    );
    if (!existing.rows?.length) await upsertOne(tx as Executor, row);
  });
  notifyDmStorage([row]);
}

/**
 * Import rows without clobbering anything already stored (#850 blob
 * migration): an existing row's content/metadata always wins; the import only
 * fills a missing delivery_status / rumor_id (the two fields the retired
 * plaintext conversation blobs were the sole carrier of). New ids insert
 * whole. One transaction.
 */
export async function importDmMessages(rows: readonly DmMessageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await getLocalDb();
  await db.transaction(async (tx) => {
    for (const m of rows) {
      await tx.execute(
        `INSERT INTO dm_messages
           (owner, event_id, conversation, created_at, sender, content, from_me, wire_kind,
            delivery_status, rumor_id, protocol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner, event_id) DO UPDATE SET
           delivery_status = COALESCE(dm_messages.delivery_status, excluded.delivery_status),
           rumor_id        = COALESCE(dm_messages.rumor_id, excluded.rumor_id);`,
        [
          m.owner,
          m.eventId,
          m.conversation,
          m.createdAt,
          m.sender,
          m.content,
          m.fromMe ? 1 : 0,
          m.wireKind,
          serializeDeliveryStatus(m.deliveryStatus),
          m.rumorId ?? null,
          m.protocol ?? null,
        ],
      );
    }
  });
  notifyDmStorage(rows);
}

/**
 * Attach delivery statuses (#856) to stored rows by event id, filling only
 * rows that don't already carry one — mirrors the old persisted-blob rule
 * ("only write when it adds a tick") so a settled breakdown is never
 * overwritten by a later, thinner snapshot.
 */
export async function updateDmDeliveryStatuses(
  owner: string,
  statusById: Record<string, DeliveryStatus>,
): Promise<void> {
  const entries = Object.entries(statusById);
  if (entries.length === 0) return;
  const db = await getLocalDb();
  await db.transaction(async (tx) => {
    for (const [eventId, status] of entries) {
      const serialized = serializeDeliveryStatus(status);
      if (!serialized) continue;
      await tx.execute(
        `UPDATE dm_messages SET delivery_status = ?
          WHERE owner = ? AND event_id = ? AND delivery_status IS NULL;`,
        [serialized, owner, eventId],
      );
    }
  });
}

/**
 * One conversation's messages, newest-first, paginated. `beforeCreatedAt`
 * pages backwards (load-older). Uses the (owner, conversation, created_at)
 * index — O(result), no whole-table scan, no whole-blob parse.
 */
export async function getConversationMessages(
  owner: string,
  conversation: string,
  opts: { limit?: number; beforeCreatedAt?: number; protocol?: DmProtocol } = {},
): Promise<DmMessageRow[]> {
  const db = await getLocalDb();
  const limit = opts.limit ?? 50;
  const params: (string | number)[] = [owner, conversation];
  let sql = `SELECT * FROM dm_messages WHERE owner = ? AND conversation = ?`;
  // Per-protocol thread (#1118): filter BEFORE the LIMIT so one protocol's
  // newer history can't use up the other thread's whole slice.
  if (opts.protocol) {
    sql += ` AND ${PROTOCOL_SQL} = ?`;
    params.push(opts.protocol);
  }
  if (opts.beforeCreatedAt != null) {
    sql += ` AND created_at < ?`;
    params.push(opts.beforeCreatedAt);
  }
  sql += ` ORDER BY created_at DESC LIMIT ?;`;
  params.push(limit);
  const res = await db.execute(sql, params);
  return (res.rows ?? []).map(toRow);
}

/** Bounded indexed local history around a tapped message, scoped to account/peer/protocol. */
export async function getConversationMessageWindow(
  owner: string,
  conversation: string,
  protocol: DmProtocol,
  eventId: string,
): Promise<DmMessageRow[]> {
  const db = await getLocalDb();
  const target = await db.execute(
    `SELECT * FROM dm_messages WHERE owner = ? AND conversation = ? AND ${PROTOCOL_SQL} = ? AND event_id = ? LIMIT 1;`,
    [owner, conversation, protocol, eventId],
  );
  const at = target.rows?.[0]?.created_at;
  if (at == null) return [];
  const result = await db.execute(
    `SELECT * FROM (SELECT * FROM dm_messages WHERE owner = ? AND conversation = ? AND ${PROTOCOL_SQL} = ? AND created_at <= ? ORDER BY created_at DESC LIMIT 30)
     UNION SELECT * FROM (SELECT * FROM dm_messages WHERE owner = ? AND conversation = ? AND ${PROTOCOL_SQL} = ? AND created_at > ? ORDER BY created_at ASC LIMIT 20);`,
    [owner, conversation, protocol, Number(at), owner, conversation, protocol, Number(at)],
  );
  // Include the exact target even if many messages share its timestamp.
  const rows = new Map((result.rows ?? []).map((r) => [String(r.event_id), toRow(r)]));
  const tapped = toRow(target.rows![0]);
  rows.set(tapped.eventId, tapped);
  return [...rows.values()];
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * The owner's OWN kind-16 rows in one conversation whose stored order JSON
 * carries one of `orderIds` — the targeted read that lets a merchant's payment
 * request bind to an outgoing order OLDER than the loaded thread slice
 * (DM_CONV_CAP), so an old order stays payable (#948). Content is the
 * canonical `serializeOrder` JSON, so a substring match on the
 * `"orderId":"…"` pair is a cheap pre-filter — callers still parse and compare
 * the id exactly. Scoped by owner + conversation + from_me, so a merchant
 * can't plant a row that satisfies it.
 */
export async function getOutgoingOrderRows(
  owner: string,
  conversation: string,
  orderIds: readonly string[],
): Promise<DmMessageRow[]> {
  if (orderIds.length === 0) return [];
  const db = await getLocalDb();
  const out: DmMessageRow[] = [];
  for (let i = 0; i < orderIds.length; i += VAR_CHUNK) {
    const chunk = orderIds.slice(i, i + VAR_CHUNK);
    const likes = chunk.map(() => `content LIKE ? ESCAPE '\\'`).join(' OR ');
    const res = await db.execute(
      `SELECT * FROM dm_messages
        WHERE owner = ? AND conversation = ? AND from_me = 1 AND wire_kind = 16
          AND (${likes})
        ORDER BY created_at DESC;`,
      [owner, conversation, ...chunk.map((id) => `%"orderId":"${escapeLike(id)}"%`)],
    );
    for (const r of res.rows ?? []) out.push(toRow(r));
  }
  return out;
}

/** Whether this account received a placed order from this buyer, on any device.
 * Target the buyer/order pair directly so older orders remain eligible even
 * outside the bounded seller list. Invalid legacy JSON cannot satisfy admission.
 */
export async function hasIncomingOrder(
  owner: string,
  buyer: string,
  orderId: string,
): Promise<boolean> {
  const db = await getLocalDb();
  const content = "CASE WHEN json_valid(content) THEN content ELSE '{}' END";
  const res = await db.execute(
    `SELECT 1 FROM dm_messages
      WHERE owner = ? AND conversation = ? AND sender = ?
        AND from_me = 0 AND wire_kind = 16
        AND json_extract(${content}, '$.type') = 'order'
        AND json_extract(${content}, '$.orderId') = ?
      LIMIT 1;`,
    [owner, buyer, buyer, orderId],
  );
  return (res.rows?.length ?? 0) > 0;
}

/** Bound for the seller Orders read — number of placed orders, not rows. */
export const SHOP_ORDER_ROW_LIMIT = 500;

/**
 * Seller history is bounded by the newest incoming placed orders. Retrieve
 * the first placed order and latest row per lifecycle type/direction for those buyer/order pairs.
 * At most twelve rows per order reach the seller screen, even for legacy floods;
 * updates and receipts cannot push the placed order or invoice out of the list.
 * The caller keeps only orders for the seller's own listings.
 */
export async function getShopOrderRows(
  owner: string,
  limit = SHOP_ORDER_ROW_LIMIT,
): Promise<DmMessageRow[]> {
  const db = await getLocalDb();
  const content = "CASE WHEN json_valid(content) THEN content ELSE '{}' END";
  const res = await db.execute(
    `WITH placed AS (
      SELECT conversation, json_extract(${content}, '$.orderId') AS order_id
      FROM dm_messages
      WHERE owner = ? AND sender = conversation AND from_me = 0 AND wire_kind = 16
        AND json_extract(${content}, '$.type') = 'order'
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?
    ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY conversation, json_extract(${content}, '$.orderId'),
        json_extract(${content}, '$.type'), from_me,
        CASE WHEN json_extract(${content}, '$.type') = 'status'
          AND json_extract(${content}, '$.status') = 'cancelled' THEN 1 ELSE 0 END
      ORDER BY
        CASE WHEN json_extract(${content}, '$.type') = 'order' THEN created_at END ASC,
        CASE WHEN json_extract(${content}, '$.type') = 'order' THEN event_id END ASC,
        created_at DESC, event_id DESC
    ) AS lifecycle_rank FROM dm_messages
      WHERE owner = ? AND wire_kind IN (16, 17)
        AND EXISTS (
          SELECT 1 FROM placed
          WHERE placed.conversation = dm_messages.conversation
            AND placed.order_id = json_extract(${content}, '$.orderId')
            AND ((from_me = 1 AND sender = owner) OR
                 (from_me = 0 AND sender = placed.conversation))
        )
        AND json_extract(${content}, '$.type') IN ('order', 'payment', 'status', 'shipping', 'receipt')
    )
    SELECT * FROM ranked WHERE lifecycle_rank = 1
      ORDER BY created_at DESC, event_id DESC;`,
    [owner, Math.max(1, Math.min(2000, Math.floor(limit))), owner],
  );
  return (res.rows ?? []).map(toRow);
}

/**
 * Buyer history is bounded by the newest placed orders, never by lifecycle
 * row count. Retain each distinct payment request for settlement correlation,
 * plus the first order and latest other lifecycle rows, so invoice replacements
 * cannot hide a successful payment of an earlier invoice.
 * Invalid legacy JSON is ignored without aborting the read.
 */
export async function getOrderRows(owner: string, limit = 500): Promise<DmMessageRow[]> {
  const db = await getLocalDb();
  const content = "CASE WHEN json_valid(content) THEN content ELSE '{}' END";
  const res = await db.execute(
    `WITH placed AS (
      SELECT conversation, json_extract(${content}, '$.orderId') AS order_id
      FROM dm_messages
      WHERE owner = ? AND sender = ? AND from_me = 1 AND wire_kind = 16
        AND json_extract(${content}, '$.type') = 'order'
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?
    ), ranked AS (
    SELECT *, ROW_NUMBER() OVER (
      PARTITION BY conversation, json_extract(${content}, '$.orderId'),
        json_extract(${content}, '$.type'), from_me,
        CASE WHEN json_extract(${content}, '$.type') = 'payment'
          THEN json_extract(${content}, '$.payment.value') ELSE '' END,
        CASE WHEN json_extract(${content}, '$.type') = 'status'
          AND json_extract(${content}, '$.status') = 'cancelled' THEN 1 ELSE 0 END
      ORDER BY
        CASE WHEN json_extract(${content}, '$.type') = 'order' THEN created_at END ASC,
        CASE WHEN json_extract(${content}, '$.type') = 'order' THEN event_id END ASC,
        created_at DESC, event_id DESC
    ) AS lifecycle_rank FROM dm_messages
      WHERE owner = ? AND wire_kind IN (16, 17)
        AND EXISTS (
          SELECT 1 FROM placed
          WHERE placed.conversation = dm_messages.conversation
            AND placed.order_id = json_extract(${content}, '$.orderId')
            AND ((from_me = 1 AND sender = owner) OR
                 (from_me = 0 AND sender = placed.conversation))
        )
        AND json_extract(${content}, '$.type') IN ('order', 'payment', 'status', 'shipping', 'receipt')
    )
    SELECT * FROM ranked WHERE lifecycle_rank = 1
      ORDER BY created_at DESC, event_id DESC;`,
    [owner, owner, Math.max(1, Math.min(2000, Math.floor(limit))), owner],
  );
  return (res.rows ?? []).map(toRow);
}

/**
 * The latest message in each of this owner's conversations, newest-first —
 * the inbox list. This is the read that replaces the whole-inbox blob parse:
 * the DB does the per-conversation MAX in one indexed query instead of JS
 * walking everything. A conversation is (partner, protocol): NIP-04 rows
 * (wire_kind 4) and NIP-17 rows each get their own latest row, so a partner
 * with both shows two inbox threads (see `protocolForWireKind`). Marmot
 * invite gift wraps (kind 444) never count as a thread's latest: the joined
 * chat shows on its own, and failed ones come from the Marmot session (#1269).
 */
export async function getInboxLatest(owner: string): Promise<DmMessageRow[]> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT m.* FROM dm_messages m
       JOIN (
         SELECT conversation, ${PROTOCOL_SQL} AS proto, MAX(created_at) AS mx
         FROM dm_messages WHERE owner = ? AND wire_kind NOT IN (${MARMOT_WELCOME_KIND})
         GROUP BY conversation, ${PROTOCOL_SQL}
       ) g ON m.conversation = g.conversation
          AND COALESCE(m.protocol, CASE WHEN m.wire_kind = 4 THEN 'nip04' ELSE 'nip17' END) = g.proto
          AND m.created_at = g.mx
     WHERE m.owner = ? AND m.wire_kind NOT IN (${MARMOT_WELCOME_KIND})
     ORDER BY m.created_at DESC;`,
    [owner, owner],
  );
  return (res.rows ?? []).map(toRow);
}

/**
 * Whether this owner has ANY stored message for `conversation` — the
 * live-sub's "is this marketplace partner already a conversation?" trust
 * check (#850; replaces scanning the retired plaintext inbox blob).
 */
/** The conversation (and its protocol's wire kind) a stored event belongs to —
 * for NIP-17 the event id is the gift-wrap id. Null until it's been stored. */
export async function getConversationForEvent(
  owner: string,
  eventId: string,
): Promise<{
  conversation: string;
  wireKind: number;
  protocol?: DmProtocol;
  fromMe: boolean;
  orderId?: string;
  orderType?: ParsedOrderEvent['type'];
  orderStatus?: string;
} | null> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT conversation, wire_kind, protocol, from_me, content FROM dm_messages
      WHERE owner = ? AND event_id = ? LIMIT 1;`,
    [owner, eventId],
  );
  const row = (res.rows ?? [])[0];
  if (!row) return null;
  const order =
    Number(row.wire_kind) === 16 || Number(row.wire_kind) === 17
      ? parseStoredOrder(String(row.content))
      : null;
  return {
    ...(order ? { orderId: order.orderId, orderType: order.type, orderStatus: order.status } : {}),
    conversation: String(row.conversation),
    wireKind: Number(row.wire_kind),
    fromMe: Number(row.from_me) === 1,
    ...(isDmProtocol(row.protocol) ? { protocol: row.protocol } : {}),
  };
}

export async function hasConversationWith(owner: string, conversation: string): Promise<boolean> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT 1 AS present FROM dm_messages WHERE owner = ? AND conversation = ? LIMIT 1;`,
    [owner, conversation],
  );
  return (res.rows ?? []).length > 0;
}

/** Kinds of a sent row that count as replying in a 1:1 thread (#1623): text
 * and files. Orders, invites and other structured rows don't. */
export const REPLY_WIRE_KINDS: readonly number[] = [4, 14, 15];

/** Everyone this owner has sent a 1:1 message to (#1623), any protocol. */
export async function selectRepliedConversations(owner: string): Promise<string[]> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT DISTINCT conversation FROM dm_messages
      WHERE owner = ? AND from_me = 1 AND wire_kind IN (${REPLY_WIRE_KINDS.join(', ')})
        AND event_id NOT LIKE '${LOCAL_DM_ID_PREFIX}%';`,
    [owner],
  );
  return (res.rows ?? []).map((r) => String(r.conversation));
}

/**
 * All stored NIP-17 wrap ids for this owner (kind-4 rows excluded — their ids
 * are kind-4 event ids, not wrap ids; optimistic local- rows excluded — their
 * ids are synthetic, never relay-delivered). Seeds the live-DM sub's
 * in-memory dedup Set so a relay backlog re-stream short-circuits without
 * re-decrypting (#505/#848). Ids only — no plaintext leaves the DB here.
 */
export async function selectDmWrapIds(owner: string): Promise<string[]> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT event_id FROM dm_messages
      WHERE owner = ? AND ${PROTOCOL_SQL} = 'nip17'
        AND event_id NOT LIKE '${LOCAL_DM_ID_PREFIX}%';`,
    [owner],
  );
  return (res.rows ?? []).map((r) => String(r.event_id));
}

/**
 * Whether this owner has ANY stored NIP-17 rows — i.e. an inbox-wide wrap
 * ingest has run before. Thread opens use this to decide whether the
 * inbox-wide relay wrap fetch can be skipped (the DB already memoises every
 * decrypted wrap), mirroring the old "cache has any entries" fast path (#190).
 * Optimistic local- rows don't count — a first-ever send must not fake a
 * completed ingest (#850).
 */
export async function hasStoredWraps(owner: string): Promise<boolean> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT 1 AS present FROM dm_messages
      WHERE owner = ? AND ${PROTOCOL_SQL} = 'nip17'
        AND event_id NOT LIKE '${LOCAL_DM_ID_PREFIX}%' LIMIT 1;`,
    [owner],
  );
  return (res.rows ?? []).length > 0;
}

/**
 * Delete `owner`'s Marmot rows of the given inner kinds — clears non-message
 * events (push tokens, reactions, …) stored before they were filtered out.
 */
export async function deleteMarmotRowsOfKinds(owner: string, kinds: readonly number[]) {
  if (kinds.length === 0) return;
  const db = await getLocalDb();
  await db.execute(
    `DELETE FROM dm_messages WHERE owner = ? AND protocol = 'marmot' AND wire_kind IN (${kinds
      .map(() => '?')
      .join(', ')});`,
    [owner, ...kinds],
  );
}

/**
 * Apply Marmot edits in one transaction: each replaces the text of `owner`'s
 * Marmot chat message `target` — only when `editor` wrote it, it's a text row,
 * and the edit outranks any already applied (later `editedAt`, ties to the
 * higher edit id — isNewerEdit). Resolves the edits that changed a row, with
 * the conversation each belongs to.
 */
export async function applyMarmotEdits(
  owner: string,
  edits: readonly MarmotEdit[],
): Promise<{ edit: MarmotEdit; conversation: string }[]> {
  if (edits.length === 0) return [];
  const db = await getLocalDb();
  const changed: { edit: MarmotEdit; conversation: string }[] = [];
  await db.transaction(async (tx) => {
    for (const edit of edits) {
      const res = await tx.execute(
        `UPDATE dm_messages SET content = ?, edited_at = ?, edit_id = ?
          WHERE owner = ? AND (event_id = ? OR rumor_id = ?) AND protocol = 'marmot'
            AND sender = ? AND wire_kind = 14
            AND (edited_at IS NULL OR edited_at < ?
                 OR (edited_at = ? AND COALESCE(edit_id, '') < ?))
          RETURNING conversation;`,
        [
          edit.content,
          edit.editedAt,
          edit.editId,
          owner,
          edit.target,
          // Our own send keeps a `local-` row id until the replay, but carries the id here.
          edit.target,
          edit.editor,
          edit.editedAt,
          edit.editedAt,
          edit.editId,
        ],
      );
      const conversation = res.rows?.[0]?.conversation;
      if (conversation != null) changed.push({ edit, conversation: String(conversation) });
    }
  });
  return changed;
}

/** Row ids "delete for everyone" removed this session — so an open thread's
 * in-memory copy of an optimistic `local-` send (kept across reloads until its
 * echo lands, see keepPendingLocalRows) is dropped, not resurrected (#1237). */
const deletedRowIds = new Set<string>();
const DELETED_ROW_CAP = 500;

/** Whether `rowId` was removed by a Marmot "delete for everyone" this session. */
export const wasDmRowDeleted = (rowId: string): boolean => deletedRowIds.has(rowId);

/**
 * Delete `owner`'s Marmot rows with these message ids in one conversation — a
 * "delete for everyone". `sender` restricts it to messages that account wrote
 * (the author check lives in the SQL, so a peer can never remove a message they
 * didn't send); pass null for an admin removal, which may take any member's.
 */
export async function deleteMarmotMessages(
  owner: string,
  conversation: string,
  messageIds: readonly string[],
  sender: string | null,
): Promise<string[]> {
  if (messageIds.length === 0) return [];
  const db = await getLocalDb();
  const deleted: string[] = [];
  // Matched by rumor id too, so our own optimistic `local-` send row goes with
  // it (#1237). Each id binds twice: half-size chunks.
  const step = VAR_CHUNK / 2;
  for (let i = 0; i < messageIds.length; i += step) {
    const slice = messageIds.slice(i, i + step);
    const ids = slice.map(() => '?').join(',');
    const result = await db.execute(
      `DELETE FROM dm_messages WHERE owner = ? AND protocol = 'marmot' AND conversation = ?
         ${sender === null ? '' : 'AND sender = ?'}
         AND (event_id IN (${ids}) OR rumor_id IN (${ids})) RETURNING event_id;`,
      [owner, conversation, ...(sender === null ? [] : [sender]), ...slice, ...slice],
    );
    deleted.push(...(result.rows ?? []).map((row) => String(row.event_id)));
  }
  for (const id of deleted) {
    deletedRowIds.delete(id); // re-insert → newest in eviction order
    deletedRowIds.add(id);
  }
  while (deletedRowIds.size > DELETED_ROW_CAP) {
    deletedRowIds.delete(deletedRowIds.values().next().value as string);
  }
  return deleted;
}

/**
 * Delete every row belonging to `owner` — the per-account half of the logout
 * wipe (#848). When the LAST identity signs out, NostrContext additionally
 * calls `wipeLocalDmStore` (localDb) to delete the DB file + keystore key.
 */
export async function deleteDmMessagesForOwner(owner: string): Promise<void> {
  retireDmOwner(owner); // before the DELETE: in-flight writes must see it
  const db = await getLocalDb();
  // A transaction, so it's ordered against upserts (see upsertDmMessages).
  await db.transaction(async (tx) => {
    await tx.execute(`DELETE FROM dm_messages WHERE owner = ?;`, [owner]);
  });
}

/** Relay-delivered rows of one inner kind (event id = wrap id for NIP-17). */
export async function selectDmEventIdsOfKind(owner: string, wireKind: number): Promise<string[]> {
  const db = await getLocalDb();
  const res = await db.execute(
    `SELECT event_id FROM dm_messages
      WHERE owner = ? AND wire_kind = ? AND event_id NOT LIKE '${LOCAL_DM_ID_PREFIX}%' LIMIT 200;`,
    [owner, wireKind],
  );
  return (res.rows ?? []).map((r) => String(r.event_id));
}

/** Delete rows by event id (a misfiled rumor moved elsewhere). */
export async function deleteDmMessagesByIds(
  owner: string,
  eventIds: readonly string[],
): Promise<void> {
  if (eventIds.length === 0) return;
  const db = await getLocalDb();
  for (let i = 0; i < eventIds.length; i += VAR_CHUNK) {
    const slice = eventIds.slice(i, i + VAR_CHUNK);
    await db.execute(
      `DELETE FROM dm_messages WHERE owner = ? AND event_id IN (${slice.map(() => '?').join(',')});`,
      [owner, ...slice],
    );
  }
  notifyDmStorage(eventIds.map((eventId) => ({ owner, eventId }) as DmMessageRow));
  notifyDmDeletions(owner, eventIds);
}
