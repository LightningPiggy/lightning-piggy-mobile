import { resolveStoredNotificationTarget } from './notificationStoredTarget';
import type { NotificationHistoryEntry } from './notificationHistory';
jest.mock('./notificationHistory', () => ({ listNotifications: jest.fn() }));
const entry: NotificationHistoryEntry = {
  id: 'ping',
  kind: 'dm',
  title: 'New message',
  read: false,
  createdAt: 1,
  data: {
    threadKind: 'dm',
    protocol: 'marmot',
    conversationPubkey: 'peer',
    groupId: 'marmot:dm',
    messageId: 'old',
  },
};
it('routes a decrypted placeholder by its rewritten target, with both Marmot identifiers', async () => {
  const lookup = jest.fn().mockResolvedValue([entry]);
  expect(await resolveStoredNotificationTarget('big', 'ping', { lookup })).toEqual({
    ...entry.data,
    kind: 'dm',
    owner: 'big',
  });
  expect(lookup).toHaveBeenCalledWith('big');
});
it('keeps unknown or deleted placeholders on Messages', async () => {
  expect(
    await resolveStoredNotificationTarget('big', 'ping', {
      lookup: async () => [{ ...entry, data: { marmotPush: true } }],
    }),
  ).toBeNull();
  expect(
    await resolveStoredNotificationTarget('big', 'gone', { lookup: async () => [entry] }),
  ).toBeNull();
});
it('ignores a late read once a newer tap/account/navigation has superseded it', async () => {
  let stopped = false;
  const lookup = async () => {
    stopped = true;
    return [entry];
  };
  expect(
    await resolveStoredNotificationTarget('big', 'ping', { lookup, shouldStop: () => stopped }),
  ).toBeNull();
});

it('retains a rewritten shop order target without a conversation route', async () => {
  const data = { shopOrderId: 'o1', shopBuyerPubkey: 'buyer' };
  expect(
    await resolveStoredNotificationTarget('big', 'ping', {
      lookup: async () => [{ ...entry, data }],
    }),
  ).toEqual({ ...data, kind: 'dm', owner: 'big' });
});
