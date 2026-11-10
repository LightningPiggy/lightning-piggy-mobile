import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, FlatList, Image } from 'react-native';
import { idleScheduler } from '../utils/idleScheduler';
import { Alert } from '../components/BrandedAlert';
import Svg, { Path } from 'react-native-svg';
import { Users } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createGroupsScreenStyles } from '../styles/GroupsScreen.styles';
import { useGroups } from '../contexts/GroupsContext';
import { useNostr, useNostrContacts, useNostrDmInbox } from '../contexts/NostrContext';
import CreateGroupSheet from '../components/CreateGroupSheet';
import GroupAvatar, { type ContactInfo } from '../components/GroupAvatar';
import type { RootStackParamList } from '../navigation/types';
import type { Group } from '../types/groups';

type GroupsNavigation = NativeStackNavigationProp<RootStackParamList, 'Groups'>;

const GroupsScreen: React.FC = () => {
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<GroupsNavigation>();
  const colors = useThemeColors();
  const styles = useMemo(() => createGroupsScreenStyles(colors), [colors]);
  // TODO(wot): swap to wotTier + WebOfTrustChip + WebOfTrustBottomSheet when
  // the GroupsScreen filter row gets its own three-tier picker (#547 only
  // migrated the Messages chip; GroupsScreen still uses the legacy boolean
  // shim — `followingOnly` is now derived from `effectiveWotTier !== 'all'`
  // and `setFollowingOnly` writes back via `setWotTier`).
  const { visibleGroups, deleteGroup, followingOnly, setFollowingOnly, secretMode } = useGroups();
  const { isLoggedIn, pubkey: myPubkey } = useNostr();
  const { refreshDmInbox } = useNostrDmInbox();
  const { contacts } = useNostrContacts();

  // Built once per render and shared by every row's GroupAvatar so we
  // do O(contacts) per render instead of O(rows × avatars × contacts).
  // Same idiom MessagesScreen uses (#245).
  const contactInfoMap = useMemo(() => {
    const map = new Map<string, ContactInfo>();
    for (const c of contacts) {
      map.set(c.pubkey.toLowerCase(), {
        picture: c.profile?.picture ?? null,
        name: (c.profile?.displayName || c.profile?.name || c.petname || '').trim() || null,
        lightningAddress: c.profile?.lud16 ?? null,
      });
    }
    return map;
  }, [contacts]);

  // Per-group avatar inputs precomputed once per (visibleGroups, myPubkey)
  // change. Both the displayed member count and the GroupAvatar pubkeys
  // are derived from the same `pubkeys` array — so they can never drift
  // (Copilot blocking on PR 365: when myPubkey is null during session
  // restore, count and cluster size must still agree). Memoizing also
  // keeps the array reference stable, so React.memo(GroupAvatar) can
  // skip re-renders during unrelated state churn.
  const groupAvatarInputs = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const g of visibleGroups) {
      map.set(g.id, myPubkey ? [myPubkey, ...g.memberPubkeys] : g.memberPubkeys);
    }
    return map;
  }, [visibleGroups, myPubkey]);

  const enforceFollowingOnly = followingOnly || !secretMode;
  const [createVisible, setCreateVisible] = useState(false);

  // On focus, refresh the DM inbox so any new kind-1059 wraps get pulled
  // and the NIP-17 decrypt loop can route group rumors into the local
  // group store. Mirrors MessagesScreen's pattern (deferred via
  // idleScheduler so the tab transition stays smooth).
  //
  // AbortSignal so an in-flight NIP-17 unwrap loop releases the JS
  // thread when the user navigates AWAY from Groups — pre-fix the
  // decrypt loop kept grinding through hundreds of cached wraps after
  // blur, contributing to the 8-second refreshDmInbox latency Ben
  // logged in #560. Same shape MessagesScreen uses for the Messages
  // tab (#412).
  const refreshAbortRef = useRef<AbortController | null>(null);
  // Screen-level TTL gate (mirrors MessagesScreen #412/#731). Without it the
  // `force: true` below — kept so newly-arrived group rumors, whose NIP-59 wrap
  // timestamps are randomised, aren't dropped by a `since` filter — also
  // bypasses refreshDmInbox's own TTL gate, re-ingesting the ENTIRE wrap
  // backlog on every Groups focus (~10 s JS-thread lock per visit; #751
  // warm-path audit). The gate preserves `force` semantics when we do fetch
  // but skips the fetch on a re-focus within the TTL window. 0 = never.
  const dmInboxLastRefreshAt = useRef<number>(0);
  const DM_INBOX_REFRESH_TTL_MS = 30_000;
  const DM_INBOX_ABORT_TTL_MS = 10_000;
  const newRefreshSignal = useCallback((): AbortSignal => {
    refreshAbortRef.current?.abort();
    const ctrl = new AbortController();
    refreshAbortRef.current = ctrl;
    return ctrl.signal;
  }, []);
  useFocusEffect(
    useCallback(() => {
      if (!isLoggedIn) return;
      const handle = idleScheduler.runWhenIdle(() => {
        // Skip entirely if the inbox was refreshed within the TTL window —
        // tab-bouncing into Groups no longer re-runs the full relay fetch.
        if (Date.now() - dmInboxLastRefreshAt.current < DM_INBOX_REFRESH_TTL_MS) return;
        const startedAt = Date.now();
        const signal = newRefreshSignal();
        refreshDmInbox({
          includeNonFollows: !enforceFollowingOnly,
          signal,
        })
          .then(() => {
            // Aborted (fast tab-hop) → short TTL so we retry sooner; clean
            // completion → full 30 s TTL. Same shape as MessagesScreen.
            dmInboxLastRefreshAt.current = signal.aborted
              ? Date.now() - (DM_INBOX_REFRESH_TTL_MS - DM_INBOX_ABORT_TTL_MS)
              : startedAt;
          })
          .catch(() => {
            dmInboxLastRefreshAt.current =
              Date.now() - (DM_INBOX_REFRESH_TTL_MS - DM_INBOX_ABORT_TTL_MS);
          });
      });
      return () => {
        handle.cancel();
        refreshAbortRef.current?.abort();
        refreshAbortRef.current = null;
      };
    }, [isLoggedIn, refreshDmInbox, enforceFollowingOnly, newRefreshSignal]),
  );

  const openGroup = useCallback(
    (group: Group) => {
      navigation.navigate('GroupConversation', { groupId: group.id });
    },
    [navigation],
  );

  const handleLongPress = useCallback(
    (group: Group) => {
      Alert.alert(group.name, undefined, [
        { text: t('groupsScreen.cancel'), style: 'cancel' },
        {
          text: t('groupsScreen.delete'),
          style: 'destructive',
          onPress: () => deleteGroup(group.id),
        },
      ]);
    },
    [deleteGroup, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: Group }) => {
      const pubkeys = groupAvatarInputs.get(item.id) ?? item.memberPubkeys;
      return (
        <TouchableOpacity
          style={styles.row}
          onPress={() => openGroup(item)}
          onLongPress={() => handleLongPress(item)}
          activeOpacity={0.6}
          accessibilityLabel={t('groupsScreen.openGroup', { name: item.name })}
          testID={`group-row-${item.id}`}
        >
          <GroupAvatar
            pubkeys={pubkeys}
            groupName={item.name}
            size={44}
            contactInfoMap={contactInfoMap}
          />
          <View style={styles.info}>
            <Text style={styles.name} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {pubkeys.length === 1
                ? t('groupsScreen.memberCountOne', { count: pubkeys.length })
                : t('groupsScreen.memberCountOther', { count: pubkeys.length })}
            </Text>
          </View>
        </TouchableOpacity>
      );
    },
    [openGroup, handleLongPress, styles, contactInfoMap, groupAvatarInputs, t],
  );

  return (
    <View style={styles.container}>
      <Image
        source={require('../../assets/images/friends-bg.png')}
        style={styles.bgImage}
        resizeMode="contain"
      />
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.titleRow}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={() => navigation.goBack()}
            accessibilityLabel={t('groupsScreen.back')}
            testID="groups-back"
          >
            <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
              <Path
                d="m15 18-6-6 6-6"
                stroke={colors.brandPink}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </Svg>
          </TouchableOpacity>
          <Text style={styles.title}>{t('groupsScreen.title')}</Text>
          <View style={{ flex: 1 }} />
          <TouchableOpacity
            style={styles.addButton}
            onPress={() => setCreateVisible(true)}
            accessibilityLabel={t('groupsScreen.createGroup')}
            testID="create-group-button"
          >
            <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
              <Path
                d="M12 5v14M5 12h14"
                stroke={colors.white}
                strokeWidth={2.5}
                strokeLinecap="round"
              />
            </Svg>
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.content}>
        <View style={styles.filterChipRow}>
          {secretMode ? (
            <TouchableOpacity
              style={followingOnly ? styles.filterChip : styles.filterChipOff}
              onPress={() => setFollowingOnly(!followingOnly)}
              accessibilityLabel={
                followingOnly
                  ? t('groupsScreen.followingFilterOnA11y')
                  : t('groupsScreen.followingFilterOffA11y')
              }
              accessibilityRole="button"
              testID="groups-follows-toggle"
            >
              <Users
                size={14}
                color={followingOnly ? colors.brandPink : colors.textSupplementary}
              />
              <Text style={followingOnly ? styles.filterChipText : styles.filterChipTextOff}>
                {followingOnly ? t('groupsScreen.followingOnly') : t('groupsScreen.allGroupsDev')}
              </Text>
            </TouchableOpacity>
          ) : (
            <View
              style={styles.filterChip}
              accessibilityLabel={t('groupsScreen.followingIndicatorA11y')}
              testID="groups-follows-indicator"
            >
              <Users size={14} color={colors.brandPink} />
              <Text style={styles.filterChipText}>{t('groupsScreen.followingOnly')}</Text>
            </View>
          )}
        </View>
        {visibleGroups.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{t('groupsScreen.noGroupsYet')}</Text>
            <Text style={styles.emptySubtitle}>{t('groupsScreen.noGroupsSubtitle')}</Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => setCreateVisible(true)}
              accessibilityLabel={t('groupsScreen.createFirstGroupA11y')}
              testID="create-first-group"
            >
              <Text style={styles.emptyButtonText}>{t('groupsScreen.createGroupButton')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={visibleGroups}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
          />
        )}
      </View>

      <CreateGroupSheet
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        onCreated={(group) => navigation.navigate('GroupConversation', { groupId: group.id })}
      />
    </View>
  );
};

export default GroupsScreen;
