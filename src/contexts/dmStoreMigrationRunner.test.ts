/**
 * Unit tests for the per-account migration trigger (#848): plaintext
 * wrap-cache file → encrypted DB rows → verified delete → flag. The strict
 * ordering itself is covered by dmStoreMigration.test; these cover the
 * wiring — entry import/validation, file deletion + verification against an
 * in-memory expo-file-system, flag persistence, single-flight memo, and the
 * retry path when the DB write fails.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const fileStore: Record<string, string> = {};

jest.mock('expo-file-system', () => {
  const MockFile = class {
    private path: string;
    constructor(_dir: string, name: string) {
      this.path = name;
    }
    get exists(): boolean {
      return Object.prototype.hasOwnProperty.call(fileStore, this.path);
    }
    async text(): Promise<string> {
      return fileStore[this.path] ?? '';
    }
    delete(): void {
      delete fileStore[this.path];
    }
    create(): void {
      fileStore[this.path] = '';
    }
    writeSync(content: string): void {
      fileStore[this.path] = content;
    }
  };
  return { File: MockFile, Paths: { document: '/mock-documents' } };
});

const mockUpsert = jest.fn();
const mockImport = jest.fn();
jest.mock('../services/dmDb', () => ({
  upsertDmMessages: (...args: unknown[]) => mockUpsert(...args),
  importDmMessages: (...args: unknown[]) => mockImport(...args),
  LOCAL_DM_ID_PREFIX: 'local-',
  LOCAL_DM_ECHO_WINDOW_SECS: 30,
}));

import {
  ensureDmStoreMigrated,
  forgetDmStoreMigration,
  dmStoreMigratedKey,
  wrapCacheEntryToRow,
  MIGRATION_RETRY_BACKOFF_MS,
} from './dmStoreMigrationRunner';
import { dmBlobMigratedKey } from './dmBlobMigration';
import type { Nip17CacheEntry } from './nostrDmCache';
import type { DmMessageRow } from '../services/dmDb';

const OWNER = 'f'.repeat(64);
const ALICE = 'a'.repeat(64);
const NSEC_FILE = `nsec_nip17_cache_v1_${OWNER}.json`;

const entry = (id: string, over: Partial<Nip17CacheEntry> = {}): Nip17CacheEntry => ({
  id,
  wrapId: id,
  partnerPubkey: ALICE,
  fromMe: false,
  createdAt: 100,
  text: `text-${id}`,
  wireKind: 14,
  ...over,
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockUpsert.mockResolvedValue(undefined);
  mockImport.mockResolvedValue(undefined);
  for (const k of Object.keys(fileStore)) delete fileStore[k];
  await AsyncStorage.clear();
  forgetDmStoreMigration(OWNER);
});

describe('dmStoreMigrationRunner', () => {
  it('imports the wrap-cache file as rows, deletes the file, sets the flag', async () => {
    fileStore[NSEC_FILE] = JSON.stringify({ w1: entry('w1'), w2: entry('w2', { fromMe: true }) });
    await ensureDmStoreMigrated(OWNER);
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows.map((r) => r.eventId)).toEqual(['w1', 'w2']);
    expect(rows[0]).toMatchObject({ owner: OWNER, conversation: ALICE, sender: ALICE });
    expect(rows[1]).toMatchObject({ fromMe: true, sender: OWNER }); // fromMe → sender is us
    expect(fileStore[NSEC_FILE]).toBeUndefined(); // plaintext gone
    expect(await AsyncStorage.getItem(dmStoreMigratedKey(OWNER))).toBe('1');
  });

  it('drops malformed entries instead of failing the import', async () => {
    fileStore[NSEC_FILE] = JSON.stringify({
      good: entry('good'),
      bad: { ...entry('bad'), partnerPubkey: 'not-hex' },
    });
    await ensureDmStoreMigrated(OWNER);
    const rows: DmMessageRow[] = mockUpsert.mock.calls[0][0];
    expect(rows.map((r) => r.eventId)).toEqual(['good']);
    expect(await AsyncStorage.getItem(dmStoreMigratedKey(OWNER))).toBe('1');
  });

  it('completes (flag set, no upsert) when there is nothing to migrate', async () => {
    await ensureDmStoreMigrated(OWNER);
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(dmStoreMigratedKey(OWNER))).toBe('1');
  });

  it('is single-flighted + memoised: repeat calls do not re-run the import', async () => {
    fileStore[NSEC_FILE] = JSON.stringify({ w1: entry('w1') });
    await Promise.all([ensureDmStoreMigrated(OWNER), ensureDmStoreMigrated(OWNER)]);
    await ensureDmStoreMigrated(OWNER);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  it('short-circuits on the persisted flag after the memo is forgotten (re-login)', async () => {
    fileStore[NSEC_FILE] = JSON.stringify({ w1: entry('w1') });
    await ensureDmStoreMigrated(OWNER);
    forgetDmStoreMigration(OWNER);
    await ensureDmStoreMigrated(OWNER);
    expect(mockUpsert).toHaveBeenCalledTimes(1); // already-migrated path
  });

  it('leaves the plaintext + flag intact when the DB write fails, then retries after the backoff (N7)', async () => {
    fileStore[NSEC_FILE] = JSON.stringify({ w1: entry('w1') });
    mockUpsert.mockRejectedValueOnce(new Error('db locked'));
    await ensureDmStoreMigrated(OWNER);
    expect(fileStore[NSEC_FILE]).toBeDefined(); // never delete before the DB has the rows
    expect(await AsyncStorage.getItem(dmStoreMigratedKey(OWNER))).toBeNull();

    // Inside the backoff window a re-trigger is skipped (N7) — a wedged
    // storage subsystem must not re-run the populate on every DM entry point.
    await ensureDmStoreMigrated(OWNER);
    expect(mockUpsert).toHaveBeenCalledTimes(1);

    // Past the window the retry runs and succeeds.
    await ensureDmStoreMigrated(OWNER, () => Date.now() + MIGRATION_RETRY_BACKOFF_MS + 1);
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(fileStore[NSEC_FILE]).toBeUndefined();
    expect(await AsyncStorage.getItem(dmStoreMigratedKey(OWNER))).toBe('1');
  });

  it('also runs the #850 blob migration: imports + deletes the inbox/conv blobs, sets both flags', async () => {
    const inboxKey = `nostr_dm_inbox_v1_${OWNER}`;
    const convKey = `nostr_dm_conv_v1_${OWNER}_${ALICE}`;
    await AsyncStorage.setItem(
      inboxKey,
      JSON.stringify([
        {
          id: 'i1',
          partnerPubkey: ALICE,
          fromMe: false,
          createdAt: 5,
          text: 'preview',
          wireKind: 4,
        },
      ]),
    );
    await AsyncStorage.setItem(
      convKey,
      JSON.stringify([{ id: 'm1', fromMe: true, text: 'full', createdAt: 6, wireKind: 14 }]),
    );
    await ensureDmStoreMigrated(OWNER);
    const imported = mockImport.mock.calls.flatMap((c) => c[0] as DmMessageRow[]);
    expect(imported.map((r) => r.eventId).sort()).toEqual(['i1', 'm1']);
    expect(await AsyncStorage.getItem(inboxKey)).toBeNull();
    expect(await AsyncStorage.getItem(convKey)).toBeNull();
    expect(await AsyncStorage.getItem(dmBlobMigratedKey(OWNER))).toBe('1');
  });

  it('N9: deletes pre-#288 unsuffixed wrap-cache remnants during the blob migration', async () => {
    await AsyncStorage.setItem('nsec_nip17_cache_v1', '{}');
    fileStore['amber_nip17_cache_v1.json'] = '{}';
    await ensureDmStoreMigrated(OWNER);
    expect(await AsyncStorage.getItem('nsec_nip17_cache_v1')).toBeNull();
    expect(fileStore['amber_nip17_cache_v1.json']).toBeUndefined();
    expect(await AsyncStorage.getItem(dmBlobMigratedKey(OWNER))).toBe('1');
  });

  describe('wrapCacheEntryToRow', () => {
    it('falls back to id when wrapId is missing and defaults wireKind', () => {
      const legacy = { ...entry('w9'), wireKind: undefined } as unknown as Nip17CacheEntry;
      delete (legacy as Partial<Nip17CacheEntry>).wrapId;
      const row = wrapCacheEntryToRow(OWNER, legacy);
      expect(row).toMatchObject({ eventId: 'w9', wireKind: 14 });
    });

    it('rejects entries without text or a valid partner pubkey', () => {
      expect(
        wrapCacheEntryToRow(OWNER, { ...entry('a'), text: 7 as unknown as string }),
      ).toBeNull();
      expect(wrapCacheEntryToRow(OWNER, { ...entry('b'), partnerPubkey: 'xyz' })).toBeNull();
    });
  });
});
