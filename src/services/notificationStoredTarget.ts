import { listNotifications, type NotificationHistoryEntry } from './notificationHistory';
import type { NotificationData } from './notificationService';

/** A generic Marmot tray ping can outlive its decrypted, rewritten history row. */
export async function resolveStoredNotificationTarget(
  owner: string,
  historyId: string,
  {
    shouldStop = () => false,
    lookup = listNotifications,
  }: {
    shouldStop?: () => boolean;
    lookup?: (owner: string) => Promise<NotificationHistoryEntry[]>;
  } = {},
): Promise<(NotificationData & { kind: string }) | null> {
  if (shouldStop()) return null;
  const entry = (await lookup(owner).catch(() => [])).find((e) => e.id === historyId);
  if (shouldStop() || !entry || (entry.kind !== 'dm' && entry.kind !== 'group')) return null;
  if (
    !entry.data.conversationPubkey &&
    !entry.data.groupId &&
    !entry.data.shopOrderId &&
    !entry.data.myOrderId &&
    !entry.data.shopEventId
  )
    return null;
  return { ...entry.data, kind: entry.kind, owner };
}
