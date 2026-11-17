/**
 * Unit tests for the #850 one-shot blob migration: the LAST plaintext DM
 * blobs (inbox previews + per-conversation threads) → fill-only rows in the
 * encrypted store → verified delete → flag. Mirrors the #848 wrap-cache
 * migration's safety story (strict populate → delete → verify ordering is
 * covered generically by dmStoreMigration.test; these cover the wiring).
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

const mockImport = jest.fn();
jest.mock('../services/dmDb', () => ({
  importDmMessages: (...args: unknown[]) => mockImport(...args),
  LOCAL_DM_ID_PREFIX: 'local-',
  LOCAL_DM_ECHO_WINDOW_SECS: 30,
}));

import {
  runDmBlobMigration,
  dmBlobMigratedKey,
  inboxEntryToRow,
  convEntryToRow,
} from './dmBlobMigration';
import type { DmMessageRow } from '../services/dmDb';

const OWNER = 'f'.repeat(64);
const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const INBOX_KEY = `nostr_dm_inbox_v1_${OWNER}`;
const convKey = (peer: string) => `nostr_dm_conv_v1_${OWNER}_${peer}`;

const importedRows = (): DmMessageRow[] =>
  mockImport.mock.calls.flatMap((c) => c[0] as DmMessageRow[]);

beforeEach(async () => {
  jest.clearAllMocks();
  mockImport.mockResolvedValue(undefined);
  for (const k of Object.keys(fileStore)) delete fileStore[k];
  await AsyncStorage.clear();
});

describe('runDmBlobMigration', () => {
  it('imports inbox + conversation blobs (with ticks / rumor ids / local- rows), deletes them, sets the flag', async () => {
    const status = { delivered: true, relayResults: {} };
    await AsyncStorage.setItem(
      INBOX_KEY,
      JSON.stringify([
        {
          id: 'k4a',
          partnerPubkey: ALICE,
          fromMe: false,
          createdAt: 10,
          text: 'old kind-4',
          wireKind: 4,
        },
      ]),
    );
    await AsyncStorage.setItem(
      convKey(BOB),
      JSON.stringify([
        { id: 'w1', fromMe: false, text: 'hello', createdAt: 20, wireKind: 14 },
        {
          id: 'local-9',
          fromMe: true,
          text: 'pending send',
          createdAt: 21,
          deliveryStatus: status,
          rumorId: 'rum9',
        },
      ]),
    );
    expect(await runDmBlobMigration(OWNER)).toBe(true);

    const rows = importedRows();
    expect(rows.map((r) => r.eventId).sort()).toEqual(['k4a', 'local-9', 'w1']);
    const k4 = rows.find((r) => r.eventId === 'k4a')!;
    expect(k4).toMatchObject({ owner: OWNER, conversation: ALICE, sender: ALICE, wireKind: 4 });
    const local = rows.find((r) => r.eventId === 'local-9')!;
    expect(local).toMatchObject({
      conversation: BOB,
      fromMe: true,
      sender: OWNER,
      deliveryStatus: status,
      rumorId: 'rum9',
    });

    expect(await AsyncStorage.getItem(INBOX_KEY)).toBeNull();
    expect(await AsyncStorage.getItem(convKey(BOB))).toBeNull();
    expect(await AsyncStorage.getItem(dmBlobMigratedKey(OWNER))).toBe('1');
  });

  it('never deletes the blobs (or sets the flag) when the DB import fails', async () => {
    await AsyncStorage.setItem(
      convKey(ALICE),
      JSON.stringify([{ id: 'w1', fromMe: false, text: 'hello', createdAt: 20 }]),
    );
    mockImport.mockRejectedValueOnce(new Error('db locked'));
    await expect(runDmBlobMigration(OWNER)).rejects.toThrow('db locked');
    expect(await AsyncStorage.getItem(convKey(ALICE))).not.toBeNull();
    expect(await AsyncStorage.getItem(dmBlobMigratedKey(OWNER))).toBeNull();
  });

  it('short-circuits once the flag is set', async () => {
    await AsyncStorage.setItem(dmBlobMigratedKey(OWNER), '1');
    await AsyncStorage.setItem(INBOX_KEY, JSON.stringify([{ id: 'x' }]));
    expect(await runDmBlobMigration(OWNER)).toBe(true);
    expect(mockImport).not.toHaveBeenCalled();
    // already-migrated: the delete step doesn't run either
    expect(await AsyncStorage.getItem(INBOX_KEY)).not.toBeNull();
  });

  it('deletes a conv blob whose peer segment is malformed WITHOUT importing it', async () => {
    const badKey = `nostr_dm_conv_v1_${OWNER}_not-a-pubkey`;
    await AsyncStorage.setItem(badKey, JSON.stringify([{ id: 'w1', text: 'x', createdAt: 1 }]));
    expect(await runDmBlobMigration(OWNER)).toBe(true);
    expect(importedRows()).toHaveLength(0);
    expect(await AsyncStorage.getItem(badKey)).toBeNull();
  });

  it("does not touch another account's blobs", async () => {
    const otherInbox = `nostr_dm_inbox_v1_${BOB}`;
    await AsyncStorage.setItem(otherInbox, JSON.stringify([]));
    expect(await runDmBlobMigration(OWNER)).toBe(true);
    expect(await AsyncStorage.getItem(otherInbox)).not.toBeNull();
  });

  it('N9: deletes pre-#288 unsuffixed wrap-cache rows AND files, without importing them', async () => {
    await AsyncStorage.setItem('nsec_nip17_cache_v1', JSON.stringify({ w: { text: 'plain' } }));
    fileStore['amber_nip17_cache_v1.json'] = '{}';
    expect(await runDmBlobMigration(OWNER)).toBe(true);
    expect(importedRows()).toHaveLength(0);
    expect(await AsyncStorage.getItem('nsec_nip17_cache_v1')).toBeNull();
    expect(fileStore['amber_nip17_cache_v1.json']).toBeUndefined();
    expect(await AsyncStorage.getItem(dmBlobMigratedKey(OWNER))).toBe('1');
  });

  it('completes (flag set, no import) when there is nothing to migrate', async () => {
    expect(await runDmBlobMigration(OWNER)).toBe(true);
    expect(mockImport).not.toHaveBeenCalled();
    expect(await AsyncStorage.getItem(dmBlobMigratedKey(OWNER))).toBe('1');
  });
});

describe('inboxEntryToRow', () => {
  const base = {
    id: 'i1',
    partnerPubkey: ALICE,
    fromMe: false,
    createdAt: 5,
    text: 'p',
    wireKind: 14,
  };

  it('maps a valid entry, carrying rumorId', () => {
    const row = inboxEntryToRow(OWNER, { ...base, rumorId: 'r1' });
    expect(row).toMatchObject({ eventId: 'i1', conversation: ALICE, rumorId: 'r1' });
  });

  it('skips order previews (kind 16/17) — the blob held the preview line, not the order JSON', () => {
    expect(inboxEntryToRow(OWNER, { ...base, wireKind: 16 })).toBeNull();
    expect(inboxEntryToRow(OWNER, { ...base, wireKind: 17 })).toBeNull();
  });

  it('rejects malformed entries', () => {
    expect(inboxEntryToRow(OWNER, { ...base, partnerPubkey: 'nope' })).toBeNull();
    expect(inboxEntryToRow(OWNER, { ...base, text: 7 as unknown as string })).toBeNull();
    expect(inboxEntryToRow(OWNER, { ...base, id: '' })).toBeNull();
  });
});

describe('convEntryToRow', () => {
  it('maps a valid message, defaulting wireKind to 14', () => {
    const row = convEntryToRow(OWNER, ALICE, { id: 'm1', fromMe: true, text: 't', createdAt: 3 });
    expect(row).toMatchObject({ conversation: ALICE, sender: OWNER, wireKind: 14 });
  });

  it('rejects malformed messages', () => {
    expect(
      convEntryToRow(OWNER, ALICE, { id: 'm1', fromMe: true, text: 't', createdAt: NaN }),
    ).toBeNull();
    expect(
      convEntryToRow(OWNER, ALICE, { id: '', fromMe: true, text: 't', createdAt: 3 }),
    ).toBeNull();
  });
});
