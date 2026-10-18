import { useSellerActivityChecks } from '../hooks/useSellerActivityChecks';
import { useAccountState } from '../contexts/useAccountState';
import { useLocale } from '../contexts/LocaleContext';
import React, { useCallback, useMemo } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr, useNostrContacts, useNostrDmInbox } from '../contexts/NostrContext';
import { useGroups } from '../contexts/GroupsContext';
import { getConversationForEvent } from '../services/dmDb';
import { removeNotificationsWhere } from '../services/notificationHistory';
import { dismissNotificationsFor } from '../services/notificationService';
import { useNonFollowProfiles } from '../hooks/useNonFollowProfiles';
import { notificationDisplay, type DisplayIdentity } from '../utils/notificationDisplay';
import { protocolForWireKind, type DmProtocol } from '../utils/dmProtocol';
import BrandGradientBackground from '../components/BrandGradientBackground';
import { useMuteNotificationAction } from '../hooks/useMuteNotificationAction';
import { useMutedSenders } from '../hooks/useMutedSenders';
import { isMutedNotification, notificationSender } from '../services/mutedSenders';
import NotificationRow from '../components/NotificationRow';
import { useNotificationHistory } from '../hooks/useNotificationHistory';
import { navigateFromNotification } from '../navigation/AppNavigator';
import { formatConversationTimestamp } from '../utils/conversationSummaries';
import type { NotificationHistoryEntry } from '../services/notificationHistory';
import { createNotificationsScreenStyles } from '../styles/NotificationsScreen.styles';

/**
 * In-app history of the notifications the app fired (#1143): find one again
 * after it was swiped away, and open its source. Rows show who / what and
 * when, never message text.
 */
const EMPTY_WRAP_TARGETS = new Map<string, { pubkey: string; protocol: DmProtocol }>();

export default function NotificationsScreen() {
  useSellerActivityChecks('focus');
  const { formatLocale } = useLocale();
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createNotificationsScreenStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { contacts } = useNostrContacts();
  const { pubkey, fetchProfilesForPubkeys } = useNostr();
  const { dmInbox } = useNostrDmInbox();
  const { groups } = useGroups();
  const { entries, unreadCount, markRead, markAllRead } = useNotificationHistory();
  // Non-followed partners' kind-0s, shared with the Messages list (#664).
  const { nonFollowProfiles } = useNonFollowProfiles({
    pubkey,
    dmInbox,
    contacts,
    fetchProfilesForPubkeys,
  });

  // pubkey → name + avatar, the way the Messages list resolves them: a
  // contact's profile (or petname), else a non-followed sender's profile.
  // Built once per change (not per row).
  const people = useMemo(() => {
    const map = new Map<string, DisplayIdentity>();
    for (const [key, p] of nonFollowProfiles) {
      map.set(key.toLowerCase(), {
        name: p.displayName?.trim() || p.name?.trim(),
        picture: p.picture,
      });
    }
    for (const c of contacts) {
      const name = c.profile?.displayName?.trim() || c.profile?.name?.trim() || c.petname?.trim();
      map.set(c.pubkey.toLowerCase(), { name, picture: c.profile?.picture ?? null });
    }
    return map;
  }, [contacts, nonFollowProfiles]);
  const groupNames = useMemo(
    () => new Map<string, DisplayIdentity>(groups.map((g) => [g.id, { name: g.name }])),
    [groups],
  );
  const profileFor = useCallback((pk: string) => people.get(pk), [people]);
  const groupFor = useCallback((id: string) => groupNames.get(id), [groupNames]);

  // Rows from alerts the background couldn't decrypt carry only a NIP-17 wrap
  // id; once the app has stored that message, learn its conversation (#1154).
  const [wrapTargets, setWrapTargets] = useAccountState(pubkey, EMPTY_WRAP_TARGETS);
  useFocusEffect(
    useCallback(() => {
      if (!pubkey) return;
      let cancelled = false;
      const pending = entries.filter(
        (e) => e.data.wrapId && !e.data.conversationPubkey && !wrapTargets.has(e.data.wrapId),
      );
      if (pending.length === 0) return;
      const resolve = async () => {
        const found = new Map(wrapTargets);
        const ownCopies = new Set<string>();
        for (const e of pending) {
          const row = await getConversationForEvent(pubkey, e.data.wrapId!).catch(() => null);
          // The alert was for the copy of a message WE sent (NIP-17 wraps one
          // to the sender too): nothing new arrived, so drop the row.
          if (row?.fromMe) ownCopies.add(e.data.wrapId!);
          else if (row)
            found.set(e.data.wrapId!, {
              pubkey: row.conversation,
              protocol: protocolForWireKind(row.wireKind, row.protocol),
            });
        }
        if (cancelled) return;
        if (ownCopies.size > 0) {
          const removed = await removeNotificationsWhere(pubkey, (e) =>
            ownCopies.has(e.data.wrapId ?? ''),
          );
          if (removed.length) void dismissNotificationsFor({ historyIds: removed });
        }
        if (!cancelled && found.size > wrapTargets.size) setWrapTargets(found);
      };
      void resolve();
      // A message decrypted after the screen opened: re-check while rows remain
      // unresolved (a hit re-runs this with fewer pending). Only while this
      // screen is focused, and briefly — a wrap that never lands in the DM store
      // (a group message, a declined decryption) mustn't poll forever.
      let tries = 0;
      const retry = setInterval(() => {
        if (++tries > 10) clearInterval(retry);
        else void resolve();
      }, 3000);
      return () => {
        cancelled = true;
        clearInterval(retry);
      };
    }, [entries, pubkey, wrapTargets, setWrapTargets]),
  );

  const handlePress = useCallback(
    (entry: NotificationHistoryEntry) => {
      void markRead(entry);
      const resolved = entry.data.wrapId ? wrapTargets.get(entry.data.wrapId) : undefined;
      const partner = (entry.data.conversationPubkey ?? resolved?.pubkey)?.toLowerCase();
      navigateFromNotification({
        kind: entry.kind,
        ...entry.data,
        ...(resolved && {
          conversationPubkey: resolved.pubkey,
          conversationProtocol: resolved.protocol,
        }),
        name: (partner && people.get(partner)?.name) || undefined,
      });
    },
    [markRead, people, wrapTargets],
  );

  const openMuteMenu = useMuteNotificationAction();
  const { mutedSenders } = useMutedSenders();
  const visibleEntries = useMemo(
    () =>
      entries.filter((entry) => {
        const resolved = entry.data.wrapId ? wrapTargets.get(entry.data.wrapId) : undefined;
        return !isMutedNotification(
          { ...entry.data, conversationPubkey: entry.data.conversationPubkey ?? resolved?.pubkey },
          entry.kind,
          mutedSenders,
        );
      }),
    [entries, wrapTargets, mutedSenders],
  );
  const handleLongPress = useCallback(
    (entry: NotificationHistoryEntry) => {
      const resolved = entry.data.wrapId ? wrapTargets.get(entry.data.wrapId) : undefined;
      const sender = notificationSender(
        { ...entry.data, conversationPubkey: entry.data.conversationPubkey ?? resolved?.pubkey },
        entry.kind,
      );
      if (sender) openMuteMenu(sender, `notif-mute-${entry.id}`);
    },
    [wrapTargets, openMuteMenu],
  );

  const renderItem = useCallback(
    ({ item }: { item: NotificationHistoryEntry }) => {
      const resolved = item.data.wrapId ? wrapTargets.get(item.data.wrapId) : undefined;
      const { title, picture } = notificationDisplay(item, {
        partner: item.data.conversationPubkey ?? resolved?.pubkey,
        profileFor,
        groupFor,
      });
      const kindLabel = t(`notifications.kind.${item.kind}`);
      // A row standing for several messages in one thread says how many.
      const label =
        (item.count ?? 1) > 1
          ? `${kindLabel} · ${t('notifications.newCount', { count: item.count })}`
          : kindLabel;
      return (
        <NotificationRow
          entry={item}
          title={title}
          picture={picture}
          subtitle={item.body ? `${label} · ${item.body}` : label}
          time={formatConversationTimestamp(
            Math.floor(item.createdAt / 1000),
            undefined,
            formatLocale,
          )}
          iconColor={colors.brandPink}
          styles={styles}
          onPress={handlePress}
          onLongPress={handleLongPress}
        />
      );
    },
    [
      profileFor,
      groupFor,
      wrapTargets,
      t,
      colors.brandPink,
      styles,
      handlePress,
      handleLongPress,
      formatLocale,
    ],
  );

  return (
    <View style={styles.container}>
      <BrandGradientBackground />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel={t('notifications.back')}
          testID="notifications-back"
        >
          <ChevronLeft size={22} color={colors.brandPink} />
        </TouchableOpacity>
        <Text style={styles.title} numberOfLines={1}>
          {t('notifications.title')}
        </Text>
        {unreadCount > 0 && (
          <TouchableOpacity
            style={styles.markAll}
            onPress={() => void markAllRead()}
            accessibilityRole="button"
            accessibilityLabel={t('notifications.markAllRead')}
            testID="notifications-mark-all-read"
          >
            <Text style={styles.markAllText}>{t('notifications.markAllRead')}</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.content}>
        <FlatList
          data={visibleEntries}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + 16 }]}
          ListEmptyComponent={
            <View style={styles.empty} testID="notifications-empty">
              <Text style={styles.emptyTitle}>{t('notifications.emptyTitle')}</Text>
              <Text style={styles.emptyText}>{t('notifications.emptyText')}</Text>
            </View>
          }
          testID="notifications-list"
        />
      </View>
    </View>
  );
}
