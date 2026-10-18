import { classifyStoredMessage } from './messageContent';
import { npubEncode } from 'nostr-tools/nip19';
import { tryRouteGroupRumor } from '../contexts/nostrGroupRouting';
import { notifyGroupMessage } from '../contexts/nostrEventBus';
import { appendGroupMessage, type GroupMessage } from '../services/groupMessagesStorageService';
import { setKnownGroups, setSyntheticGroupReconciler } from '../services/groupRoutingRegistry';
import type { Group } from '../types/groups';
import { activityFromMessages } from './groupActivity';
import { hasUnreadMention, unreadCount, unreadMentionIds } from './chatUnread';
import { messageMentions } from './chatMentions';
import { classifyRumor, type DecodedRumor } from './nip17Unwrap';
import { syntheticGroupIdForParticipants } from './syntheticGroupId';

jest.mock('../services/groupMessagesStorageService', () => ({ appendGroupMessage: jest.fn() }));
jest.mock('../contexts/nostrEventBus', () => ({ notifyGroupMessage: jest.fn() }));

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const THIRD = 'c'.repeat(64);
const group: Group = {
  id: 'family',
  name: 'Family',
  memberPubkeys: [PEER],
  createdAt: 1000,
  updatedAt: 1000,
};
const rumor = (subject?: string): DecodedRumor => ({
  pubkey: PEER,
  created_at: 20,
  kind: 14,
  tags: [['p', ME], ...(subject === undefined ? [] : [['subject', subject]])],
  content: 'hello',
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(appendGroupMessage).mockResolvedValue([]);
  setKnownGroups([], ME);
  setSyntheticGroupReconciler(null, ME);
});
afterEach(() => {
  setKnownGroups([]);
  setSyntheticGroupReconciler(null);
});

it.each([false, true])('routes a subject-tagged two-member group (fromMe=%s)', async (fromMe) => {
  setKnownGroups([group], ME);
  const message = rumor('Family');
  if (fromMe) {
    message.pubkey = ME;
    message.tags[0] = ['p', PEER];
  }
  expect(classifyRumor(message, ME)).toEqual({
    type: 'group',
    otherParticipants: new Set([PEER]),
    fromMe,
  });
  expect(await tryRouteGroupRumor(message, ME, 'wrap')).toMatchObject({ kind: 'routed', group });
  expect(appendGroupMessage).toHaveBeenCalledWith(ME, group.id, {
    id: 'wrap',
    senderPubkey: message.pubkey,
    text: 'hello',
    wireKind: 14,
    createdAt: 20,
  });
  expect(notifyGroupMessage).toHaveBeenCalledWith(
    group.id,
    expect.objectContaining({ id: 'wrap' }),
  );
});

it('keeps an unknown two-party message without a subject on the 1:1 path', async () => {
  expect(classifyRumor(rumor(), ME)).toEqual({ type: 'dm', partnerPubkey: PEER, fromMe: false });
  expect(await tryRouteGroupRumor(rumor(), ME, 'dm')).toEqual({
    kind: 'not-group',
    deferredGroupRumor: rumor(),
  });
  expect(appendGroupMessage).not.toHaveBeenCalled();
  expect(notifyGroupMessage).not.toHaveBeenCalled();
});

it('keeps subjectless messages in the direct chat despite a known named room', async () => {
  setKnownGroups([group], ME);
  expect(await tryRouteGroupRumor(rumor(), ME, 'later')).toMatchObject({ kind: 'not-group' });
  expect(appendGroupMessage).not.toHaveBeenCalled();
});

it('does not divert a 1:1 to a Marmot room or a different participant set', async () => {
  setKnownGroups(
    [
      { ...group, protocol: 'marmot' },
      { ...group, memberPubkeys: [PEER, THIRD] },
    ],
    ME,
  );
  expect(await tryRouteGroupRumor(rumor(), ME, 'dm')).toEqual({
    kind: 'not-group',
    deferredGroupRumor: rumor(),
  });
  expect(appendGroupMessage).not.toHaveBeenCalled();
});

it('keeps mentions, preview and unread entries in the group instead of falling through to the 1:1', async () => {
  setKnownGroups([group], ME);
  const message = { ...rumor('Family'), content: `Hey nostr:${npubEncode(ME)}` };
  const result = await tryRouteGroupRumor(message, ME, 'mention');
  // Receive callers write to the 1:1 only for not-group. This must consume it.
  expect(result.kind).toBe('routed');
  const stored = jest.mocked(appendGroupMessage).mock.calls[0];
  expect(stored.slice(0, 2)).toEqual([ME, group.id]);
  const messages: GroupMessage[] = [stored[2]];
  const activity = activityFromMessages(group, messages, ME);
  expect(activity.lastText).toBe(message.content);
  expect(hasUnreadMention(activity.lastMentionAt, { at: 10 })).toBe(true);
  const entries = messages.map((m) => ({
    id: m.id,
    createdAt: m.createdAt,
    fromMe: m.senderPubkey === ME,
    mentionsMe: messageMentions(m, ME),
  }));
  expect(unreadCount(entries, { at: 10 })).toBe(1);
  expect(unreadMentionIds(entries, { at: 10 })).toEqual(['mention']);
  expect(hasUnreadMention(activity.lastMentionAt, { at: 20, id: 'mention' })).toBe(false);
});

it('materialises a two-member room and keeps its id and history across a subject rename', async () => {
  const id = syntheticGroupIdForParticipants([ME, PEER]);
  const reconcile = jest.fn(async (input) => {
    const resolved = { ...group, id: input.groupId, name: input.name };
    setKnownGroups([resolved], ME);
    return resolved;
  });
  setSyntheticGroupReconciler(reconcile, ME);
  expect(
    await tryRouteGroupRumor(rumor('Family'), ME, 'first', undefined, () => true),
  ).toMatchObject({
    kind: 'routed',
    group: { id, name: 'Family' },
  });
  expect(
    await tryRouteGroupRumor({ ...rumor('Renamed'), created_at: 30 }, ME, 'rename'),
  ).toMatchObject({
    kind: 'routed',
    group: { id, name: 'Renamed' },
  });
  expect(reconcile).toHaveBeenLastCalledWith({
    groupId: id,
    name: 'Renamed',
    memberPubkeys: [PEER],
    createdAtSec: 30,
  });
  expect(jest.mocked(appendGroupMessage).mock.calls.map((call) => call[1])).toEqual([id, id]);
  expect(await tryRouteGroupRumor(rumor(), ME, 'subjectless')).toMatchObject({
    kind: 'not-group',
  });
  expect(appendGroupMessage).toHaveBeenCalledTimes(2);
});

it('never falls through to the 1:1 when a subject-tagged group cannot yet be resolved', async () => {
  expect(await tryRouteGroupRumor(rumor('Family'), ME, 'pending', undefined, () => true)).toEqual({
    kind: 'group-no-match',
  });
  expect(appendGroupMessage).not.toHaveBeenCalled();
});

it('preserves multi-member group routing without a subject', async () => {
  const larger = { ...group, memberPubkeys: [PEER, THIRD] };
  setKnownGroups([larger], ME);
  const message = rumor();
  message.tags.push(['p', THIRD]);
  expect(await tryRouteGroupRumor(message, ME, 'multi')).toMatchObject({
    kind: 'routed',
    group: larger,
  });
});

it('preserves kind-15 document metadata when routing a multi-recipient rumor', async () => {
  const room = { ...group, memberPubkeys: [PEER, THIRD] };
  setKnownGroups([room], ME);
  const message: DecodedRumor = {
    ...rumor(),
    kind: 15,
    content: 'https://example.com/cipher',
    tags: [
      ['p', ME],
      ['p', THIRD],
      ['file-type', 'application/pdf'],
      ['filename', 'invoice.pdf'],
      ['decryption-key', '11'.repeat(32)],
      ['decryption-nonce', '22'.repeat(12)],
      ['x', '33'.repeat(32)],
      ['size', '123'],
    ],
  };
  const routed = await tryRouteGroupRumor(message, ME, 'document');
  expect(routed.kind).toBe('routed');
  const stored = jest.mocked(appendGroupMessage).mock.calls[0][2];
  expect(stored.wireKind).toBe(15);
  expect(classifyStoredMessage(stored.text, stored.wireKind)).toMatchObject({
    kind: 'file',
    file: {
      name: 'invoice.pdf',
      keyHex: '11'.repeat(32),
      nonceHex: '22'.repeat(12),
      sha256: '33'.repeat(32),
    },
  });
});
