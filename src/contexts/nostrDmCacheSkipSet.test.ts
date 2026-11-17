/**
 * Unit tests for the NIP-17 negative-result skip-set (#743).
 *
 * The skip-set persists wrap ids that were successfully decrypted in a
 * prior `refreshDmInbox` pass but produced no inbox entry — because the
 * rumor was a group message (routed elsewhere) or from a non-followed
 * sender. On subsequent warm refreshes the skip-set lets the loop
 * short-circuit before paying the NIP-44 decrypt cost again.
 *
 * Tests cover:
 *   - `loadNip17SkipSet` — returns empty Set on missing/corrupt file.
 *   - `writeNip17SkipSet` — persists the Set as a JSON array, enforces
 *     the NIP17_SKIP_CAP by dropping the oldest (front) entries.
 *   - `loadNip17SkipSet` round-trip — loaded Set matches what was written.
 *   - Cap enforcement — entries beyond NIP17_SKIP_CAP are trimmed from
 *     the front (oldest-inserted) before writing.
 *
 * expo-file-system is mocked so the tests run in Jest without a native
 * runtime. The mock captures the last `writeSync()` call so round-trip tests
 * can inspect what would have been persisted.
 */

// --- expo-file-system mock -------------------------------------------
//
// `nostrDmCache.ts` constructs `new File(Paths.document, filename)` and
// calls `f.exists`, `f.text()`, `f.delete()`, `f.create()`, `f.writeSync()`.
// We provide a per-test in-memory store so each test starts clean.
//
// The mock is hoisted before the import so jest.mock(...) evaluates
// before the module under test is loaded.

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
      // no-op — writeSync() will populate
    }
    writeSync(data: string): void {
      fileStore[this.path] = data;
    }
  };
  return {
    File: MockFile,
    Paths: { document: '/mock/document' },
  };
});

// AsyncStorage mock (required by nostrDmCache imports)
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// --- imports (after mocks) -------------------------------------------
import { loadNip17SkipSet, writeNip17SkipSet, NIP17_SKIP_CAP } from './nostrDmCache';

beforeEach(() => {
  // Clear the in-memory file store so tests are independent.
  for (const k of Object.keys(fileStore)) delete fileStore[k];
});

describe('loadNip17SkipSet', () => {
  it('returns an empty Set when the file does not exist', async () => {
    const set = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(set).toBeInstanceOf(Set);
    expect(set.size).toBe(0);
  });

  it('returns an empty Set when the file contains invalid JSON', async () => {
    // Seed a corrupt file directly into the store.
    fileStore['nsec_nip17_skip_v1_aabbcc.json'] = 'not-json{{{';
    const set = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(set.size).toBe(0);
  });

  it('returns an empty Set when the file contains a non-array JSON value', async () => {
    fileStore['nsec_nip17_skip_v1_aabbcc.json'] = '{"a":1}';
    const set = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(set.size).toBe(0);
  });

  it('hydrates correctly from a valid persisted array', async () => {
    fileStore['nsec_nip17_skip_v1_aabbcc.json'] = JSON.stringify(['id1', 'id2', 'id3']);
    const set = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(set.size).toBe(3);
    expect(set.has('id1')).toBe(true);
    expect(set.has('id2')).toBe(true);
    expect(set.has('id3')).toBe(true);
  });
});

describe('writeNip17SkipSet', () => {
  it('persists the Set as a JSON array readable by loadNip17SkipSet', async () => {
    const set = new Set(['wrap-a', 'wrap-b', 'wrap-c']);
    await writeNip17SkipSet('nsec_nip17_skip_v1_aabbcc', set);
    const loaded = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(loaded.size).toBe(3);
    expect(loaded.has('wrap-a')).toBe(true);
    expect(loaded.has('wrap-b')).toBe(true);
    expect(loaded.has('wrap-c')).toBe(true);
  });

  it('overwrites a previous write (no stale entries after update)', async () => {
    const first = new Set(['old-wrap']);
    await writeNip17SkipSet('nsec_nip17_skip_v1_aabbcc', first);

    const second = new Set(['new-wrap-1', 'new-wrap-2']);
    await writeNip17SkipSet('nsec_nip17_skip_v1_aabbcc', second);

    const loaded = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(loaded.size).toBe(2);
    expect(loaded.has('old-wrap')).toBe(false);
    expect(loaded.has('new-wrap-1')).toBe(true);
  });

  it('enforces NIP17_SKIP_CAP by dropping oldest (front) entries', async () => {
    // Build a Set just over the cap.
    const set = new Set<string>();
    const total = NIP17_SKIP_CAP + 50;
    for (let i = 0; i < total; i++) set.add(`wrap-${i}`);

    await writeNip17SkipSet('nsec_nip17_skip_v1_aabbcc', set);
    const loaded = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');

    // Exactly NIP17_SKIP_CAP entries survive.
    expect(loaded.size).toBe(NIP17_SKIP_CAP);
    // Oldest 50 entries (wrap-0 … wrap-49) are dropped.
    for (let i = 0; i < 50; i++) expect(loaded.has(`wrap-${i}`)).toBe(false);
    // Newest 50 entries survive.
    for (let i = total - 50; i < total; i++) expect(loaded.has(`wrap-${i}`)).toBe(true);
  });

  it('writes an empty array when given an empty Set (no file content error)', async () => {
    await writeNip17SkipSet('nsec_nip17_skip_v1_aabbcc', new Set());
    const loaded = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(loaded.size).toBe(0);
  });
});

describe('skip-set round-trip', () => {
  it('survives a write → load cycle with a large realistic set', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `aabbcc${i.toString(16).padStart(4, '0')}`);
    const set = new Set(ids);
    await writeNip17SkipSet('nsec_nip17_skip_v1_aabbcc', set);
    const loaded = await loadNip17SkipSet('nsec_nip17_skip_v1_aabbcc');
    expect(loaded.size).toBe(200);
    for (const id of ids) expect(loaded.has(id)).toBe(true);
  });
});
