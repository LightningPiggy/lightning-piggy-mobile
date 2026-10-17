// The #1320 rumor-id backfill over the real store SQL (localDb.ts schema on
// Node's built-in SQLite).
jest.mock('@op-engineering/op-sqlite', () =>
  require('../services/testUtils/nodeSqliteOpSqlite').nodeSqliteOpSqlite(),
);
jest.mock('../services/localDbKey', () => ({
  getOrCreateLocalDbKey: jest.fn(() => Promise.resolve('k')),
  clearLocalDbKey: jest.fn(() => Promise.resolve()),
}));

import { getConversationMessages, upsertDmMessages, type DmMessageRow } from '../services/dmDb';
import { getLocalDb } from '../services/localDb';
import { rumorEventId, type DecodedRumor } from '../utils/nip17Unwrap';
import type { RawGiftWrapEvent } from '../services/nostrService';
import { __resetRumorIdBackfillForTests, backfillThreadRumorIds } from './dmRumorIdBackfill';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);

const row = (eventId: string, over: Partial<DmMessageRow> = {}): DmMessageRow => ({
  owner: ME,
  eventId,
  conversation: PEER,
  createdAt: 100,
  sender: PEER,
  content: eventId,
  fromMe: false,
  wireKind: 14,
  ...over,
});
const rumorFor = (id: string): DecodedRumor => ({
  pubkey: PEER,
  created_at: 100,
  kind: 14,
  tags: [['p', ME]],
  content: id,
});
const wrap = (id: string) => ({ id }) as unknown as RawGiftWrapEvent;

beforeEach(async () => {
  __resetRumorIdBackfillForTests();
  await (await getLocalDb()).execute('DELETE FROM dm_messages;');
});

it('fills missing rumor ids from the fetched wraps, leaving existing ids alone', async () => {
  await upsertDmMessages([
    row('w-old'),
    row('w-has', { rumorId: 'kept' }),
    row('w-unfetched'),
    row('w-other', { conversation: OTHER }),
  ]);
  const unwrap = jest.fn((w: RawGiftWrapEvent) => rumorFor(w.id));

  const filled = await backfillThreadRumorIds({
    owner: ME,
    conversation: PEER,
    wraps: [wrap('w-old'), wrap('w-has'), wrap('w-other')],
    unwrap,
  });

  expect([...filled]).toEqual([['w-old', rumorEventId(rumorFor('w-old'))]]);
  // Only the thread's id-less rows are decrypted.
  expect(unwrap.mock.calls.map(([w]) => w.id)).toEqual(['w-old']);
  const ids = Object.fromEntries(
    (await getConversationMessages(ME, PEER)).map((r) => [r.eventId, r.rumorId]),
  );
  expect(ids).toEqual({
    'w-old': rumorEventId(rumorFor('w-old')),
    'w-has': 'kept',
    'w-unfetched': undefined,
  });
});

it('skips wraps that no longer decrypt and writes nothing when aborted', async () => {
  await upsertDmMessages([row('w-bad'), row('w-good')]);
  const controller = new AbortController();
  const filled = await backfillThreadRumorIds({
    owner: ME,
    conversation: PEER,
    wraps: [wrap('w-bad'), wrap('w-good')],
    unwrap: (w) => {
      if (w.id === 'w-bad') throw new Error('bad mac');
      controller.abort();
      return rumorFor(w.id);
    },
    signal: controller.signal,
  });
  expect(filled.size).toBe(0);
  expect((await getConversationMessages(ME, PEER)).every((r) => !r.rumorId)).toBe(true);
});

it('fetches the missing wraps by id on a warm store (the thread fetch returned none)', async () => {
  await upsertDmMessages([row('w-old'), row('w-gone')]);
  const fetchWraps = jest.fn(async (ids: string[]) =>
    ids.filter((id) => id !== 'w-gone').map(wrap),
  );
  const filled = await backfillThreadRumorIds({
    owner: ME,
    conversation: PEER,
    wraps: [],
    fetchWraps,
    unwrap: (w) => rumorFor(w.id),
  });
  expect(fetchWraps.mock.calls[0][0].sort()).toEqual(['w-gone', 'w-old']);
  expect([...filled]).toEqual([['w-old', rumorEventId(rumorFor('w-old'))]]);
  const byId = Object.fromEntries(
    (await getConversationMessages(ME, PEER)).map((r) => [r.eventId, r.rumorId]),
  );
  expect(byId['w-old']).toBe(rumorEventId(rumorFor('w-old')));

  // A wrap no relay holds any more isn't asked for again on the next open.
  await backfillThreadRumorIds({
    owner: ME,
    conversation: PEER,
    wraps: [],
    fetchWraps,
    unwrap: (w) => rumorFor(w.id),
  });
  expect(fetchWraps).toHaveBeenCalledTimes(1);
});

it('reaches older rows past wraps no relay holds', async () => {
  // 101 id-less rows, newest first: the newest 100 are gone from every relay.
  await upsertDmMessages(
    Array.from({ length: 101 }, (_, i) =>
      row(`w-${String(i).padStart(3, '0')}`, { createdAt: 1000 - i }),
    ),
  );
  const fetchWraps = jest.fn(async (ids: string[]) => ids.filter((id) => id === 'w-100').map(wrap));
  const run = () =>
    backfillThreadRumorIds({
      owner: ME,
      conversation: PEER,
      wraps: [],
      fetchWraps,
      unwrap: (w) => rumorFor(w.id),
    });
  expect((await run()).size).toBe(0);
  expect(fetchWraps.mock.calls[0][0]).toHaveLength(100);
  // The next open skips the 100 already asked for and reaches the oldest.
  expect([...(await run()).keys()]).toEqual(['w-100']);
  expect(fetchWraps.mock.calls[1][0]).toEqual(['w-100']);
});

it('asks again after the save fails', async () => {
  await upsertDmMessages([row('w-save')]);
  const db = await getLocalDb();
  const fetchWraps = jest.fn(async (ids: string[]) => ids.map(wrap));
  const run = () =>
    backfillThreadRumorIds({
      owner: ME,
      conversation: PEER,
      wraps: [],
      fetchWraps,
      unwrap: (w) => rumorFor(w.id),
    });
  const spy = jest.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('disk full'));
  await expect(run()).rejects.toThrow('disk full');
  spy.mockRestore();
  expect([...(await run()).keys()]).toEqual(['w-save']);
  expect(fetchWraps).toHaveBeenCalledTimes(2);
});

it('keeps rows retryable when it could not look anything up (no relays)', async () => {
  await upsertDmMessages([row('w-old')]);
  // No fetcher: the caller had no relays to ask.
  await backfillThreadRumorIds({
    owner: ME,
    conversation: PEER,
    wraps: [],
    unwrap: (w) => rumorFor(w.id),
  });
  const fetchWraps = jest.fn(async (ids: string[]) => ids.map(wrap));
  const filled = await backfillThreadRumorIds({
    owner: ME,
    conversation: PEER,
    wraps: [],
    fetchWraps,
    unwrap: (w) => rumorFor(w.id),
  });
  expect(fetchWraps).toHaveBeenCalledWith(['w-old']);
  expect(filled.get('w-old')).toBe(rumorEventId(rumorFor('w-old')));
});
