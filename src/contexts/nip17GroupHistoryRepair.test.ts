import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocalDb } from '../services/localDb';
import { getConversationMessages, upsertDmMessages } from '../services/dmDb';
import { appendGroupMessage, loadGroupMessages } from '../services/groupMessagesStorageService';
import { saveGroups } from '../services/groupsStorageService';
import type { Group } from '../types/groups';
import { rumorEventId, type DecodedRumor } from '../utils/nip17Unwrap';
import { nip17GroupHistoryRepairKey, repairNip17GroupHistory } from './nip17GroupHistoryRepair';

jest.mock('@op-engineering/op-sqlite', () =>
  jest.requireActual('../services/testUtils/nodeSqliteOpSqlite').nodeSqliteOpSqlite(),
);
jest.mock('../services/localDbKey', () => ({
  getOrCreateLocalDbKey: jest.fn(async () => 'k'),
  clearLocalDbKey: jest.fn(async () => {}),
}));
jest.mock('../services/groupMessagesMigration', () => ({
  ensureGroupMessagesMigrated: jest.fn(async () => {}),
}));
const mockYield = jest.fn(async () => {});
const mockDispose = jest.fn();
jest.mock('./nostrDecryptPacing', () => ({
  NIP17_LOOP_YIELD_EVERY: 2,
  createYieldScheduler: jest.fn(() => ({ maybeYield: mockYield, dispose: mockDispose })),
}));
jest.mock('./nostrEventBus', () => ({ notifyDmMessage: jest.fn(), notifyGroupMessage: jest.fn() }));

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const THIRD = 'c'.repeat(64);
const WRAP = 'd'.repeat(64);
const group: Group = {
  id: 'pals',
  name: 'Piggy Pals',
  memberPubkeys: [PEER],
  createdAt: 1,
  updatedAt: 1,
};
const rumor = (over: Partial<DecodedRumor> = {}): DecodedRumor => ({
  pubkey: PEER,
  created_at: 100,
  kind: 14,
  tags: [['p', ME]],
  content: 'mention test',
  ...over,
});
const resolve = jest.fn(async (ids: string[]) => new Map(ids.map((id) => [id, rumor()])));
const direct = () => getConversationMessages(ME, PEER, { limit: 100, protocol: 'nip17' });
async function seed(id = WRAP, room = group) {
  await appendGroupMessage(ME, room.id, {
    id,
    senderPubkey: PEER,
    text: 'mention test',
    createdAt: 100,
    wireKind: 14,
  });
}
beforeEach(async () => {
  await AsyncStorage.clear();
  await (await getLocalDb()).execute('DELETE FROM dm_messages;');
  jest.clearAllMocks();
  resolve.mockImplementation(async (ids) => new Map(ids.map((id) => [id, rumor()])));
  await saveGroups(ME, [group]);
  await seed();
});

it('moves the misfiled row into the direct thread and persists completion', async () => {
  await AsyncStorage.setItem(`nostr_group_activity_${ME}`, 'stale mention preview');
  expect(await repairNip17GroupHistory(ME, resolve)).toBe(true);
  expect(await loadGroupMessages(ME, group.id)).toEqual([]);
  expect(await direct()).toMatchObject([
    { eventId: WRAP, rumorId: rumorEventId(rumor()), content: 'mention test', fromMe: false },
  ]);
  expect(await AsyncStorage.getItem(nip17GroupHistoryRepairKey(ME))).toBe('1');
  expect(await AsyncStorage.getItem(`nostr_group_activity_${ME}`)).toBeNull();
  expect(mockYield).toHaveBeenCalled();
  expect(mockDispose).toHaveBeenCalled();
});

it('does no reads/decrypts or writes on a completed re-run', async () => {
  await repairNip17GroupHistory(ME, resolve);
  resolve.mockClear();
  expect(await repairNip17GroupHistory(ME, resolve)).toBe(true);
  expect(resolve).not.toHaveBeenCalled();
  expect(await direct()).toHaveLength(1);
});

it.each(['wrap', 'rumor'])(
  'deduplicates an already re-ingested DM by %s id, preserving its content',
  async (by) => {
    await upsertDmMessages([
      {
        owner: ME,
        eventId: by === 'wrap' ? WRAP : 'f'.repeat(64),
        rumorId: by === 'rumor' ? rumorEventId(rumor()) : undefined,
        conversation: PEER,
        sender: PEER,
        content: 'existing',
        createdAt: 100,
        fromMe: false,
        wireKind: 14,
      },
    ]);
    await repairNip17GroupHistory(ME, resolve);
    expect(await loadGroupMessages(ME, group.id)).toEqual([]);
    expect(await direct()).toMatchObject([{ content: 'existing' }]);
  },
);

it('keeps marked group-screen messages and subjectless three-person rumors', async () => {
  const marked = 'f'.repeat(64);
  await seed(marked);
  resolve.mockResolvedValueOnce(
    new Map([
      [
        WRAP,
        rumor({
          tags: [
            ['p', ME],
            ['subject', 'Piggy Pals'],
          ],
        }),
      ],
      [
        marked,
        rumor({
          tags: [
            ['p', ME],
            ['p', THIRD],
          ],
        }),
      ],
    ]),
  );
  await repairNip17GroupHistory(ME, resolve);
  expect(await loadGroupMessages(ME, group.id)).toHaveLength(2);
  expect(await direct()).toEqual([]);
});

it('never processes Marmot or groups with three or more members', async () => {
  const marmot = { ...group, id: 'marmot:room', protocol: 'marmot' as const };
  const larger = { ...group, id: 'larger', memberPubkeys: [PEER, THIRD] };
  await saveGroups(ME, [marmot, larger]);
  await seed(WRAP, marmot);
  await seed(WRAP, larger);
  await repairNip17GroupHistory(ME, resolve);
  expect(resolve).not.toHaveBeenCalled();
  expect(await loadGroupMessages(ME, marmot.id)).toHaveLength(1);
  expect(await loadGroupMessages(ME, larger.id)).toHaveLength(1);
});

it('preserves optimistic sends and another account’s history', async () => {
  await seed('local_send');
  await appendGroupMessage(THIRD, group.id, {
    id: WRAP,
    senderPubkey: PEER,
    text: 'other account',
    createdAt: 100,
  });
  await repairNip17GroupHistory(ME, resolve);
  expect(await loadGroupMessages(ME, group.id)).toMatchObject([{ id: 'local_send' }]);
  expect(await loadGroupMessages(THIRD, group.id)).toMatchObject([{ text: 'other account' }]);
  expect(await AsyncStorage.getItem(nip17GroupHistoryRepairKey(THIRD))).toBeNull();
});

it('retains unverifiable rows and retries instead of setting the flag', async () => {
  resolve.mockResolvedValueOnce(new Map());
  expect(await repairNip17GroupHistory(ME, resolve)).toBe(false);
  expect(await loadGroupMessages(ME, group.id)).toHaveLength(1);
  expect(await AsyncStorage.getItem(nip17GroupHistoryRepairKey(ME))).toBeNull();
  expect(await repairNip17GroupHistory(ME, resolve)).toBe(true);
  expect(await direct()).toHaveLength(1);
});

it('does not delete group history on a failed direct-store write', async () => {
  const db = await getLocalDb();
  const transaction = jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
  await expect(repairNip17GroupHistory(ME, resolve)).rejects.toThrow('disk full');
  transaction.mockRestore();
  expect(await loadGroupMessages(ME, group.id)).toHaveLength(1);
  expect(await AsyncStorage.getItem(nip17GroupHistoryRepairKey(ME))).toBeNull();
  expect(mockDispose).toHaveBeenCalled();
});

it('resumes after interruption between the direct write and group deletion without a duplicate', async () => {
  let checks = 0;
  // Initial group + batch + row checks pass, then abort after the direct write.
  expect(await repairNip17GroupHistory(ME, resolve, () => ++checks > 3)).toBe(false);
  expect(await direct()).toHaveLength(1);
  expect(await loadGroupMessages(ME, group.id)).toHaveLength(1);
  await repairNip17GroupHistory(ME, resolve);
  expect(await direct()).toHaveLength(1);
  expect(await loadGroupMessages(ME, group.id)).toEqual([]);
});

it('bounds original-wrap retrieval to batches of 20', async () => {
  for (let i = 0; i < 42; i++) await seed(i.toString(16).padStart(64, '0'));
  await repairNip17GroupHistory(ME, resolve);
  expect(resolve.mock.calls.map(([ids]) => ids.length)).toEqual([20, 20, 3]);
  // All fake wraps resolved to the same rumor: only one direct bubble.
  expect(await direct()).toHaveLength(1);
});

it('moves a sender echo into the partner thread', async () => {
  await appendGroupMessage(ME, group.id, {
    id: WRAP,
    senderPubkey: ME,
    text: 'outgoing',
    createdAt: 101,
  });
  resolve.mockResolvedValueOnce(
    new Map([
      [WRAP, rumor({ pubkey: ME, tags: [['p', PEER]], content: 'outgoing', created_at: 101 })],
    ]),
  );
  await repairNip17GroupHistory(ME, resolve);
  expect(await direct()).toMatchObject([{ fromMe: true, sender: ME, conversation: PEER }]);
});

it('retries storage read failures without marking empty history complete', async () => {
  jest
    .mocked(AsyncStorage.getItem)
    .mockResolvedValueOnce(null) // completion flag
    .mockRejectedValueOnce(new Error('storage unavailable')); // groups list
  await expect(repairNip17GroupHistory(ME, resolve)).rejects.toThrow('storage unavailable');
  expect(await AsyncStorage.getItem(nip17GroupHistoryRepairKey(ME))).toBeNull();
  expect(await loadGroupMessages(ME, group.id)).toHaveLength(1);
});

it('retries a failed group deletion without duplicating the committed direct row', async () => {
  jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('group write failed'));
  await expect(repairNip17GroupHistory(ME, resolve)).rejects.toThrow('group write failed');
  expect(await direct()).toHaveLength(1);
  expect(await loadGroupMessages(ME, group.id)).toHaveLength(1);
  expect(await AsyncStorage.getItem(nip17GroupHistoryRepairKey(ME))).toBeNull();
  expect(await repairNip17GroupHistory(ME, resolve)).toBe(true);
  expect(await direct()).toHaveLength(1);
  expect(await loadGroupMessages(ME, group.id)).toEqual([]);
});
