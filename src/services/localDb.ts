import { open, type DB } from '@op-engineering/op-sqlite';
import { getOrCreateLocalDbKey, clearLocalDbKey } from './localDbKey';

// The single encrypted local database (#695). SQLCipher is enabled as the
// op-sqlite compile target (package.json "op-sqlite": { "sqlcipher": true }),
// so passing `encryptionKey` to open() transparently encrypts the whole file
// — content and metadata — with the Keystore-held key (see localDbKey.ts).
// One DB, indexed rows: DM messages (private) plus public cached events.
const DB_NAME = 'lightningpiggy.db';

// Schema v3 (#848, extended by #850). One row per decrypted DM event, scoped
// by `owner` (the signed-in account's pubkey): multi-account devices share one
// DB file, and a kind-4 DM between two local accounts is the SAME event id
// seen by both — so the primary key is (owner, event_id), not event_id alone.
// Indexed by (owner, conversation, created_at) for paginated slice reads — the
// whole point of moving off the single-blob cache that froze the Messages tab
// (#695). Public cache tables (caches/events/places) land in a later slice.
//
// #850 columns — everything the retired plaintext AsyncStorage blobs
// (`nostr_dm_conv_v1_*` / `nostr_dm_inbox_v1_*`) were previously the only
// home for, so conversations + inbox now serve PURELY from this store:
//   delivery_status — JSON-serialised DeliveryStatus (#856) for our own sent
//                     rows (per-relay tick breakdown). NULL on received rows.
//   rumor_id        — NIP-17 inner-rumor event id (#857), stable across the
//                     optimistic local- row and the relay echo; keys the
//                     delivery-status store. NULL on received / legacy rows.
// Optimistic sends persist as rows whose event_id starts with 'local-' until
// the relay echo replaces them (upsertDmMessages deletes the matched local-
// row and carries its delivery_status / rumor_id onto the echo row).
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS dm_messages (
     owner           TEXT NOT NULL,
     event_id        TEXT NOT NULL,
     conversation    TEXT NOT NULL,
     created_at      INTEGER NOT NULL,
     sender          TEXT NOT NULL,
     content         TEXT NOT NULL,
     from_me         INTEGER NOT NULL DEFAULT 0,
     wire_kind       INTEGER NOT NULL DEFAULT 14,
     delivery_status TEXT,
     rumor_id        TEXT,
     protocol        TEXT,
     PRIMARY KEY (owner, event_id)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_dm_owner_conversation_created
     ON dm_messages (owner, conversation, created_at DESC);`,
  // Marmot (MLS) client state: group ratchet trees + epoch secrets, local
  // key-package private keys, invites (see marmotStore.ts). Unlike the rows
  // above this is NOT a rebuildable relay cache — losing it means being
  // re-invited to every Marmot group — which is also exactly what MLS wants
  // after a backup-restore wipe, since group state must never move devices.
  `CREATE TABLE IF NOT EXISTS marmot_kv (
     owner     TEXT NOT NULL,
     namespace TEXT NOT NULL,
     key       TEXT NOT NULL,
     value     TEXT NOT NULL,
     PRIMARY KEY (owner, namespace, key)
   );`,
  // Marmot "delete for everyone" tombstones (marmotDeletionStore.ts): which
  // message ids a member (or, with any_author, an admin) deleted in a group, so
  // a history replay can't bring them back. Capped per deleter, group and
  // owner; ordered by rowid for oldest-first eviction.
  `CREATE TABLE IF NOT EXISTS marmot_deletions (
     owner      TEXT NOT NULL,
     scope      TEXT NOT NULL,
     target     TEXT NOT NULL,
     deleter    TEXT NOT NULL,
     any_author INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (owner, scope, target, deleter)
   );`,
  `CREATE INDEX IF NOT EXISTS idx_marmot_deletions_target ON marmot_deletions (owner, target);`,
  `CREATE INDEX IF NOT EXISTS idx_marmot_deletions_deleter
     ON marmot_deletions (owner, scope, deleter);`,
  // NIP-171 epoch tickets addressed to this account (nip171Store.ts). Each
  // carries a group's shared epoch private key, so it lives only here, in the
  // encrypted DB. Keyed by the ticket's event id; one group has one row per
  // ticket it sent us (an epoch rotation is a new ticket).
  `CREATE TABLE IF NOT EXISTS nip171_tickets (
     owner        TEXT NOT NULL,
     event_id     TEXT NOT NULL,
     group_pubkey TEXT NOT NULL,
     epoch        INTEGER NOT NULL,
     created_at   INTEGER NOT NULL,
     epoch_secret TEXT NOT NULL,
     sig          TEXT NOT NULL,
     PRIMARY KEY (owner, event_id)
   );`,
];

// Columns added after the v2 table shipped (#850). SQLite supports in-place
// ADD COLUMN, so an existing install's table upgrades without a rebuild —
// its rows (the decrypt-once memo) are preserved.
const ADDED_COLUMNS: readonly { name: string; ddl: string }[] = [
  { name: 'delivery_status', ddl: 'ALTER TABLE dm_messages ADD COLUMN delivery_status TEXT;' },
  { name: 'rumor_id', ddl: 'ALTER TABLE dm_messages ADD COLUMN rumor_id TEXT;' },
  // Explicit thread protocol for transports whose inner kinds overlap NIP-17's
  // (Marmot). NULL = derive from wire_kind (4 → NIP-04, else NIP-17).
  { name: 'protocol', ddl: 'ALTER TABLE dm_messages ADD COLUMN protocol TEXT;' },
  // Marmot reply: id of the message this one quotes (NULL = not a reply).
  { name: 'reply_to', ddl: 'ALTER TABLE dm_messages ADD COLUMN reply_to TEXT;' },
  // Marmot edit: `created_at` of the edit whose text `content` now holds
  // (NULL = never edited). Orders competing edits; latest wins.
  { name: 'edited_at', ddl: 'ALTER TABLE dm_messages ADD COLUMN edited_at INTEGER;' },
  // Marmot edit: id of that edit event — breaks an `edited_at` tie (higher wins).
  { name: 'edit_id', ddl: 'ALTER TABLE dm_messages ADD COLUMN edit_id TEXT;' },
];

let dbPromise: Promise<DB> | null = null;

// W1 (#849 review): a backup-restored install carries the ciphertext DB file
// but NOT the SQLCipher key (SecureStore is THIS_DEVICE_ONLY by design), so
// every open fails with SQLCipher's wrong-key signature "file is not a
// database" — forever, bricking every DM path. The store is a rebuildable
// relay cache, so the recovery is: wipe file + key, recreate empty, let the
// next refresh rebuild from relays. The heal triggers ONLY on that exact
// signature — transient errors (e.g. locked) keep the existing
// reject-and-retry-later semantics, and the SQLCipher-missing guard below is
// never healed (wiping there would recreate the DB as plaintext on a
// regressed build).
const SQLCIPHER_MISSING = 'SQLCipher not active';
const WRONG_KEY_SIGNATURE = /file is not a database/i;

async function openLocalDb(): Promise<DB> {
  try {
    return await openLocalDbAttempt();
  } catch (e) {
    if (!WRONG_KEY_SIGNATURE.test(String((e as Error)?.message ?? e))) throw e;
    if (__DEV__) {
      console.warn(
        `[localDb] open failed (${(e as Error)?.message ?? e}) — wiping undecryptable store and recreating (backup-restore self-heal)`,
      );
    }
    // Direct wipe — NOT wipeLocalDmStore/clearLocalDb, which await dbPromise:
    // we ARE dbPromise here, so that would self-deadlock. A bare (keyless)
    // handle suffices to delete the file; pair it with the key wipe.
    try {
      open({ name: DB_NAME }).delete();
    } catch (delErr) {
      if (__DEV__) console.warn(`[localDb] heal delete failed: ${(delErr as Error)?.message}`);
    }
    await clearLocalDbKey();
    return openLocalDbAttempt();
  }
}

async function openLocalDbAttempt(): Promise<DB> {
  const encryptionKey = await getOrCreateLocalDbKey();
  const db = open({ name: DB_NAME, encryptionKey });
  // Fail loud if SQLCipher isn't actually compiled in: op-sqlite silently
  // ignores `encryptionKey` on a plain-SQLite build, which would write our
  // private DM / transaction rows to disk in cleartext. cipher_version is
  // empty on plain SQLite and non-empty (e.g. "4.14.0 community") under
  // SQLCipher — an empty value means the build regressed, so refuse to open.
  const cipher = await db.execute('PRAGMA cipher_version;');
  if (!String(cipher.rows?.[0]?.cipher_version ?? '')) {
    throw new Error(
      `${SQLCIPHER_MISSING} — refusing to open a plaintext DB (cipher_version empty)`,
    );
  }
  await rebuildDmMessagesIfPreOwner(db);
  for (const stmt of SCHEMA) await db.execute(stmt);
  await addMissingDmMessagesColumns(db);
  return db;
}

// v2 → v3 (#850): add the delivery_status / rumor_id columns to a table
// created before they existed. CREATE TABLE IF NOT EXISTS is a no-op on an
// existing table, so the SCHEMA pass alone doesn't add them.
async function addMissingDmMessagesColumns(db: DB): Promise<void> {
  const info = await db.execute('PRAGMA table_info(dm_messages);');
  const have = new Set((info.rows ?? []).map((c) => String(c.name)));
  for (const col of ADDED_COLUMNS) {
    if (!have.has(col.name)) await db.execute(col.ddl);
  }
}

// Schema v1 (pre-#848) had no `owner` column and keyed rows by event_id alone.
// SQLite can't ALTER a primary key, so a pre-owner table is dropped and
// recreated by the SCHEMA pass. Safe because (a) the table is a rebuildable
// relay cache and (b) the store was dormant before #848 (imported only by its
// own tests), so pre-owner tables exist only on dev installs.
async function rebuildDmMessagesIfPreOwner(db: DB): Promise<void> {
  const info = await db.execute('PRAGMA table_info(dm_messages);');
  const have = new Set((info.rows ?? []).map((c) => String(c.name)));
  if (have.size > 0 && !have.has('owner')) {
    await db.execute('DROP TABLE dm_messages;');
  }
}

/**
 * The opened, schema-migrated encrypted DB. Single-flight so concurrent
 * callers share one open; cleared on failure so a transient open error
 * (bad key, locked file) can be retried rather than wedging every call.
 */
export function getLocalDb(): Promise<DB> {
  if (!dbPromise) {
    dbPromise = openLocalDb().catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

/**
 * Close + delete the encrypted DB file and reset the open handle. If the DB
 * wasn't opened this session, a bare handle is opened solely to delete the
 * on-disk file.
 *
 * Module-private on purpose: deleting the file WITHOUT also clearing the key is
 * not a complete wipe (a delete failure would leave a still-readable encrypted
 * DB on disk). The only safe public entry point is `wipeLocalDmStore`, which
 * pairs this with `clearLocalDbKey`. A delete failure is logged in dev as a
 * breadcrumb rather than thrown, so it can't wedge the logout flow.
 */
async function clearLocalDb(): Promise<void> {
  let db: DB | null = null;
  if (dbPromise) {
    db = await dbPromise.catch(() => null);
    dbPromise = null;
  }
  if (!db) {
    try {
      db = open({ name: DB_NAME });
    } catch {
      db = null;
    }
  }
  try {
    db?.delete();
  } catch (e) {
    if (__DEV__) console.warn(`[localDb] DB file delete failed: ${(e as Error)?.message ?? e}`);
  }
}

/**
 * Full wipe of the local DM store on logout / account-wipe: delete the
 * encrypted DB file AND its keystore key. A lone key or a lone ciphertext file
 * is useless, but leave neither behind (#690 / #710 H1). Wired into the
 * last-identity logout path in NostrContext (#848); per-account sign-out of a
 * non-final identity deletes only that owner's rows (dmDb). Safe to call when
 * nothing was ever created — both halves are no-ops.
 */
export async function wipeLocalDmStore(): Promise<void> {
  await clearLocalDb();
  await clearLocalDbKey();
}

/**
 * Dev-only smoke-check (#695 spike): round-trips a row through the opened DB
 * and returns the active SQLCipher cipher version for logging. The
 * SQLCipher-active assertion lives in `openLocalDb` now (every open is
 * guarded); this just exercises an encrypted write/read end-to-end. Guarded
 * to `__DEV__` so it can't be called from production code, and the smoke row
 * is always cleaned up in `finally`.
 */
export async function verifyEncryptedDb(): Promise<string> {
  if (!__DEV__) throw new Error('verifyEncryptedDb is a dev-only diagnostic');
  const db = await getLocalDb(); // openLocalDb already asserted SQLCipher is active
  const res = await db.execute('PRAGMA cipher_version;');
  const cipher = String(res.rows?.[0]?.cipher_version ?? '');
  try {
    await db.execute(
      `INSERT OR REPLACE INTO dm_messages (owner, event_id, conversation, created_at, sender, content)
       VALUES (?, ?, ?, ?, ?, ?);`,
      ['__smoke__', '__smoke__', '__smoke__', 0, '__smoke__', 'ok'],
    );
    const back = await db.execute('SELECT content FROM dm_messages WHERE event_id = ?;', [
      '__smoke__',
    ]);
    if (back.rows?.[0]?.content !== 'ok') throw new Error('encrypted round-trip failed');
    return cipher;
  } finally {
    await db.execute('DELETE FROM dm_messages WHERE event_id = ?;', ['__smoke__']).catch(() => {});
  }
}
