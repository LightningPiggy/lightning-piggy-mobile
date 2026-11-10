/**
 * The ongoing "Sharing your location with … · Stop sharing" notification for
 * an active live-location share (#1300), Android only.
 *
 * expo-location's foreground-service notification (which keeps the share
 * running in the background) can't carry action buttons — tapping it only
 * opens the app — so this companion notification carries the Stop action.
 * The action doesn't open the app (`opensAppToForeground: false`); the
 * provider's response listener stops every share. Tapping the body opens the
 * chat. iOS has no ongoing notifications: there the system's blue location
 * pill is the indicator, and tapping it opens the app.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { AndroidImportance } from 'expo-notifications';
import { t } from '../i18n';

export const LIVE_LOCATION_STOP_ACTION = 'stop-live-location';
/** Notification task (defined in liveLocationTask.ts) that receives the Stop
 *  press even when the app process has to be started for it. */
export const LIVE_LOCATION_STOP_TASK = 'lp-live-location-stop';
const CATEGORY = 'live-location';
const CHANNEL = 'live-location';
const NOTIFICATION_ID = 'live-location-share';
const STOPPED_NOTIFICATION_ID = 'live-location-stopped';

let prepared: Promise<void> | null = null;

function prepare(): Promise<void> {
  prepared ??= (async () => {
    await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: t('liveLocationTracking.channelName'),
      importance: AndroidImportance.LOW,
      sound: null,
      vibrationPattern: null,
      showBadge: false,
    });
    await Notifications.setNotificationCategoryAsync(CATEGORY, [
      {
        identifier: LIVE_LOCATION_STOP_ACTION,
        buttonTitle: t('liveLocationTracking.stopAction'),
        options: { opensAppToForeground: false },
      },
    ]);
  })().catch((e) => {
    prepared = null;
    throw e;
  });
  return prepared;
}

/** Notification copy for the active shares (pure — unit-tested). */
export function liveShareNotificationText(
  shares: { label?: string; groupId?: string; expiresAt: number }[],
  formatTime: (ms: number) => string,
): { title: string; body: string } {
  const until = Math.max(...shares.map((s) => s.expiresAt));
  const body = t('liveLocationTracking.body', { time: formatTime(until) });
  if (shares.length === 1) {
    const [s] = shares;
    const name =
      s.label || t(s.groupId ? 'liveLocationTracking.aGroup' : 'liveLocationTracking.aFriend');
    return { title: t('liveLocationTracking.titleOne', { name }), body };
  }
  return { title: t('liveLocationTracking.titleMany', { count: shares.length }), body };
}

/**
 * Show (or refresh) the ongoing notification. `route` makes a tap on its body
 * open the chat, through the app's normal notification router.
 */
export async function showLiveShareNotification(input: {
  title: string;
  body: string;
  route?: { kind: 'dm'; conversationPubkey: string } | { kind: 'group'; groupId: string };
}): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await prepare();
    await Notifications.registerTaskAsync(LIVE_LOCATION_STOP_TASK).catch(() => undefined);
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: input.title,
        body: input.body,
        sticky: true,
        autoDismiss: false,
        categoryIdentifier: CATEGORY,
        priority: Notifications.AndroidNotificationPriority.LOW,
        // `quiet`: no heads-up banner or sound (see notificationService).
        data: { ...(input.route ?? {}), quiet: true, liveLocation: true },
      },
      trigger: { channelId: CHANNEL },
    });
  } catch {
    // Best-effort: the share works without it (Stop stays in the chat).
  }
}

/**
 * Tell the user a share stopped because the app was closed in the background
 * (a Marmot share can't continue without the app — see the tracker). A normal
 * notification on the same quiet channel; tapping it opens the app, which
 * sends the end markers.
 */
export async function showLiveShareStoppedNotification(labels: (string | undefined)[]) {
  try {
    if (Platform.OS === 'android') await prepare();
    const names = labels.filter((l): l is string => !!l);
    await Notifications.scheduleNotificationAsync({
      identifier: STOPPED_NOTIFICATION_ID,
      content: {
        title: t('liveLocationTracking.stoppedTitle'),
        body:
          names.length === 1
            ? t('liveLocationTracking.stoppedBodyOne', { name: names[0] })
            : t('liveLocationTracking.stoppedBody'),
        data: { quiet: true, liveLocationStopped: true },
      },
      trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null,
    });
  } catch {
    // Best-effort.
  }
}

export async function dismissLiveShareNotification(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => undefined);
  await Notifications.unregisterTaskAsync(LIVE_LOCATION_STOP_TASK).catch(() => undefined);
}

/** True for a press of the notification's Stop sharing action. */
export const isLiveShareStopResponse = (response: unknown): boolean =>
  !!response &&
  typeof response === 'object' &&
  (response as { actionIdentifier?: unknown }).actionIdentifier === LIVE_LOCATION_STOP_ACTION;
