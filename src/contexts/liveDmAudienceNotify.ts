import { audienceAdmits, liveNotificationAudience } from '../services/notificationAudience';
import { fireMessageNotification } from '../services/notificationService';
import { claimWrapNotification, markWrapHandled } from '../services/dmWrapNotificationDedupe';
import { dmThreadId, MARMOT_WELCOME_KIND, protocolForWireKind } from '../utils/dmProtocol';
import { isChatReactionKind } from '../utils/nip17Reactions';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import type { DeferredFollowGateEntry } from './liveSubFollowGate';

// Notify-only for the live DM sub: the follow gate kept a message out of
// Messages (not followed, never replied to), but the Web of Trust tier lets
// its sender notify (friends of friends, or All). Nothing is stored here —
// storage keeps the follow gate; opening the conversation from the alert
// fetches the thread itself.

type AlertEntry = Pick<DmInboxEntry, 'id' | 'partnerPubkey' | 'fromMe' | 'wireKind'>;

/** Fresh inbound 1:1 message whose sender the viewer's live tier admits. */
export function mayAudienceNotify(viewer: string, entry: AlertEntry, fresh: boolean): boolean {
  return (
    fresh &&
    !entry.fromMe &&
    entry.wireKind !== MARMOT_WELCOME_KIND &&
    !isChatReactionKind(entry.wireKind) &&
    audienceAdmits(liveNotificationAudience(viewer), entry.partnerPubkey)
  );
}

/** The alert for `entry`; `body` must already be the redacted row preview. */
export function audienceAlert(viewer: string, entry: AlertEntry, body: string) {
  const protocol = protocolForWireKind(entry.wireKind);
  return {
    owner: viewer,
    kind: 'dm' as const,
    threadId: dmThreadId(entry.partnerPubkey, protocol),
    title: 'New message',
    body,
    data: {
      conversationPubkey: entry.partnerPubkey,
      messageId: entry.id,
      conversationProtocol: protocol,
    },
  };
}

/**
 * Fire the alert once per event id: the claim keeps a redelivery (the row is
 * never stored, so nothing else dedupes it) and the background watch from
 * posting it twice; "handled" keeps the background sync from pinging it again.
 */
export function fireAudienceNotification(viewer: string, entry: AlertEntry, body: string): void {
  markWrapHandled(entry.id);
  if (!claimWrapNotification(entry.id)) return;
  void Promise.resolve(fireMessageNotification(audienceAlert(viewer, entry, body))).catch(
    () => undefined,
  );
}

/**
 * A fresh message the follow gate held while follows loaded, then turned away
 * at reconciliation (not followed): the tier may still let it notify. Two-party
 * room chats are skipped, as on the live drop path.
 */
export function notifyDroppedDeferred(viewer: string, item: DeferredFollowGateEntry): void {
  if (!item.notify || item.groupRumor) return;
  if (!mayAudienceNotify(viewer, item.entry, true)) return;
  fireAudienceNotification(viewer, item.entry, item.notify.body);
}
