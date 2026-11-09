import {
  audienceAdmits,
  audiencePending,
  liveNotificationAudience,
  onNotificationAudience,
} from '../services/notificationAudience';
import { fireMessageNotification, isThreadActivelyViewed } from '../services/notificationService';
import {
  claimWrapNotification,
  markWrapHandled,
  retractContentlessWrapAlert,
  takeContentlessWrapAlert,
} from '../services/dmWrapNotificationDedupe';
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
 * A remote-signer watch's contentless placeholder for this wrap (the watch
 * holds the claim) is REPLACED, as on the live drop path: the real alert is
 * written first, then the placeholder goes.
 */
export function fireAudienceNotification(viewer: string, entry: AlertEntry, body: string): void {
  markWrapHandled(entry.id);
  const placeholder = takeContentlessWrapAlert(entry.id);
  if (!claimWrapNotification(entry.id) && !placeholder) return;
  const alert = audienceAlert(viewer, entry, body);
  void Promise.resolve(fireMessageNotification(alert))
    .then((id) =>
      // Only once the real alert was written (or the thread is on screen).
      placeholder && (id || isThreadActivelyViewed(alert.threadId))
        ? retractContentlessWrapAlert(viewer, entry.id)
        : undefined,
    )
    .catch(() => undefined);
}

/**
 * A fresh message the follow gate held while follows loaded, then turned away
 * at reconciliation (not followed): the tier may still let it notify. Two-party
 * room chats are skipped, as on the live drop path.
 */
export function notifyDroppedDeferred(viewer: string, item: DeferredFollowGateEntry): void {
  if (!item.notify || item.groupRumor) return;
  // Follows usually load before the tier's friends-of-friends set does (it is
  // read from cache once follows are known), so at cold start the audience
  // can't answer yet: park the alert briefly rather than lose it.
  if (audiencePending(liveNotificationAudience(viewer))) {
    park(viewer, item);
    return;
  }
  if (!mayAudienceNotify(viewer, item.entry, true)) return;
  fireAudienceNotification(viewer, item.entry, item.notify.body);
}

// Alerts waiting for the audience, per viewer. Small and short-lived: the
// redacted preview is held in memory only, and dropped on sign-out / switch.
const PARK_MS = 60_000;
const MAX_PARKED = 20;
const parked = new Map<string, { item: DeferredFollowGateEntry; at: number }[]>();

function park(viewer: string, item: DeferredFollowGateEntry): void {
  const key = viewer.toLowerCase();
  const list = parked.get(key) ?? [];
  if (list.length >= MAX_PARKED) list.shift();
  list.push({ item, at: Date.now() });
  parked.set(key, list);
}

onNotificationAudience((owner, audience) => {
  if (audiencePending(audience)) return;
  const list = parked.get(owner);
  if (!list) return;
  parked.delete(owner);
  const cutoff = Date.now() - PARK_MS;
  for (const { item, at } of list) {
    if (at < cutoff || !item.notify) continue;
    if (mayAudienceNotify(owner, item.entry, true))
      fireAudienceNotification(owner, item.entry, item.notify.body);
  }
});

/** Sign-out / account switch: nothing parked may outlive its account. */
export function clearParkedAudienceAlerts(): void {
  parked.clear();
}
