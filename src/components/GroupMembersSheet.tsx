import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, TouchableOpacity, View, BackHandler } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { UserPlus } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createGroupMembersSheetStyles } from '../styles/GroupMembersSheet.styles';
import { marmotSendError } from '../services/marmotSend';
import { useGroups } from '../contexts/GroupsContext';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { Alert as BrandedAlert } from './BrandedAlert';
import Toast from './BrandedToast';
import FriendPickerSheet, { type PickedFriend } from './FriendPickerSheet';
import GroupMemberListRow from './GroupMemberListRow';
import type { GroupMemberRow } from '../utils/groupMemberRows';
import { useGroupAdminActions } from '../hooks/useGroupAdminActions';
import { canManageGroup } from '../utils/groupAdmins';
import { useMarmotDeviceDetails, useMarmotPendingInvites } from '../hooks/useMarmotDevices';
import { isRemoteSigner } from '../utils/marmotInviteNotice';
import type { DeviceInfo } from '../services/marmotDeviceTracker';

const NO_DEVICES: DeviceInfo[] = [];

interface Props {
  visible: boolean;
  /** The app group; null for a Marmot 1:1 (which isn't an app group). */
  groupId: string | null;
  onClose: () => void;
  // Resolved rows (self first) from the host screen's single
  // `useGroupMemberProfiles` + `buildGroupMemberRows` pass, so the sheet,
  // header count and sender labels share one lookup (#1268).
  members: GroupMemberRow[];
  // Optional. When provided, tapping a member row (other than self)
  // calls this with their pubkey. The host screen typically opens
  // ContactProfileSheet in response. Without this, rows are display-only.
  onMemberTap?: (pubkey: string) => void;
  /** A 1:1: no Add / Remove / admin controls, no admin badges, and a neutral
   * "In this chat" title — a 1:1 must never look like a group (#1267). */
  readOnly?: boolean;
  /** Marmot: the chat's MLS group id, for the per-person device lists. */
  chatId?: string | null;
  /** Marmot: person (lower-case pubkey) → device count; rows show a toggle. */
  deviceCounts?: ReadonlyMap<string, number> | null;
  /** Open every person's device list when the sheet opens (the 1:1 by-line). */
  expandDevices?: boolean;
}

/**
 * Manage-members bottom sheet for a group conversation. Tapping the
 * "N members" header line in `GroupConversationScreen` opens this; in a
 * Marmot 1:1 the header by-line opens it read-only (`readOnly`).
 *
 * Composition:
 * - Header with the count and a Done button.
 * - Scrollable list of current members (avatar + name + follow status +
 *   Remove button per row). Remove confirms via BrandedAlert before
 *   persisting; Follow publishes through the shared `followContact` path
 *   (so Amber / NIP-46 prompts behave as everywhere else).
 * - Marmot groups: an Admin badge on admins' rows, and for admins a "⋯"
 *   menu to make / remove admins (`useGroupAdminActions`).
 * - Marmot chats: a "N devices" toggle under each person opens their device
 *   list (#1267). Counts come from the host's cheap tree walk; the details
 *   (apps, key dates, epochs) are read only while a list is open.
 * - "Add members" footer button → opens `FriendPickerSheet` filtered to
 *   non-members. Selecting one calls `addMembersToGroup` and closes the
 *   picker; the row appears here without remounting the parent screen.
 *
 * Dynamic membership writes flow through `GroupsContext` so the kind-30200
 * group-state event is republished on each change (see `addMembersToGroup`
 * / `removeMemberFromGroup` in the context).
 *
 * Sheet uses `enableDynamicSizing={false}` + an explicit snap point per
 * the v5 dynamic-sizing collapse fix in `docs/TROUBLESHOOTING.adoc`.
 */
const GroupMembersSheet: React.FC<Props> = ({
  visible,
  groupId,
  onClose,
  members,
  onMemberTap,
  readOnly = false,
  chatId = null,
  deviceCounts = null,
  expandDevices = false,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createGroupMembersSheetStyles(colors), [colors]);
  const { getGroup, addMembersToGroup, removeMemberFromGroup } = useGroups();
  const { pubkey: selfPubkey, signerType } = useNostr();
  const { followContact } = useNostrContacts();
  const sheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['85%'], []);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Follows are single-flight: `followContact` republishes the whole kind-3
  // from the `contacts` it closed over, so two concurrent follows would race
  // and drop one. It resolves after `contacts` updates, flipping the row to
  // "Following" in place.
  const [followPendingPubkey, setFollowPendingPubkey] = useState<string | null>(null);
  const followInFlight = useRef(false);

  const group = groupId ? getGroup(groupId) : undefined;
  // NIP-17 groups are editable by anyone; a Marmot group only by its admins
  // (MLS rejects a non-admin's membership commit).
  const isMarmot = group?.protocol === 'marmot';
  const adminSet = useMemo(
    () => new Set((group?.adminPubkeys ?? []).map((p) => p.toLowerCase())),
    [group?.adminPubkeys],
  );
  // Same rule as the header's rename pencil: anyone in NIP-17, admins in Marmot.
  const canManage = !readOnly && canManageGroup(group, selfPubkey);
  // Only Marmot groups have admins; 1:1 DMs never reach this sheet, so any
  // Marmot group here is multi-member. Non-admins see badges, no actions.
  const { adminPendingPubkey, openAdminActions } = useGroupAdminActions(group);
  const onAdminActions = isMarmot && canManage ? openAdminActions : undefined;
  // Whose device lists are open. The 1:1 by-line opens them all.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (visible && expandDevices) setExpanded(new Set(members.map((m) => m.pubkey)));
    // Only on open: a later member change shouldn't re-expand what was closed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, expandDevices]);
  const toggleDevices = useCallback((m: GroupMemberRow) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(m.pubkey)) next.add(m.pubkey);
      return next;
    });
  }, []);
  const deviceDetails = useMarmotDeviceDetails(chatId, visible && expanded.size > 0);
  // Members whose invitation hasn't reached them yet (#1402).
  const pendingInvites = useMarmotPendingInvites(chatId, visible);
  const reportFailure = useCallback(
    (e: unknown) => {
      if (__DEV__) console.warn('[Group] membership change failed:', e);
      // NIP-17 changes are local-first and effectively can't fail; a Marmot
      // change is an MLS commit (e.g. the friend has no key package yet).
      if (group?.protocol === 'marmot') {
        BrandedAlert.alert(t('createGroupSheet.createFailedTitle'), marmotSendError(e));
      }
    },
    [group?.protocol, t],
  );

  useEffect(() => {
    if (visible) {
      sheetRef.current?.present();
    } else {
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleRemove = useCallback(
    (m: GroupMemberRow) => {
      if (!groupId) return;
      BrandedAlert.alert(
        t('groupMembersSheet.removeTitle'),
        t('groupMembersSheet.removeMessage', { name: m.name }),
        [
          { text: t('groupMembersSheet.cancel'), style: 'cancel' },
          {
            text: t('groupMembersSheet.remove'),
            style: 'destructive',
            onPress: () => {
              removeMemberFromGroup(groupId, m.pubkey).catch(reportFailure);
            },
          },
        ],
      );
    },
    [groupId, removeMemberFromGroup, t, reportFailure],
  );

  const handleFollow = useCallback(
    async (m: GroupMemberRow) => {
      if (followInFlight.current) return;
      followInFlight.current = true;
      setFollowPendingPubkey(m.pubkey);
      // `false` = the follow path already gave its own feedback (e.g. the
      // "Couldn't load your follow list" toast, #1271) or the signer was
      // declined: don't replace it. Only an unexpected throw gets ours.
      let outcome: 'followed' | 'declined' | 'error' = 'error';
      try {
        outcome = (await followContact(m.pubkey)) ? 'followed' : 'declined';
      } catch (e) {
        if (__DEV__) console.warn('[Group] follow failed:', e);
      } finally {
        followInFlight.current = false;
        setFollowPendingPubkey(null);
      }
      if (outcome === 'followed') {
        Toast.show({
          type: 'success',
          text1: t('groupMembersSheet.followedToast', { name: m.name }),
        });
      } else if (outcome === 'error') {
        Toast.show({ type: 'error', text1: t('groupMembersSheet.followFailed', { name: m.name }) });
      }
    },
    [followContact, t],
  );

  const handleMemberPress = useCallback(
    (m: GroupMemberRow) => onMemberTap?.(m.pubkey),
    [onMemberTap],
  );

  const handlePickerSelect = useCallback(
    (friend: PickedFriend) => {
      if (!groupId) return;
      addMembersToGroup(groupId, [friend.pubkey]).catch(reportFailure);
      setPickerOpen(false);
    },
    [groupId, addMembersToGroup, reportFailure],
  );

  if (!group && !readOnly) return null;

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={snapPoints}
        onDismiss={onClose}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
        enableDynamicSizing={false}
      >
        <BottomSheetScrollView
          style={styles.content}
          contentContainerStyle={styles.contentContainer}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.headerRow}>
            <Text style={styles.title}>
              {readOnly
                ? t('chatDevices.inThisChat')
                : t(
                    members.length === 1
                      ? 'groupMembersSheet.memberCountOne'
                      : 'groupMembersSheet.memberCountOther',
                    { count: members.length },
                  )}
            </Text>
            <TouchableOpacity
              onPress={onClose}
              accessibilityLabel={t('groupMembersSheet.done')}
              testID="group-members-done"
            >
              <Text style={styles.doneText}>{t('groupMembersSheet.done')}</Text>
            </TouchableOpacity>
          </View>

          {members.map((m) => (
            <GroupMemberListRow
              key={m.pubkey}
              member={m}
              styles={styles}
              colors={colors}
              canRemove={canManage}
              isAdmin={!readOnly && isMarmot && adminSet.has(m.pubkey.toLowerCase())}
              deviceCount={deviceCounts?.get(m.pubkey.toLowerCase())}
              inviteStatus={pendingInvites?.get(m.pubkey.toLowerCase())}
              remoteSigner={isRemoteSigner(signerType)}
              devicesExpanded={expanded.has(m.pubkey)}
              devices={
                expanded.has(m.pubkey) && deviceDetails
                  ? (deviceDetails.people.get(m.pubkey.toLowerCase()) ?? NO_DEVICES)
                  : null
              }
              onToggleDevices={deviceCounts ? toggleDevices : undefined}
              adminActionsDisabled={adminPendingPubkey !== null}
              onAdminActions={onAdminActions}
              followPending={followPendingPubkey === m.pubkey}
              followDisabled={followPendingPubkey !== null && followPendingPubkey !== m.pubkey}
              onPress={onMemberTap ? handleMemberPress : undefined}
              onRemove={handleRemove}
              onFollow={handleFollow}
            />
          ))}

          {canManage ? (
            <TouchableOpacity
              style={styles.addButton}
              onPress={() => setPickerOpen(true)}
              accessibilityLabel={t('groupMembersSheet.addMembers')}
              testID="group-members-add"
            >
              <UserPlus size={20} color={colors.brandPink} strokeWidth={2} />
              <Text style={styles.addButtonText}>{t('groupMembersSheet.addMembers')}</Text>
            </TouchableOpacity>
          ) : null}
        </BottomSheetScrollView>
      </BottomSheetModal>

      {group && canManage ? (
        <FriendPickerSheet
          visible={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onSelect={handlePickerSelect}
          title={t('groupMembersSheet.addMembers')}
          subtitle={t('groupMembersSheet.pickFriendSubtitle')}
          excludePubkeys={group.memberPubkeys}
        />
      ) : null}
    </>
  );
};

export default GroupMembersSheet;
