import { getConversationForEvent, subscribeDmStorage } from '../services/dmDb';
import { protocolForWireKind } from '../utils/dmProtocol';
import { useCallback, useEffect, useMemo } from 'react';
import { useAccountState } from '../contexts/useAccountState';
import { AppState } from 'react-native';
import { useNostr } from '../contexts/NostrContext';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  subscribeNotificationHistory,
  type NotificationHistoryEntry,
} from '../services/notificationHistory';
import { dismissNotificationsFor } from '../services/notificationService';

import { useMutedSenders } from './useMutedSenders';
import { isMutedNotification } from '../services/mutedSenders';

const EMPTY_ENTRIES: NotificationHistoryEntry[] = [];

/** The active account's notification history (#1143), kept live. */
export function useNotificationHistory() {
  const { pubkey } = useNostr();
  const { mutedSenders, ready } = useMutedSenders();
  const [allEntries, setEntries] = useAccountState(pubkey, EMPTY_ENTRIES);

  useEffect(() => {
    setEntries([]);
    if (!pubkey) return;
    let cancelled = false;
    // Notifications are rare, so re-reading the (capped) list per change is
    // cheap; the cancel flag drops a read that lands after an account switch.
    let loadVersion = 0;
    const load = () => {
      const version = ++loadVersion;
      void listNotifications(pubkey)
        .then(async (list) => {
          const resolved = await Promise.all(
            list.map(async (entry) => {
              if (!entry.data.wrapId || entry.data.conversationPubkey) return entry;
              const row = await getConversationForEvent(pubkey, entry.data.wrapId).catch(
                () => null,
              );
              return row && !row.fromMe
                ? {
                    ...entry,
                    data: {
                      ...entry.data,
                      conversationPubkey: row.conversation,
                      conversationProtocol: protocolForWireKind(row.wireKind, row.protocol),
                    },
                  }
                : entry;
            }),
          );
          if (!cancelled && version === loadVersion) setEntries(resolved);
        })
        .catch(() => {});
    };
    load();
    // Live inbox signals precede persistence. Resolve only after a committed
    // write, coalescing bursts so decrypt backfills don't set state per event.
    let storageTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleLoad = () => {
      if (storageTimer !== null) return;
      storageTimer = setTimeout(() => {
        storageTimer = null;
        load();
      }, 100);
    };
    const unsubscribe = subscribeNotificationHistory(scheduleLoad);
    const unsubscribeStorage = subscribeDmStorage((owner) => {
      if (owner === pubkey) scheduleLoad();
    });
    // A background worker may record in a separate JS context, whose listeners
    // can't reach this one: re-read on resume, staggered like other non-urgent
    // resume work (#554).
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (resumeTimer) clearTimeout(resumeTimer);
      resumeTimer = state === 'active' ? setTimeout(load, 3000) : null;
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeStorage();
      if (storageTimer) clearTimeout(storageTimer);
      appStateSub.remove();
      if (resumeTimer) clearTimeout(resumeTimer);
    };
  }, [pubkey, setEntries]);

  const entries = useMemo(
    () =>
      ready
        ? allEntries.filter((entry) => !isMutedNotification(entry.data, entry.kind, mutedSenders))
        : [],
    [allEntries, mutedSenders, ready],
  );
  const unreadCount = useMemo(() => entries.filter((e) => !e.read).length, [entries]);

  // Also clears exactly that row's tray notification (a payment row opens
  // Home, which has no screen-specific clearing of its own).
  const markRead = useCallback(
    async (entry: NotificationHistoryEntry) => {
      if (!pubkey) return;
      await markNotificationRead(pubkey, entry.id);
      await dismissNotificationsFor({ historyId: entry.id });
    },
    [pubkey],
  );

  // Also clears the OS tray, so the launcher dot goes with the in-app badge.
  const markAllRead = useCallback(async () => {
    if (!pubkey) return;
    await markAllNotificationsRead(pubkey);
    // Only this account's tray entries — another signed-in account's stay.
    await dismissNotificationsFor({ owner: pubkey });
  }, [pubkey]);

  return { entries, unreadCount, markRead, markAllRead };
}
