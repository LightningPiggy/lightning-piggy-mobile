// The open + migration path run against a REAL SQLite (node:sqlite) instead
// of the scripted mock in localDb.test.ts: proves the user_version fast path,
// an old-schema upgrade, the inbox index and the query plan getInboxLatest
// gets. SQLCipher itself is native; only its cipher_version guard is faked.
import { DatabaseSync } from 'node:sqlite';

let mockFile: DatabaseSync;
let mockLog: string[];
let mockFailOn: RegExp | null;

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => ({
    execute: async (sql: string, params: (string | number | null)[] = []) => {
      mockLog.push(sql);
      if (sql.includes('cipher_version')) return { rows: [{ cipher_version: '4.6.0' }] };
      if (mockFailOn?.test(sql)) {
        mockFailOn = null;
        throw new Error('disk I/O error');
      }
      return { rows: mockFile.prepare(sql).all(...params) };
    },
    delete: () => undefined,
  }),
}));
jest.mock('./localDbKey', () => ({
  getOrCreateLocalDbKey: async () => 'a'.repeat(64),
  clearLocalDbKey: async () => undefined,
  hasLocalDbKey: async () => true,
}));

type LocalDb = typeof import('./localDb');
type DmDb = typeof import('./dmDb');

/** A fresh module instance = a new app launch against the same DB file. */
function launch(): { localDb: LocalDb; dmDb: DmDb } {
  let localDb!: LocalDb;
  let dmDb!: DmDb;
  jest.isolateModules(() => {
    localDb = require('./localDb');
    dmDb = require('./dmDb');
  });
  mockLog = [];
  return { localDb, dmDb };
}

const userVersion = () =>
  Number((mockFile.prepare('PRAGMA user_version;').get() as { user_version: number }).user_version);
const indexes = () =>
  (
    mockFile
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dm_messages'")
      .all() as { name: string }[]
  ).map((r) => r.name);
const columns = () =>
  (mockFile.prepare('PRAGMA table_info(dm_messages);').all() as { name: string }[]).map(
    (c) => c.name,
  );

beforeEach(() => {
  mockFile = new DatabaseSync(':memory:');
  mockFailOn = null;
});
afterEach(() => mockFile.close());

describe('local DB migrations (user_version fast path)', () => {
  it('a fresh DB is migrated, then stamped with the schema fingerprint', async () => {
    const { localDb } = launch();
    await localDb.getLocalDb();
    expect(mockLog.some((s) => s.includes('CREATE TABLE IF NOT EXISTS dm_messages'))).toBe(true);
    expect(userVersion()).toBe(localDb.SCHEMA_FINGERPRINT);
    expect(localDb.SCHEMA_FINGERPRINT).not.toBe(0);
    expect(columns()).toEqual(expect.arrayContaining(['owner', 'protocol', 'edit_id']));
  });

  it('a DB already on this schema skips every DDL and column check on open', async () => {
    await launch().localDb.getLocalDb();
    const { localDb } = launch(); // next app launch
    await localDb.getLocalDb();
    expect(mockLog).toEqual([
      'PRAGMA cipher_version;',
      'PRAGMA cipher_compatibility = 4;',
      'PRAGMA user_version;',
    ]);
  });

  it('upgrades an old-schema DB in place: adds columns + the inbox index, keeps rows', async () => {
    // A #848-era table: owner-scoped, but none of the later ADD COLUMNs, and
    // no user_version (every pre-fingerprint install reads 0).
    mockFile.exec(`CREATE TABLE dm_messages (
      owner TEXT NOT NULL, event_id TEXT NOT NULL, conversation TEXT NOT NULL,
      created_at INTEGER NOT NULL, sender TEXT NOT NULL, content TEXT NOT NULL,
      from_me INTEGER NOT NULL DEFAULT 0, wire_kind INTEGER NOT NULL DEFAULT 14,
      PRIMARY KEY (owner, event_id));
      INSERT INTO dm_messages VALUES ('me', 'e1', 'peer', 10, 'peer', 'hi', 0, 14);`);
    expect(userVersion()).toBe(0);
    const { localDb, dmDb } = launch();
    await localDb.getLocalDb();
    expect(columns()).toEqual(
      expect.arrayContaining(['delivery_status', 'rumor_id', 'protocol', 'reply_to', 'edited_at']),
    );
    expect(indexes()).toEqual(
      expect.arrayContaining(['idx_dm_owner_conversation_created', 'idx_dm_owner_inbox']),
    );
    expect(userVersion()).toBe(localDb.SCHEMA_FINGERPRINT);
    expect((await dmDb.getInboxLatest('me')).map((r) => r.eventId)).toEqual(['e1']);
  });

  it('a different fingerprint (another build edited the schema) re-runs the idempotent migration', async () => {
    await launch().localDb.getLocalDb();
    mockFile.exec('PRAGMA user_version = 12345;');
    const { localDb } = launch();
    await localDb.getLocalDb();
    expect(mockLog.some((s) => s.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(userVersion()).toBe(localDb.SCHEMA_FINGERPRINT);
  });

  it('bumping SCHEMA_REVISION (a non-DDL migration step) re-runs the migration on a stamped DB', async () => {
    const { localDb: previous } = launch();
    // A DB stamped by a build one revision behind, with identical DDL.
    const older = previous.schemaFingerprint(previous.SCHEMA_REVISION - 1);
    expect(older).not.toBe(previous.SCHEMA_FINGERPRINT);
    expect(previous.schemaFingerprint(previous.SCHEMA_REVISION)).toBe(previous.SCHEMA_FINGERPRINT);
    await previous.getLocalDb();
    mockFile.exec(`PRAGMA user_version = ${older};`);
    const { localDb } = launch();
    await localDb.getLocalDb();
    expect(mockLog.some((s) => s.includes('PRAGMA table_info(dm_messages)'))).toBe(true);
    expect(mockLog.some((s) => s.includes('CREATE TABLE IF NOT EXISTS'))).toBe(true);
    expect(userVersion()).toBe(localDb.SCHEMA_FINGERPRINT);
  });

  it('a migration that fails part-way is not stamped, so the next open retries it', async () => {
    mockFailOn = /idx_dm_owner_inbox/;
    const first = launch();
    await expect(first.localDb.getLocalDb()).rejects.toThrow('disk I/O error');
    expect(userVersion()).toBe(0);
    const { localDb } = launch();
    await localDb.getLocalDb();
    expect(indexes()).toContain('idx_dm_owner_inbox');
    expect(userVersion()).toBe(localDb.SCHEMA_FINGERPRINT);
  });
});

describe('getInboxLatest on the real schema', () => {
  const insert = (
    owner: string,
    id: string,
    conversation: string,
    at: number,
    wireKind = 14,
    protocol: string | null = null,
  ) =>
    mockFile
      .prepare(
        `INSERT INTO dm_messages (owner, event_id, conversation, created_at, sender, content, wire_kind, protocol)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(owner, id, conversation, at, conversation, 'x', wireKind, protocol);

  it('returns the latest row per (thread, protocol), owner-scoped, newest first', async () => {
    const { localDb, dmDb } = launch();
    await localDb.getLocalDb();
    insert('me', 'a1', 'alice', 1);
    insert('me', 'a2', 'alice', 5);
    insert('me', 'a-react', 'alice', 9, 7); // reaction: never a thread's latest
    insert('me', 'a-nip04', 'alice', 3, 4); // same partner, NIP-04 thread
    insert('me', 'b1', 'bob', 7);
    insert('me', 'b-invite', 'bob', 8, 444); // Marmot invite wrap
    insert('me', 'g1', 'group', 6, 9, 'marmot');
    insert('other', 'o1', 'alice', 100); // another account's row
    const rows = await dmDb.getInboxLatest('me');
    expect(rows.map((r) => r.eventId)).toEqual(['b1', 'g1', 'a2', 'a-nip04']);
  });

  it('scans the covering inbox index and looks each thread up by index (no full-row scan)', async () => {
    const { localDb, dmDb } = launch();
    await localDb.getLocalDb();
    await dmDb.getInboxLatest('me');
    const sql = mockLog.find((s) => s.includes('MAX(created_at)'))!;
    const plan = (
      mockFile.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('me', 'me') as { detail: string }[]
    ).map((r) => r.detail);
    expect(plan).toEqual(
      expect.arrayContaining([
        expect.stringContaining('USING COVERING INDEX idx_dm_owner_inbox (owner=?)'),
        expect.stringContaining(
          'USING INDEX idx_dm_owner_conversation_created (owner=? AND conversation=? AND created_at=?)',
        ),
      ]),
    );
    expect(plan.some((d) => /SCAN m\b|sqlite_autoindex_dm_messages/.test(d))).toBe(false);
  });
});
