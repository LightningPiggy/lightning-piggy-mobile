// op-sqlite is a native module jest can't load; mock it to cover the open +
// schema orchestration and the verify smoke-check. The real encrypted open is
// validated by an on-device dev build (#695 spike), not here.
const mockExecute = jest.fn();
const mockDelete = jest.fn();
const mockDb = { execute: mockExecute, delete: mockDelete };
const mockOpen = jest.fn(() => mockDb);
const mockClearKey = jest.fn(() => Promise.resolve());
const mockHasKey = jest.fn(() => Promise.resolve(true));
jest.mock('@op-engineering/op-sqlite', () => ({ open: mockOpen }));
jest.mock('./localDbKey', () => ({
  getOrCreateLocalDbKey: jest.fn(() => Promise.resolve('a'.repeat(64))),
  clearLocalDbKey: mockClearKey,
  hasLocalDbKey: mockHasKey,
}));

import { getLocalDb, verifyEncryptedDb } from './localDb';

// Route execute() return values by SQL so verifyEncryptedDb's round-trip works.
const wireExecute = () =>
  mockExecute.mockImplementation((sql: string) => {
    if (sql.includes('cipher_version')) {
      return Promise.resolve({ rows: [{ cipher_version: '4.6.0' }] });
    }
    if (sql.startsWith('SELECT content')) {
      return Promise.resolve({ rows: [{ content: 'ok' }] });
    }
    return Promise.resolve({ rows: [] });
  });

beforeEach(() => {
  jest.clearAllMocks();
  wireExecute();
  jest.resetModules();
});

describe('localDb', () => {
  it('opens the DB with the keystore encryption key', async () => {
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await freshGetLocalDb();
    expect(mockOpen).toHaveBeenCalledWith({
      name: 'lightningpiggy.db',
      encryptionKey: 'a'.repeat(64),
    });
  });

  it('runs the schema (owner-scoped dm_messages table + index) on open', async () => {
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await freshGetLocalDb();
    const ddl = mockExecute.mock.calls.map((c) => c[0]).join('\n');
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS dm_messages');
    expect(ddl).toContain('PRIMARY KEY (owner, event_id)');
    expect(ddl).toContain('idx_dm_owner_conversation_created');
  });

  it('drops a pre-owner (schema v1) dm_messages table so the v2 schema recreates it', async () => {
    mockExecute.mockImplementation((sql: string) => {
      if (sql.includes('cipher_version')) {
        return Promise.resolve({ rows: [{ cipher_version: '4.6.0' }] });
      }
      if (sql.includes('table_info')) {
        // v1 shape: event_id PK, no owner column
        return Promise.resolve({ rows: [{ name: 'event_id' }, { name: 'conversation' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await freshGetLocalDb();
    const sqls = mockExecute.mock.calls.map((c) => c[0]);
    const dropIdx = sqls.findIndex((s) => s.includes('DROP TABLE dm_messages'));
    const createIdx = sqls.findIndex((s) => s.includes('CREATE TABLE IF NOT EXISTS dm_messages'));
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(dropIdx).toBeLessThan(createIdx); // rebuild, not drop-after-create
  });

  it('does NOT drop a dm_messages table that already has the owner column', async () => {
    mockExecute.mockImplementation((sql: string) => {
      if (sql.includes('cipher_version')) {
        return Promise.resolve({ rows: [{ cipher_version: '4.6.0' }] });
      }
      if (sql.includes('table_info')) {
        return Promise.resolve({ rows: [{ name: 'owner' }, { name: 'event_id' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await freshGetLocalDb();
    const sqls = mockExecute.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => s.includes('DROP TABLE'))).toBe(false);
  });

  it('is single-flight — a second getLocalDb does not reopen', async () => {
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await freshGetLocalDb();
    await freshGetLocalDb();
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('clears the cached open on failure so a later call can retry', async () => {
    mockOpen.mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await expect(freshGetLocalDb()).rejects.toThrow('locked');
    const db = await freshGetLocalDb();
    expect(db).toBe(mockDb);
  });

  it('verifyEncryptedDb returns the cipher version on a clean encrypted round-trip', async () => {
    const { verifyEncryptedDb: freshVerify } = require('./localDb');
    expect(await freshVerify()).toBe('4.6.0');
  });

  it('self-heals an undecryptable DB (backup-restore wrong-key) by wiping and recreating', async () => {
    // First attempt: SQLCipher wrong-key signature from the first PRAGMA.
    let calls = 0;
    mockExecute.mockImplementation((sql: string) => {
      if (sql.includes('cipher_version')) {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('file is not a database'));
        return Promise.resolve({ rows: [{ cipher_version: '4.6.0' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    const db = await freshGetLocalDb();
    expect(db).toBe(mockDb);
    // The heal wiped both halves: DB file deleted + keystore key cleared.
    expect(mockDelete).toHaveBeenCalled();
    const { clearLocalDbKey } = require('./localDbKey');
    expect(clearLocalDbKey).toHaveBeenCalled();
  });

  it('does NOT heal a transient open error (locked) — rejects for a later retry', async () => {
    mockOpen.mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await expect(freshGetLocalDb()).rejects.toThrow('locked');
  });

  it('refuses to open when SQLCipher is not active (empty cipher_version → plaintext guard)', async () => {
    mockExecute.mockImplementation((sql: string) =>
      sql.includes('cipher_version')
        ? Promise.resolve({ rows: [{ cipher_version: '' }] })
        : Promise.resolve({ rows: [] }),
    );
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await expect(freshGetLocalDb()).rejects.toThrow('SQLCipher not active');
  });

  it('checks cipher_version before running the schema (open-time guard)', async () => {
    const { getLocalDb: freshGetLocalDb } = require('./localDb');
    await freshGetLocalDb();
    const sqls = mockExecute.mock.calls.map((c) => c[0]);
    const cipherIdx = sqls.findIndex((s) => s.includes('cipher_version'));
    const schemaIdx = sqls.findIndex((s) => s.includes('CREATE TABLE'));
    expect(cipherIdx).toBeGreaterThanOrEqual(0);
    expect(cipherIdx).toBeLessThan(schemaIdx); // guard runs before schema
  });

  it('prewarmLocalDb opens the DB early when a key exists, shared with later callers', async () => {
    const { prewarmLocalDb, getLocalDb: g } = require('./localDb');
    prewarmLocalDb();
    await new Promise((r) => setImmediate(r));
    expect(mockOpen).toHaveBeenCalledTimes(1);
    await g();
    expect(mockOpen).toHaveBeenCalledTimes(1);
  });

  it('prewarmLocalDb never creates a key or file on an install without one', async () => {
    mockHasKey.mockResolvedValueOnce(false);
    const { prewarmLocalDb } = require('./localDb');
    prewarmLocalDb();
    await new Promise((r) => setImmediate(r));
    expect(mockOpen).not.toHaveBeenCalled();
    const { getOrCreateLocalDbKey } = require('./localDbKey');
    expect(getOrCreateLocalDbKey).not.toHaveBeenCalled();
  });

  it('skips DDL when user_version already matches the schema fingerprint', async () => {
    const { SCHEMA_FINGERPRINT, getLocalDb: g } = require('./localDb');
    mockExecute.mockImplementation((sql: string) => {
      if (sql.includes('cipher_version')) {
        return Promise.resolve({ rows: [{ cipher_version: '4.6.0' }] });
      }
      if (sql.includes('user_version')) {
        return Promise.resolve({ rows: [{ user_version: SCHEMA_FINGERPRINT }] });
      }
      return Promise.resolve({ rows: [] });
    });
    await g();
    expect(mockExecute.mock.calls.map((c) => c[0])).toEqual([
      'PRAGMA cipher_version;',
      'PRAGMA cipher_compatibility = 4;',
      'PRAGMA user_version;',
    ]);
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockClearKey).not.toHaveBeenCalled();
  });

  // clearLocalDb is module-private (the only safe public wipe is
  // wipeLocalDmStore, which also clears the key) — so its delete paths are
  // exercised through wipeLocalDmStore.
  it('wipeLocalDmStore deletes the DB AND clears the keystore key (open-handle case, #710 H1)', async () => {
    const { getLocalDb: g, wipeLocalDmStore } = require('./localDb');
    await g(); // opened this session
    await wipeLocalDmStore();
    expect(mockDelete).toHaveBeenCalled();
    expect(mockClearKey).toHaveBeenCalled();
  });

  it('wipeLocalDmStore opens a bare handle to delete when DB not opened this session', async () => {
    const { wipeLocalDmStore } = require('./localDb');
    await wipeLocalDmStore(); // never opened this session
    expect(mockOpen).toHaveBeenCalledWith(expect.objectContaining({ name: 'lightningpiggy.db' }));
    expect(mockDelete).toHaveBeenCalled();
    expect(mockClearKey).toHaveBeenCalled();
  });
});

// reference so the static imports aren't flagged unused (we re-require per
// test to reset the module-level single-flight cache).
void getLocalDb;
void verifyEncryptedDb;
