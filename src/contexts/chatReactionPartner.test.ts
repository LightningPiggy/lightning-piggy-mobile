// Placing our own reactions sent by another client (#1321), over the real
// store SQL (localDb.ts schema on Node's built-in SQLite).
jest.mock('@op-engineering/op-sqlite', () =>
  require('../services/testUtils/nodeSqliteOpSqlite').nodeSqliteOpSqlite(),
);
jest.mock('../services/localDbKey', () => ({
  getOrCreateLocalDbKey: jest.fn(() => Promise.resolve('k')),
  clearLocalDbKey: jest.fn(() => Promise.resolve()),
}));

import { upsertDmMessages } from '../services/dmDb';
import { getLocalDb } from '../services/localDb';
import { partnerFromRumor, type DecodedRumor } from '../utils/nip17Unwrap';
import { placeOwnChatReaction } from './chatReactionPartner';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const MSG = '1'.repeat(64);
const REACTION = '2'.repeat(64);

const rumor = (over: Partial<DecodedRumor>): DecodedRumor => ({
  pubkey: ME,
  created_at: 10,
  kind: 5,
  content: '',
  tags: [],
  ...over,
});
const place = (r: DecodedRumor) => placeOwnChatReaction(r, ME, partnerFromRumor(r, ME));

beforeAll(async () => {
  await (await getLocalDb()).execute('DELETE FROM dm_messages;');
  const base = { owner: ME, conversation: PEER, createdAt: 1, sender: PEER, fromMe: false };
  await upsertDmMessages([
    { ...base, eventId: 'w-msg', content: 'hi', wireKind: 14, rumorId: MSG },
    { ...base, eventId: 'w-react', content: '{}', wireKind: 7, rumorId: REACTION, sender: ME },
  ]);
});

it('places a retraction with only e / k by the reaction it names', async () => {
  const deletion = rumor({
    tags: [
      ['e', REACTION],
      ['k', '7'],
    ],
  });
  expect(partnerFromRumor(deletion, ME)).toBeNull();
  expect(await place(deletion)).toEqual({ partnerPubkey: PEER, fromMe: true });
});

it('places a reaction to our own message that tags only us', async () => {
  const reaction = rumor({
    kind: 7,
    content: '👍',
    tags: [
      ['e', MSG],
      ['p', ME],
    ],
  });
  expect(await place(reaction)).toEqual({ partnerPubkey: PEER, fromMe: true });
});

it('leaves peers, tagged reactions and unknown targets alone', async () => {
  const fromPeer = rumor({
    pubkey: PEER,
    kind: 7,
    tags: [
      ['e', MSG],
      ['p', ME],
    ],
  });
  expect(await place(fromPeer)).toEqual({ partnerPubkey: PEER, fromMe: false });
  const unknown = rumor({
    tags: [
      ['e', '9'.repeat(64)],
      ['k', '7'],
    ],
  });
  expect(await place(unknown)).toBeNull();
  const message = rumor({ kind: 14, content: 'note to self', tags: [['p', ME]] });
  expect(await place(message)).toEqual({ partnerPubkey: ME, fromMe: true });
});
