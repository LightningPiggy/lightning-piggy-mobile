import {
  getLockScreenContentEnabled,
  resetLockScreenContentPreference,
} from './notificationContentPreference';
import { noteMarmotMessageShown, resetMarmotMessageTracking } from './notificationMarmotTracking';
import {
  canonicalMessageTarget,
  type MessageNotificationTarget,
} from '../utils/notificationRouting';
import { genericFor } from './notificationDisplay';
import { sanitizeDisplayText } from '../utils/sanitizeDisplayText';
import { shouldMuteNotification } from './mutedSenders';
import { mutedNotificationPresentation } from './mutedNotificationPresentation';
import { getAppFormatLocale } from '../utils/appFormatLocale';
/**
 * notificationService — single integration point for OS-level
 * notifications surfaced from anywhere in the app (DM rumors, group
 * messages, incoming on-chain / Lightning payments, zaps).
 *
 * Architectural commitments (see docs/architecture/notifications.adoc):
 *
 * 1. Local-first: NO Google Play Services needed. The app must work on
 *    GrapheneOS, microG, and other un-googled devices, so every alert with
 *    content is an `expo-notifications` LOCAL notification. The one remote
 *    path is the OPT-IN Marmot push (MIP-05, off by default): a
 *    content-free "New message" wake via FCM / APNs and our notification
 *    server — see marmotPushRegistration.ts / marmotPushWake.ts. Background wake-up
 *    (so we can decide to fire a notification while the UI isn't mounted)
 *    is done by `expo-background-task` — WorkManager on Android,
 *    BGTaskScheduler on iOS (see src/services/backgroundTask.ts) — both
 *    FCM-free. On Android there is ALSO an opt-in realtime path: a
 *    persistent foreground service holding a live relay socket
 *    (src/services/backgroundDmService.ts; manifest perms in
 *    plugins/withForegroundService.js) that posts content notifications
 *    the moment a message arrives — still local-only, no FCM.
 *
 * 2. Permission is requested once, from the foreground, at app launch via
 *    `requestNotificationPermission()`. Fire paths only ever *check*
 *    permission (`hasNotificationPermission()`) and never prompt — a
 *    headless/background task must not present a permission dialog.
 *
 * 3. Per-channel mute. Android 8+ channels split notifications into
 *    "Messages" and "Payments" so the user can mute one without the
 *    other from system Settings. Per-channel UI inside the app is a
 *    follow-up.
 *
 * 4. Privacy. Notification body content (e.g. decrypted DM plaintext)
 *    is NOT sent to the lock screen by default — we show a generic
 *    "New message" until the user explicitly opts in. See
 *    `setLockScreenContentEnabled`.
 *
 * 5. Generic foundation. Callers fire typed `NotificationPayload`
 *    objects rather than each call site assembling raw expo arguments.
 *    This is the seam that lets us swap the backing library or add
 *    grouping / quiet hours / badge counts later without touching the
 *    triggers.
 */
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import {
  markNotificationDelivered,
  markNotificationsReadWhere,
  recordNotification,
  removeNotificationsWhere,
} from './notificationHistory';
import { getActivePubkey, subscribeActivePubkey } from './walletStorageService';
import {
  __resetNotificationFocusForTests,
  isCacheActivelyViewed,
  isThreadActivelyViewed,
} from './notificationFocus';
import {
  isWatcherValidation,
  showWatcherPushInForeground,
  watcherCategoryOf,
} from './watcherPushReceive';
import type { DmProtocol } from '../utils/dmProtocol';

export {
  getLockScreenContentEnabled,
  setLockScreenContentEnabled,
} from './notificationContentPreference';
export { marmotMessageShown } from './notificationMarmotTracking';

// Android notification channel ids. Stable strings — changing them
// orphans the user's per-channel mute state in system Settings.
const CHANNEL_MESSAGES = 'messages';
const CHANNEL_PAYMENTS = 'payments';
// LOW importance: catch-up payments land in the shade with no sound or
// heads-up, even if the app is backgrounded before the post fires.
const CHANNEL_PAYMENTS_QUIET = 'payments-quiet';
// Low-importance channel for the persistent "watching for messages"
// foreground-service notification (#279 realtime upgrade). LOW so it
// never buzzes or pops a banner — it's the ongoing status chip Android
// requires a foreground service to display, not an alert. Kept on its
// own channel so the user can mute the chip independently of real
// message / payment alerts.
export const CHANNEL_BACKGROUND_SERVICE = 'background-service';

// Fixed notification id for the foreground-service ongoing chip. Stable
// so the background DM service can update (sender-name churn) or dismiss
// the same single notification rather than stacking duplicates.
export const FOREGROUND_SERVICE_NOTIFICATION_ID = 'lp-bg-dm-foreground';

// Persisted user preferences for notification behaviour. Defaults are
// privacy-preserving (lock-screen body content OFF) per constraint #4
// from issue #279.
const PERMISSION_REQUESTED_KEY = 'notif_pref_permission_asked_v1';

/** Discriminator for the notification's source. Drives:
 *  - which Android channel it lands in (`messages` vs `payments`)
 *  - default title / icon when the caller doesn't override
 *  - tap-routing decisions (see `data` payload below)
 *
 * Add a new kind here BEFORE adding a new caller — keeps the routing
 * logic exhaustive.
 */
export type NotificationKind = 'dm' | 'group' | 'payment' | 'zap' | 'cache' | 'swap' | 'market';

/** Tap-routing data shipped with every notification. The deep-link
 * router (TODO — follow-up) reads these on tap to navigate to the
 * relevant screen. Optional fields by `kind`:
 *
 *  - dm        → conversationPubkey (open the 1:1 thread)
 *  - group     → groupId (open the group thread)
 *  - payment   → walletId (open that wallet's history)
 *  - zap       → conversationPubkey OR groupId (zap context)
 *  - cache     → cacheCoord (open the cache detail; #740)
 */
export interface NotificationData extends Partial<MessageNotificationTarget> {
  listingCoord?: string;
  feedbackTab?: 'comments' | 'reviews';
  groupInvitation?: boolean;
  shopOrderId?: string;
  myOrderId?: string;
  orderSellerPubkey?: string;
  shopEventId?: string;
  shopBuyerPubkey?: string;
  conversationPubkey?: string;
  conversationProtocol?: DmProtocol;
  groupId?: string;
  walletId?: string;
  /** `<kind>:<pubkey>:<d>` coordinate of the geo-cache the find-log
   * targets. Read on tap to open HuntPiggyDetail (#740). */
  cacheCoord?: string;
  /** Links a tray notification to its in-app history row (#1143). */
  historyId?: string;
  /** Post without a heads-up banner or sound — drawer + history only. Read by
   * the foreground handler; used for catch-up payments found on app open. */
  quiet?: boolean;
  /** NIP-17 gift-wrap id of a message the background couldn't decrypt: on
   * tap, its conversation is resolved once the app has decrypted it (#1154). */
  wrapId?: string;
  /** Account the notification belongs to, so clearing stays per account. */
  owner?: string;
  /** The generic "New message" a Marmot push wake posted (Android). */
  marmotPush?: boolean;
  /** Marmot app-event id of the message shown — lets a "delete for everyone"
   * clear the tray notification that still carries its text. */
  messageId?: string;
  marmotGroupId?: string;
  senderPubkey?: string;
  /** Weekly key-backup reminder (kind 'keyBackup', #1546): the account to back up. */
  keyBackupPubkey?: string;
}

/** Typed payload every caller passes to `fireNotification`. Centralising
 * this shape is the whole point of this service — call sites should
 * NEVER reach into expo-notifications directly. */
export interface NotificationPayload {
  kind: NotificationKind;
  title: string;
  /** Plaintext body. May be redacted on the lock screen — see
   * `setLockScreenContentEnabled` / `getLockScreenContentEnabled`. */
  body: string;
  data?: NotificationData;
  /** Account the notification belongs to, for the in-app history (#1143).
   * Background workers pass the identity they loaded (the React-hydrated
   * active pubkey is unset in a headless run); defaults to the active one. */
  owner?: string;
  /** Stable source id (e.g. a payment hash) so a retried notification
   * doesn't add a second history row. */
  historyKey?: string;
  /** Source event time in epoch ms, preserving catch-up history order. */
  historyCreatedAt?: number;
  /** Preference/account gate checked before recording any history. */
  mayRecord?: () => Promise<boolean>;
  /** Called after the history write completes, even when no OS alert is sent. */
  onHistoryRecorded?: () => void;
  /** Rechecked immediately before scheduling, including durable deletion state. */
  shouldSuppress?: () => Promise<boolean>;
}

let initialisingPromise: Promise<void> | null = null;

/**
 * Idempotent. Sets the foreground-presentation behaviour and creates
 * the Android channels. Safe to call from anywhere; subsequent calls
 * are no-ops.
 *
 * Foreground behaviour: we DO show notifications in the foreground
 * (`shouldShowBanner: true`) because the app's tab structure means a
 * user reading their wallet won't see a new DM unless we surface it.
 * If this gets noisy (e.g. they're actively in the conversation),
 * the trigger site is responsible for skipping the call — not the
 * presentation layer.
 */
export async function ensureNotificationsInitialised(): Promise<void> {
  // Memoise the in-flight init so concurrent callers await the SAME promise
  // and never return before the Android channels exist (Android drops a
  // notification scheduled before its channel is created). Resets to null on
  // failure so a transient error can be retried.
  if (initialisingPromise) return initialisingPromise;
  initialisingPromise = (async () => {
    try {
      await initialiseInternal();
    } catch (e) {
      initialisingPromise = null;
      throw e;
    }
  })();
  return initialisingPromise;
}

async function initialiseInternal(): Promise<void> {
  Notifications.setNotificationHandler({
    // A remote (Marmot) push while the app is open is redundant: the live
    // session shows the real message itself, so the generic one stays quiet.
    handleNotification: async (notification) => {
      const muted = await mutedNotificationPresentation(notification);
      if (muted) return muted;
      // The notification watcher's generic alert: the open app already shows
      // what it announces (see showWatcherPushInForeground).
      const watcher = watcherCategoryOf(notification.request);
      // The watcher's silent admission check (iOS) is never shown.
      if (isWatcherValidation(notification.request)) {
        return {
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        };
      }
      if (watcher || isRemotePush(notification)) {
        // Android's push is a data-only wake with nothing to show — the wake
        // task (marmotPushWake) owns its generic alert. iOS's carries the
        // server's alert: shown unless the app has the message already.
        const show = watcher
          ? showWatcherPushInForeground(watcher)
          : Platform.OS === 'ios' && !(await remotePushCoveredInForeground());
        return {
          shouldShowBanner: show,
          shouldShowList: show,
          shouldPlaySound: show,
          shouldSetBadge: false,
        };
      }
      // A `quiet` notification still lands in the drawer, just without the
      // heads-up banner or sound (Android: expo marks it silent, which also
      // stops the HIGH channel from popping it).
      const quiet = notification.request.content.data?.quiet === true;
      return {
        shouldShowBanner: !quiet,
        shouldShowList: true,
        shouldPlaySound: !quiet,
        shouldSetBadge: false,
      };
    },
  });

  if (Platform.OS === 'android') {
    // Channel importance HIGH = pop-up banner + sound. Users can mute
    // either channel from system Settings without affecting the other.
    // Group payment notifications onto their own channel so a user who
    // wants payment alerts but no message alerts (or vice versa) can
    // configure that without uninstalling the app.
    await Notifications.setNotificationChannelAsync(CHANNEL_MESSAGES, {
      name: 'Messages',
      importance: Notifications.AndroidImportance.HIGH,
      // Show the channel description in system Settings so the user
      // knows what each channel covers when they go to mute one.
      description: 'New direct messages and group messages',
      // PRIVATE = the notification appears on the lock screen but the OS
      // honours the user's system-level "hide sensitive content" setting.
      // We deliberately do NOT use SECRET here: SECRET hides the entry
      // entirely even after the user opts into lock-screen content via
      // `setLockScreenContentEnabled`, which would make that toggle a
      // no-op on Android. Body redaction is enforced in `fireNotification`
      // (generic copy substitution) regardless of channel visibility.
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL_PAYMENTS, {
      name: 'Payments',
      importance: Notifications.AndroidImportance.HIGH,
      description: 'Incoming Lightning, on-chain payments, and zaps',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
    });
    await Notifications.setNotificationChannelAsync(CHANNEL_PAYMENTS_QUIET, {
      name: 'Earlier payments',
      importance: Notifications.AndroidImportance.LOW,
      description: 'Payments that arrived while the app was closed, shown quietly',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
      // Explicitly silent, not just LOW importance: a user who raises the
      // channel's importance in Settings still gets no sound or buzz.
      sound: null,
      enableVibrate: false,
    });
    // Importance LOW = no sound, no heads-up banner. This is the channel
    // the persistent foreground-service chip rides on (#279 realtime
    // upgrade): Android requires a foreground service to show an ongoing
    // notification, but it should be a silent status chip, not an alert.
    await Notifications.setNotificationChannelAsync(CHANNEL_BACKGROUND_SERVICE, {
      name: 'Background messages and payments',
      importance: Notifications.AndroidImportance.LOW,
      description:
        'The persistent status shown while Lightning Piggy watches messages and checks payments',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}

/**
 * Check-only: is notification permission currently granted? Never
 * prompts. This is the ONLY permission call safe to make from a
 * background / headless context (a fire path), where presenting the
 * OS permission dialog is impossible and would throw or no-op.
 */
export async function hasNotificationPermission(): Promise<boolean> {
  await ensureNotificationsInitialised();
  const existing = await Notifications.getPermissionsAsync();
  return existing.granted;
}

/**
 * Foreground-only permission request. MUST be called from a mounted UI
 * context (e.g. app launch in App.tsx) — never from the background sync
 * task, which cannot present a dialog. First call asks the OS; once the
 * user has been asked and denied (and can't be re-asked), subsequent
 * calls short-circuit so we never spin the dialog. Returns whether
 * permission is granted afterwards.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  await ensureNotificationsInitialised();

  const existing = await Notifications.getPermissionsAsync();
  if (existing.granted) return true;
  // `canAskAgain` becomes false when the user has tapped "Don't allow"
  // on iOS or denied with "Don't ask again" on Android 13+. Re-asking
  // would be a silent no-op and a UX miss; bail.
  if (existing.status === 'denied' && !existing.canAskAgain) return false;

  // We've asked before in a previous session AND been denied — don't
  // re-ask on every launch, only once per install.
  const alreadyAsked = await AsyncStorage.getItem(PERMISSION_REQUESTED_KEY);
  if (alreadyAsked === 'true' && existing.status === 'denied') return false;

  await AsyncStorage.setItem(PERMISSION_REQUESTED_KEY, 'true').catch(() => {});
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

/** Map a `NotificationKind` to the Android channel id it should fire on.
 *
 * `cache` (find-logs on the user's geo-caches, #740) deliberately rides on
 * the existing Messages channel rather than introducing a third channel.
 * A new channel would orphan every user's existing per-channel mute
 * settings, and a find-log is conversationally similar to a DM (someone
 * pinging you about something you published) — the user who muted
 * Messages almost certainly wants find-logs muted too. If demand for an
 * independent "Hunt" channel surfaces, add it later with a careful
 * migration; until then sharing the channel is the lower-friction default.
 */
function channelForKind(kind: NotificationKind): string {
  switch (kind) {
    case 'dm':
    case 'group':
    case 'cache':
    case 'market':
      return CHANNEL_MESSAGES;
    case 'payment':
    case 'zap':
    case 'swap':
      return CHANNEL_PAYMENTS;
  }
}

/**
 * Fire a local notification.
 *
 * Returns the scheduled-notification id on success, or `null` if we
 * couldn't fire (no permission yet, or expo-notifications threw).
 * We swallow exceptions — a notification failing should never crash
 * the trigger path that called us.
 *
 * Concurrency: safe to call from anywhere (no shared mutable state
 * after init), INCLUDING the background sync task — it only ever
 * *checks* permission (`hasNotificationPermission`), never prompts.
 */
const inFlightNotifications = new Set<{ data: NotificationData; cancelled: boolean }>();

export async function fireNotification(payload: NotificationPayload): Promise<string | null> {
  payload = {
    ...payload,
    title: sanitizeDisplayText(payload.title, { maxLen: 128 }),
    body: sanitizeDisplayText(payload.body, { maxLen: 2000, allowNewlines: true }),
  };
  const flight = {
    data: { ...payload.data, owner: payload.owner ?? getActivePubkey() ?? undefined },
    cancelled: false,
  };
  inFlightNotifications.add(flight);
  try {
    // Record history even without OS permission; muted senders never alert.
    const owner = payload.owner ?? getActivePubkey() ?? undefined;
    if (await shouldMuteNotification(owner, payload.data, payload.kind)) return null;
    if (payload.mayRecord && !(await payload.mayRecord())) return null;
    const collapseKey = threadCollapseKey(payload.kind, payload.data);
    // Awaited (best-effort, never throws): a headless background task can be
    // torn down as soon as delivery resolves, losing a detached write.
    const { duplicateDelivered, id: historyId } = await recordNotification(
      owner ?? null,
      {
        ...payload,
        id: payload.historyKey ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        collapseKey,
      },
      payload.historyCreatedAt,
    );
    payload.onHistoryRecorded?.();
    // Same source already shown in the tray: report it as delivered (so the
    // caller doesn't keep retrying) without posting a second entry.
    if (duplicateDelivered) return historyId;
    if (await payload.shouldSuppress?.()) return null;
    const granted = await hasNotificationPermission();
    if (!granted) return null;

    const lockScreenContent = await getLockScreenContentEnabled();
    // When privacy mode is on, present generic copy. Note the real body
    // is NOT carried in `data` — only routing metadata (kind + ids) is,
    // so the tap-router can reopen the right thread, which then loads the
    // actual message from the local store once the user has unlocked.
    const presented =
      lockScreenContent || payload.data?.groupInvitation
        ? payload
        : { ...payload, ...genericFor(payload.kind) };
    const quiet = payload.data?.quiet === true;

    if (
      (await payload.shouldSuppress?.()) ||
      flight.cancelled ||
      (await shouldMuteNotification(owner, payload.data, payload.kind))
    )
      return null;
    const id = await Notifications.scheduleNotificationAsync({
      // A thread's alert reuses its row's id, so the next message replaces the
      // tray entry rather than stacking another beside it.
      ...(collapseKey ? { identifier: historyId } : {}),
      content: {
        title: presented.title,
        body: presented.body,
        // `data` rides through to the tap handler. Always include
        // `kind` so the deep-link router can dispatch by source.
        data: { kind: payload.kind, ...(payload.data ?? {}), historyId, owner },
        // Quiet is enforced natively too (not only by the foreground handler),
        // so it holds if the app is backgrounded before the 1 s trigger fires.
        sound: quiet ? false : 'default',
        ...(quiet ? { interruptionLevel: 'passive' as const } : {}),
      },
      // Android: a TIME_INTERVAL trigger is the supported way to pin a
      // notification to a specific channel (`channelId` lives on the trigger,
      // not the content). `trigger: null` fires immediately but drops the
      // notification onto the default channel, collapsing the Messages /
      // Payments split. The 1-second delay is imperceptible and the price of
      // keeping per-channel mute working. iOS has no channels → fire
      // immediately with `trigger: null`.
      trigger:
        Platform.OS === 'android'
          ? {
              type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: 1,
              channelId: quiet ? CHANNEL_PAYMENTS_QUIET : channelForKind(payload.kind),
            }
          : null,
    });
    if (flight.cancelled) {
      await Promise.all([
        Notifications.cancelScheduledNotificationAsync(id),
        Notifications.dismissNotificationAsync(id),
      ]);
      return null;
    }
    if (owner) await markNotificationDelivered(owner, historyId);
    return id;
  } catch (err) {
    if (__DEV__) console.warn('[notificationService] fireNotification failed:', err);
    return null;
  } finally {
    inFlightNotifications.delete(flight);
  }
}

// Foreground suppression (#279) lives in notificationFocus; re-exported so
// existing callers keep importing it from here.
export {
  isCacheActivelyViewed,
  isThreadActivelyViewed,
  setActiveCache,
  setActiveThread,
  setNotificationsForeground,
} from './notificationFocus';

/** What a focused screen has "read", for clearing its delivered
 * notifications (#1142): a 1:1 thread, a group, a cache's find-logs, or the
 * generic no-thread message pings (opened via the Messages list). */
export type NotificationTarget =
  | { conversationPubkey: string; conversationProtocol: DmProtocol }
  | { groupId: string }
  | { cacheCoord: string }
  | { genericMessages: true }
  /** Everything one account was notified about ("Mark all read", #1143).
   * Notifications without a recorded owner (older versions) are left alone. */
  | { owner: string }
  /** The one tray notification behind a history row (#1143). */
  | { historyId: string }
  /** The generic alerts Marmot push wakes posted — superseded once the app
   * shows the real Marmot message. */
  | { marmotPushAlerts: true }
  /** The contentless alert for one gift wrap (#1154), once it is decrypted. */
  | { wrapId: string }
  /** The tray notifications behind several history rows. */
  | { historyIds: readonly string[] };

/**
 * Pure: the thread a message alert belongs to, so a burst from one sender is
 * one tray entry and one history row (updated) rather than one per message.
 * Undefined for alerts with no known thread (generic pings) and non-messages.
 */
export function threadCollapseKey(
  kind: NotificationKind,
  data: NotificationData | undefined,
): string | undefined {
  if (kind === 'dm' && data?.conversationPubkey)
    return `dm:${data.protocol ?? data.conversationProtocol ?? 'nip17'}:${data.conversationPubkey.toLowerCase()}`;
  if (kind === 'group' && data?.groupId) return `group:${data.groupId}`;
  return undefined;
}

/** Pure: does a delivered notification's `data` belong to `target`? */
export function notificationMatchesTarget(
  data: (NotificationData & { kind?: string }) | null | undefined,
  target: NotificationTarget,
): boolean {
  if (!data) return false;
  if ('conversationPubkey' in target)
    return (
      data.conversationPubkey?.toLowerCase() === target.conversationPubkey.toLowerCase() &&
      // The tap-router treats a missing protocol as NIP-17; match it the same way.
      (data.protocol ?? data.conversationProtocol ?? 'nip17') === target.conversationProtocol
    );
  if ('groupId' in target) return data.groupId === target.groupId;
  if ('cacheCoord' in target) return data.kind === 'cache' && data.cacheCoord === target.cacheCoord;
  if ('owner' in target) return data.owner?.toLowerCase() === target.owner.toLowerCase();
  if ('historyId' in target) return data.historyId === target.historyId;
  if ('marmotPushAlerts' in target) return data.marmotPush === true;
  if ('wrapId' in target) return data.wrapId === target.wrapId;
  if ('historyIds' in target) return !!data.historyId && target.historyIds.includes(data.historyId);
  return (data.kind === 'dm' || data.kind === 'group') && !data.conversationPubkey && !data.groupId;
}

/** Mark the history row behind a tapped tray notification read (#1143). */
/** The active account, waiting (up to `timeoutMs`) for one to be restored —
 * not merely for the first publication, which is `null` on a cold start. */
function waitForActivePubkey(timeoutMs: number): Promise<string | null> {
  const current = getActivePubkey();
  if (current) return Promise.resolve(current);
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(getActivePubkey());
    }, timeoutMs);
    unsubscribe = subscribeActivePubkey((pk) => {
      if (!pk) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(pk);
    });
  });
}

export async function markHistoryEntryRead(
  historyId: string | undefined,
  notificationOwner?: string,
): Promise<void> {
  if (!historyId) return;
  // The notification's own account (it may not be the active one); older
  // payloads have none, so fall back to the restored active account — a
  // cold-start tap can arrive before auto-login has restored it.
  const owner = notificationOwner ?? (await waitForActivePubkey(15_000));
  if (!owner) return;
  await markNotificationsReadWhere(owner, (e) => e.id === historyId).catch(() => {});
}

/** Mark the active account's history entries for `target` read, so the
 * in-app badge agrees with the tray once a screen has shown them (#1143). */
export function markHistoryReadFor(target: NotificationTarget): Promise<void> {
  const owner = getActivePubkey();
  if (!owner) return Promise.resolve();
  return markNotificationsReadWhere(owner, (e) =>
    notificationMatchesTarget({ kind: e.kind, ...e.data }, target),
  ).catch(() => {});
}

/**
 * Dismiss the delivered notifications a screen has now shown the user, so
 * the tray entry and launcher dot clear (#1142). Never touches the
 * foreground-service notification. Best-effort: returns how many it cleared.
 */
export async function dismissNotificationsFor(target: NotificationTarget): Promise<number> {
  return dismissRequestsWhere((request) => {
    // The watcher's "New message" is a generic ping like the Marmot one —
    // cleared with them (so a Marmot welcome announced by both collapses).
    // Its other categories aren't messages.
    const watcher = watcherCategoryOf(request);
    if (watcher) {
      return watcher === 'dm' && ('genericMessages' in target || 'marmotPushAlerts' in target);
    }
    const data = request.content.data as (NotificationData & { kind?: string }) | null;
    // A server-sent Marmot alert (iOS) carries no data: it is a generic
    // "New message" — cleared with the generic pings / push alerts.
    if (isRemotePushRequest(request) && !data?.kind) {
      return 'genericMessages' in target || 'marmotPushAlerts' in target;
    }
    return notificationMatchesTarget(data, target);
  });
}

/** One Marmot message whose notification a "delete for everyone" retracts. */
export interface MarmotMessageRef {
  owner: string;
  groupId: string;
  messageId: string;
  /** The author the deletion is valid for; null = an admin removal (any author). */
  sender: string | null;
}

/** Pure: a matcher for notifications showing any of `refs` (indexed by id). */
export function marmotMessageRefMatcher(
  refs: readonly MarmotMessageRef[],
): (data: NotificationData | null | undefined) => boolean {
  const byId = new Map<string, MarmotMessageRef[]>();
  for (const ref of refs) {
    const list = byId.get(ref.messageId) ?? [];
    list.push(ref);
    byId.set(ref.messageId, list);
  }
  return (data) => {
    const candidates = data?.messageId ? byId.get(data.messageId) : undefined;
    return !!candidates?.some(
      (ref) =>
        data!.owner === ref.owner &&
        data!.marmotGroupId === ref.groupId &&
        (ref.sender === null || data!.senderPubkey?.toLowerCase() === ref.sender.toLowerCase()),
    );
  };
}

/**
 * Retract notifications that show deleted Marmot messages. Notifications
 * still being created are always cancelled (in memory, cheap). `tray: true`
 * also clears delivered/pending ones from the OS tray — one tray query for
 * the whole set, so callers batch (live deletions, plus one sweep for the
 * deletions a history replay re-delivers).
 */
export async function retractMarmotMessageNotifications(
  refs: readonly MarmotMessageRef[],
  { tray }: { tray: boolean },
): Promise<number> {
  if (refs.length === 0) return 0;
  const matches = marmotMessageRefMatcher(refs);
  cancelInFlightNotifications(matches);
  if (!tray) return 0;
  // A collapsed entry showing the deleted text goes too (privacy first); its
  // history row still records the thread's earlier messages.
  return dismissRequestsWhere((request) =>
    matches(request.content.data as NotificationData | null),
  );
}

/** Cancel notifications still being created whose `data` `matches` — the
 * tray / history clean-up can't see those yet. Cheap (in memory). */
export function cancelInFlightNotifications(matches: (data: NotificationData) => boolean): void {
  for (const flight of inFlightNotifications) if (matches(flight.data)) flight.cancelled = true;
}

/** Dismiss delivered + cancel pending notifications `matching` selects. Never
 * touches the foreground-service notification. Best-effort count. */
async function dismissRequestsWhere(
  matching: (request: Notifications.NotificationRequest) => boolean,
): Promise<number> {
  try {
    const select = (request: Notifications.NotificationRequest) =>
      request.identifier !== FOREGROUND_SERVICE_NOTIFICATION_ID && matching(request);
    const [presented, scheduled] = await Promise.all([
      Notifications.getPresentedNotificationsAsync(),
      Notifications.getAllScheduledNotificationsAsync(),
    ]);
    const ids = presented
      .map((n) => n.request)
      .filter(select)
      .map((r) => r.identifier);
    // Android fires on a 1 s TIME_INTERVAL trigger, so one can still be
    // pending as the thread opens — cancel it rather than let it appear.
    const pending = scheduled.filter(select).map((r) => r.identifier);
    await Promise.all([
      ...ids.map((id) => Notifications.dismissNotificationAsync(id)),
      ...pending.map((id) => Notifications.cancelScheduledNotificationAsync(id)),
    ]);
    return ids.length + pending.length;
  } catch (err) {
    if (__DEV__) console.warn('[notificationService] notification dismissal failed:', err);
    return 0;
  }
}

// A remote push while the app is open: hide it only once the app shows it
// has the message itself (a recent Marmot alert or the open thread) —
// another signed-in account's push, or one that beats the session, still
// shows. expo drops a handler that takes over ~3 s, so wait at most 2 s.
const FOREGROUND_COVER_LOOKBACK_MS = 15_000;
const FOREGROUND_COVER_WAIT_MS = 2_000;
async function remotePushCoveredInForeground(): Promise<boolean> {
  const arrived = Date.now();
  const covered = () => lastMarmotNotifiedAt >= arrived - FOREGROUND_COVER_LOOKBACK_MS;
  if (covered()) return true;
  await new Promise((resolve) => setTimeout(resolve, FOREGROUND_COVER_WAIT_MS));
  return covered();
}

const isRemotePushRequest = (request: Notifications.NotificationRequest) =>
  (request.trigger as { type?: string } | null)?.type === 'push';

/** True for a notification that came from a push server, not from us. */
export function isRemotePush(notification: Notifications.Notification): boolean {
  return isRemotePushRequest(notification.request);
}

const isMarmotMessage = (data: NotificationData) =>
  (data.protocol === 'marmot' && !!(data.conversationPubkey || data.groupId)) ||
  data.conversationProtocol === 'marmot' ||
  !!data.groupId?.startsWith('marmot:');

// When the app last showed a Marmot message itself — lets a push wake tell
// whether the running app already covered it.
let lastMarmotNotifiedAt = 0;
export const lastMarmotNotificationAt = (): number => lastMarmotNotifiedAt;

/**
 * Fire a message (DM or group) notification, suppressed when the user is
 * actively viewing that exact thread. `threadId` is the partner pubkey
 * (1:1) or the group id, and is also what the tap-router reads back to
 * reopen the thread.
 */
export async function fireMessageNotification(opts: {
  kind: 'dm' | 'group';
  threadId: string;
  title: string;
  body: string;
  data: NotificationData;
  owner?: string;
  shouldSuppress?: () => Promise<boolean>;
  /** When the message was sent (ms) — which push placeholders it stands for. */
  sentAt?: number;
}): Promise<string | null> {
  const marmot = isMarmotMessage(opts.data);
  if (isThreadActivelyViewed(opts.threadId)) {
    // Shown on screen instead — still proof the app has this message.
    if (marmot) {
      lastMarmotNotifiedAt = Date.now();
      noteMarmotMessageShown(opts.data.messageId);
      void dropMarmotPushAlerts(opts.owner, opts.sentAt ?? Date.now());
    }
    return null;
  }
  const id = await fireNotification({
    kind: opts.kind,
    title: opts.title,
    body: opts.body,
    data: {
      ...opts.data,
      ...(opts.data.groupInvitation
        ? {}
        : canonicalMessageTarget({ ...opts.data, threadKind: opts.data.threadKind ?? opts.kind })),
    },
    owner: opts.owner,
    shouldSuppress: opts.shouldSuppress,
  });
  if (id && marmot) {
    lastMarmotNotifiedAt = Date.now();
    noteMarmotMessageShown(opts.data.messageId);
    // After the real alert is recorded — the placeholder is replaced, never
    // deleted in the hope something else is written.
    void dropMarmotPushAlerts(opts.owner, opts.sentAt ?? Date.now());
  }
  return id;
}

/** A push placeholder posted up to this long after a message was sent can be
 * the alert for it (push latency + the wake's grace + clock skew). */
export const PLACEHOLDER_MATCH_MS = 60_000;
const PLACEHOLDER_SKEW_MS = 5_000;

/**
 * The real Marmot message is shown now: drop the generic push alert(s) — ours
 * (Android) and a data-less server alert already delivered (iOS) — AND their
 * history rows, so the history keeps the real message, not a nameless
 * "New message" beside it.
 */
export async function dropMarmotPushAlerts(owner?: string, sentAt?: number): Promise<void> {
  const account = owner ?? getActivePubkey();
  // No time (the Messages list opened): every one — the list shows them now.
  // iOS: the server's data-less alerts, which have no rows, are cleared too.
  if (sentAt === undefined || Platform.OS === 'ios')
    await dismissNotificationsFor({ marmotPushAlerts: true });
  if (!account) return;
  // Only the rows this message can stand for (posted just after it was sent);
  // their tray entries with them.
  const removed = await removeNotificationsWhere(
    account,
    (e) =>
      e.data.marmotPush === true &&
      (sentAt === undefined ||
        (e.createdAt >= sentAt - PLACEHOLDER_SKEW_MS &&
          e.createdAt <= sentAt + PLACEHOLDER_MATCH_MS)),
  );
  if (sentAt !== undefined && removed.length)
    await dismissNotificationsFor({ historyIds: removed });
}

/**
 * Fire a find-log notification (#740) — someone published a kind-1111
 * comment against one of the user's geo-caches (Piglet or vanilla
 * NIP-GC). Suppressed when the user is actively viewing the cache's
 * detail screen. `cacheCoord` is the addressable `<kind>:<pubkey>:<d>`
 * triple of the cache and is what the tap-router reads back to open
 * HuntPiggyDetail.
 *
 * The detect-and-ping background path (`runBackgroundSync`) calls this
 * with the sentinel `cacheCoord: '__background__'` — that value never
 * matches a real route, so the suppression gate always lets the ping
 * through and the router falls back to the Geo-caches list.
 */
export async function fireCacheNotification(opts: {
  cacheCoord: string;
  title: string;
  body: string;
  owner?: string;
}): Promise<string | null> {
  if (isCacheActivelyViewed(opts.cacheCoord)) return null;
  return fireNotification({
    kind: 'cache',
    title: opts.title,
    body: opts.body,
    data: { cacheCoord: opts.cacheCoord },
    owner: opts.owner,
  });
}

/** Fire an incoming-payment / zap notification. Never suppressed. */
export async function firePaymentNotification(
  opts: {
    kind: 'payment' | 'zap';
    amountSats: number;
    walletId?: string;
    /** Zap comment / invoice memo, appended to the body when present. */
    comment?: string;
    owner?: string;
    /** Stable id of the payment (its hash, or a fallback for on-chain), so a
     * retried notification doesn't add a second history row. */
    sourceId?: string;
    /** Catch-up payment (settled well before we noticed it): drawer only. */
    quiet?: boolean;
  },
  locale?: string,
): Promise<string | null> {
  const noun = opts.kind === 'zap' ? 'Zap' : 'Payment';
  const sats = opts.amountSats.toLocaleString(locale ?? getAppFormatLocale());
  const trimmed = opts.comment?.trim();
  const body = trimmed ? `+${sats} sats · ${trimmed}` : `+${sats} sats received`;
  return fireNotification({
    kind: opts.kind,
    title: `${noun} received`,
    body,
    data:
      opts.walletId || opts.quiet
        ? {
            ...(opts.walletId ? { walletId: opts.walletId } : {}),
            ...(opts.quiet ? { quiet: true } : {}),
          }
        : undefined,
    owner: opts.owner,
    historyKey: opts.sourceId
      ? `payment:${opts.walletId ?? ''}:${opts.sourceId.toLowerCase()}`
      : undefined,
  });
}

/**
 * Post (or refresh) the persistent foreground-service status chip (#279
 * realtime upgrade). This is the ongoing "Lightning Piggy is watching for
 * messages" notification Android requires a foreground service to display.
 * Always uses a fixed identifier so repeated calls update the SAME entry
 * rather than stacking. The LOW-importance channel keeps it silent; it is
 * deliberately swipeable (see the `sticky` note below).
 *
 * Returns the notification id on success, or null if we couldn't post (no
 * permission yet, or expo-notifications threw). Android-only by intent — on
 * iOS there's no foreground service, so the background DM service never
 * calls this (see backgroundDmService.ts).
 */
export async function showForegroundServiceNotification(opts: {
  title: string;
  body: string;
}): Promise<string | null> {
  // Enforce the Android-only contract — on iOS there is no foreground
  // service, so a stray call must not schedule a phantom notification.
  if (Platform.OS !== 'android') return null;
  try {
    const granted = await hasNotificationPermission();
    if (!granted) return null;
    await Notifications.scheduleNotificationAsync({
      identifier: FOREGROUND_SERVICE_NOTIFICATION_ID,
      content: {
        title: opts.title,
        body: opts.body,
        // `kind: 'dm'` with no thread id routes a tap to the Messages list
        // (see navigateFromNotification) — the right landing place for a
        // "watching for messages" chip; unknown kinds would land on Home.
        data: { kind: 'dm' },
        // Deliberately NOT sticky: this JS-posted chip only exists on the
        // non-native fallback path, where the watch dies with the process —
        // an ongoing notification would then linger undismissably with no JS
        // left to clear it. Swipeable is honest; the native service's own
        // startForeground() chip covers the persistent case.
        sticky: false,
      },
      trigger:
        Platform.OS === 'android'
          ? {
              type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
              seconds: 1,
              channelId: CHANNEL_BACKGROUND_SERVICE,
            }
          : null,
    });
    return FOREGROUND_SERVICE_NOTIFICATION_ID;
  } catch (err) {
    if (__DEV__)
      console.warn('[notificationService] showForegroundServiceNotification failed:', err);
    return null;
  }
}

/** Dismiss the persistent foreground-service status chip. Idempotent. */
export async function dismissForegroundServiceNotification(): Promise<void> {
  try {
    await Notifications.dismissNotificationAsync(FOREGROUND_SERVICE_NOTIFICATION_ID);
    // Also cancel a pending (not-yet-fired) schedule, since the 1 s
    // TIME_INTERVAL trigger above means a just-posted chip may still be
    // queued rather than displayed when the user toggles off fast.
    await Notifications.cancelScheduledNotificationAsync(FOREGROUND_SERVICE_NOTIFICATION_ID);
  } catch {
    // best-effort
  }
}

/**
 * Test hook: clears cached prefs so repeated tests don't poison each
 * other. NOT exported via barrel; intentionally only reachable via
 * deep import to keep production callers from grabbing it.
 */
export function __resetForTests(): void {
  initialisingPromise = null;
  resetLockScreenContentPreference();
  __resetNotificationFocusForTests();
  lastMarmotNotifiedAt = 0;
  resetMarmotMessageTracking();
}
