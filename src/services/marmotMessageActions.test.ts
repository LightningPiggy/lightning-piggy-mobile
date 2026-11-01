import { getEventHash } from 'nostr-tools';

import { DeletionLedger, parseMarmotDeletion } from './marmotDeletions';
import { EditLedger, parseMarmotEdit } from './marmotEdits';
import {
  marmotDeleteDraft,
  marmotDeleteKind,
  marmotEditDraft,
  sendMarmotMessageAction,
} from './marmotMessageActions';
import {
  buildMarmotRumor,
  setMarmotSession,
  type MarmotRumor,
  type MarmotSession,
} from './marmotSession';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const MSG = 'c'.repeat(64);

const chat = (pubkey: string, id = MSG, kind = 9): MarmotRumor => ({
  id,
  pubkey,
  kind,
  content: 'hello',
  tags: [],
  created_at: 1_700_000_000,
});

interface FakeOpts {
  history?: Record<string, MarmotRumor[]>;
  dmGroups?: string[];
  admins?: string[];
  relayOk?: boolean;
  sendThrows?: boolean;
}

function fakeSession(opts: FakeOpts = {}) {
  const calls = {
    sent: [] as { groupId: string; rumor: MarmotRumor }[],
    delivered: [] as { groupId: string; rumor: MarmotRumor }[],
    forgotten: [] as { groupId: string; rumorId: string }[],
  };
  const session = {
    pubkey: ME,
    stop: () => undefined,
    dmGroupIdsWith: async () => opts.dmGroups ?? ['marmot:dm-new', 'marmot:dm-old'],
    queryHistory: async (groupId: string) => opts.history?.[groupId] ?? [],
    getGroup: (groupId: string) => ({ id: groupId, adminPubkeys: opts.admins ?? [ME, PEER] }),
    sendRumor: async (groupId: string, rumor: MarmotRumor) => {
      calls.sent.push({ groupId, rumor });
      if (opts.sendThrows) throw new Error('relay pool down');
      return { 'wss://r1': opts.relayOk ?? true, 'wss://r2': false };
    },
    deliverOwn: (groupId: string, rumor: MarmotRumor) => calls.delivered.push({ groupId, rumor }),
    forgetRumor: async (groupId: string, rumorId: string) => {
      calls.forgotten.push({ groupId, rumorId });
    },
  } as unknown as MarmotSession;
  setMarmotSession(session);
  return calls;
}

afterEach(() => setMarmotSession(null));

describe('rumor construction (White Noise / MDK wire format)', () => {
  it('edit: kind 1009, trimmed text, exactly one e tag → the original', () => {
    expect(marmotEditDraft(MSG.toUpperCase(), '  new text \n', 0, 1000)).toEqual({
      kind: 1009,
      content: 'new text',
      tags: [['e', MSG]],
      created_at: 1000,
    });
  });

  it('edit: refuses empty text (that is a delete, not an edit)', () => {
    expect(marmotEditDraft(MSG, '   ')).toBeNull();
  });

  it('edit: stamped after the previous edit so it always wins (latest created_at)', () => {
    expect(marmotEditDraft(MSG, 'x', 1000, 1000)?.created_at).toBe(1001);
    expect(marmotEditDraft(MSG, 'x', 900, 1000)?.created_at).toBe(1000);
  });

  it('delete: 4891 for an admin removing a kind-9 chat, else kind 5', () => {
    expect(marmotDeleteKind(true, 9)).toBe(4891);
    expect(marmotDeleteKind(false, 9)).toBe(5);
    // MDK: a target it no longer holds, or a non-chat kind, takes the author path.
    expect(marmotDeleteKind(true, undefined)).toBe(5);
    expect(marmotDeleteKind(true, 1068)).toBe(5);
  });

  it('delete: 4891 carries the exact remove payload; kind 5 is empty — one e tag each', () => {
    expect(marmotDeleteDraft(MSG, 4891)).toEqual({
      kind: 4891,
      content: '{"v":1,"action":"remove"}',
      tags: [['e', MSG]],
    });
    expect(marmotDeleteDraft(MSG, 5)).toEqual({ kind: 5, content: '', tags: [['e', MSG]] });
  });

  it('our events parse as the deletion / edit our own inbound path applies', () => {
    const group = { isDm: true, adminPubkeys: [ME, PEER] };
    const removal = buildMarmotRumor(ME, marmotDeleteDraft(MSG, 4891));
    expect(parseMarmotDeletion(removal, group)).toEqual({
      targets: [MSG],
      deleter: ME,
      anyAuthor: true,
    });
    const retraction = buildMarmotRumor(ME, marmotDeleteDraft(MSG, 5));
    expect(parseMarmotDeletion(retraction, group)).toEqual({
      targets: [MSG],
      deleter: ME,
      anyAuthor: false,
    });
    const edit = buildMarmotRumor(ME, marmotEditDraft(MSG, 'v2', 0, 1000)!);
    expect(parseMarmotEdit(edit)).toMatchObject({
      target: MSG,
      content: 'v2',
      editor: ME,
      editedAt: 1000,
    });
  });
});

describe('replay safety (the startup history replay re-delivers our own events)', () => {
  it('a replayed original after our delete stays deleted', () => {
    const ledger = new DeletionLedger();
    const del = buildMarmotRumor(ME, marmotDeleteDraft(MSG, 5));
    ledger.add(parseMarmotDeletion(del, { isDm: false, adminPubkeys: [] })!, 'g');
    expect(ledger.blocks(MSG, ME, 'g')).toBe(true);
    // Re-applying the same deletion is a no-op.
    ledger.add(parseMarmotDeletion(del, { isDm: false, adminPubkeys: [] })!, 'g');
    expect(ledger.blocks(MSG, ME, 'g')).toBe(true);
  });

  it('a replayed older edit never reverts a newer one', () => {
    const ledger = new EditLedger();
    const v2 = parseMarmotEdit(buildMarmotRumor(ME, marmotEditDraft(MSG, 'v2', 0, 1000)!))!;
    const v3 = parseMarmotEdit(buildMarmotRumor(ME, marmotEditDraft(MSG, 'v3', 1000, 1000)!))!;
    ledger.add(v3, 'g');
    ledger.add(v2, 'g');
    ledger.add(v3, 'g');
    expect(ledger.latestFor(MSG, ME, 'g')?.content).toBe('v3');
  });
});

describe('sendMarmotMessageAction', () => {
  it('1:1 delete: lands in the DM group holding the target, as 4891 (both members are admins)', async () => {
    const calls = fakeSession({ history: { 'marmot:dm-old': [chat(ME)] } });
    const result = await sendMarmotMessageAction(ME, { peer: PEER }, MSG, { type: 'delete' });
    expect(result).toEqual({ success: true });
    expect(calls.sent).toHaveLength(1);
    const { groupId, rumor } = calls.sent[0];
    expect(groupId).toBe('marmot:dm-old');
    expect(rumor.kind).toBe(4891);
    expect(rumor.tags).toEqual([['e', MSG]]);
    expect(rumor.id).toBe(getEventHash({ ...rumor, id: undefined } as never));
    // Applied locally through the inbound listeners, once accepted.
    expect(calls.delivered).toEqual([{ groupId: 'marmot:dm-old', rumor }]);
    expect(calls.forgotten).toEqual([]);
  });

  it('group delete by a non-admin: kind 5', async () => {
    const calls = fakeSession({ history: { 'marmot:g': [chat(ME)] }, admins: [PEER] });
    await sendMarmotMessageAction(ME, { groupId: 'marmot:g' }, MSG, { type: 'delete' });
    expect(calls.sent[0].rumor.kind).toBe(5);
    expect(calls.sent[0].rumor.content).toBe('');
  });

  it('falls back to the newest DM when the target is past the history', async () => {
    const calls = fakeSession();
    await sendMarmotMessageAction(ME, { peer: PEER }, MSG, { type: 'delete' });
    expect(calls.sent[0].groupId).toBe('marmot:dm-new');
    expect(calls.sent[0].rumor.kind).toBe(5); // target unknown → author retraction
  });

  it('edit: sends the 1009 and applies it locally', async () => {
    const calls = fakeSession({ history: { 'marmot:g': [chat(ME)] } });
    const result = await sendMarmotMessageAction(ME, { groupId: 'marmot:g' }, MSG, {
      type: 'edit',
      text: ' fixed typo ',
      previousEditedAt: 5,
    });
    expect(result.success).toBe(true);
    expect(calls.sent[0].rumor).toMatchObject({
      kind: 1009,
      content: 'fixed typo',
      tags: [['e', MSG]],
    });
    expect(calls.delivered).toHaveLength(1);
  });

  it('never acts on someone else’s message', async () => {
    const calls = fakeSession({ history: { 'marmot:g': [chat(PEER)] } });
    const result = await sendMarmotMessageAction(ME, { groupId: 'marmot:g' }, MSG, {
      type: 'delete',
    });
    expect(result.success).toBe(false);
    expect(calls.sent).toEqual([]);
  });

  it('no relay accepted: nothing applied, and dropped from history so it cannot replay', async () => {
    const calls = fakeSession({ history: { 'marmot:g': [chat(ME)] }, relayOk: false });
    const result = await sendMarmotMessageAction(ME, { groupId: 'marmot:g' }, MSG, {
      type: 'edit',
      text: 'v2',
    });
    expect(result.success).toBe(false);
    expect(calls.delivered).toEqual([]);
    expect(calls.forgotten).toEqual([{ groupId: 'marmot:g', rumorId: calls.sent[0].rumor.id }]);
  });

  it('a send that throws rolls back the same way', async () => {
    const calls = fakeSession({ history: { 'marmot:g': [chat(ME)] }, sendThrows: true });
    const result = await sendMarmotMessageAction(ME, { groupId: 'marmot:g' }, MSG, {
      type: 'delete',
    });
    expect(result).toEqual({ success: false, error: expect.stringContaining('relay pool down') });
    expect(calls.delivered).toEqual([]);
    expect(calls.forgotten).toHaveLength(1);
  });

  it('an empty edit is refused before sending', async () => {
    const calls = fakeSession({ history: { 'marmot:g': [chat(ME)] } });
    const result = await sendMarmotMessageAction(ME, { groupId: 'marmot:g' }, MSG, {
      type: 'edit',
      text: '  ',
    });
    expect(result.success).toBe(false);
    expect(calls.sent).toEqual([]);
  });

  it('fails cleanly when Marmot is not running for this account', async () => {
    const result = await sendMarmotMessageAction(ME, { peer: PEER }, MSG, { type: 'delete' });
    expect(result.success).toBe(false);
  });
});
