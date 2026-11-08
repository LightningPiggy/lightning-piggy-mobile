import BrandedSpinner from './BrandedSpinner';
import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import {
  Check,
  ChevronDown,
  ChevronUp,
  Ellipsis,
  UserPlus,
  UserRound,
  X,
} from 'lucide-react-native';
import { useTranslation } from '../contexts/LocaleContext';
import type { Palette } from '../styles/palettes';
import type { GroupMembersSheetStyles } from '../styles/GroupMembersSheet.styles';
import type { GroupMemberRow } from '../utils/groupMemberRows';
import { isSupportedImageUrl } from '../utils/imageUrl';
import type { DeviceInfo } from '../services/marmotDeviceTracker';
import type { InviteStatus } from '../services/marmotWelcomePayloads';
import { inviteStatusTextKey } from '../utils/marmotInviteNotice';
import MemberDeviceList from './MemberDeviceList';

interface Props {
  member: GroupMemberRow;
  styles: GroupMembersSheetStyles;
  colors: Palette;
  canRemove: boolean;
  /** Marmot only: this member is in the group's `admin_pubkeys`. */
  isAdmin: boolean;
  /** An admin action on this row is committing — admin changes are single-flight. */
  adminActionsDisabled?: boolean;
  /** This row's Follow is publishing. */
  followPending: boolean;
  /** Another row's Follow is publishing — follows are single-flight. */
  followDisabled: boolean;
  onPress?: (member: GroupMemberRow) => void;
  onRemove: (member: GroupMemberRow) => void;
  onFollow: (member: GroupMemberRow) => void;
  /** Present = the viewer may change this member's admin status ("⋯" menu). */
  onAdminActions?: (member: GroupMemberRow) => void;
  /** Marmot: how many devices they have in this chat (#1267). */
  deviceCount?: number;
  /** Their device list is open. */
  devicesExpanded?: boolean;
  /** Their devices (null while loading); read only when expanded. */
  devices?: readonly DeviceInfo[] | null;
  onToggleDevices?: (member: GroupMemberRow) => void;
  /** Marmot: their invitation hasn't reached them yet, and why (#1402). */
  inviteStatus?: InviteStatus;
  /** Amber / NIP-46: the status line says it waits for the next send. */
  remoteSigner?: boolean;
}

/**
 * One member row in `GroupMembersSheet`: avatar, name, follow status
 * (Following marker / Follow button, never on the self row — #1268) and the
 * admin-only Remove button, plus (Marmot) an Admin badge and the admin-only
 * "⋯" admin menu. Marmot chats add a "2 devices" toggle under the row that
 * opens the person's device list (#1267). Memoised; every handler takes the
 * row back so the parent can pass stable callbacks.
 */
const GroupMemberListRow: React.FC<Props> = ({
  member,
  styles,
  colors,
  canRemove,
  isAdmin,
  adminActionsDisabled = false,
  followPending,
  followDisabled,
  onPress,
  onRemove,
  onFollow,
  onAdminActions,
  deviceCount,
  devicesExpanded = false,
  devices = null,
  onToggleDevices,
  inviteStatus,
  remoteSigner = false,
}) => {
  const t = useTranslation();
  const tid = member.pubkey.slice(0, 12);
  const tappable = !!onPress && !member.isSelf;
  const profileLabel = t('groupMembersSheet.viewProfile', { name: member.name });
  // The row is a plain View so screen readers reach each control: the profile
  // button (its label carries admin status) and the action buttons beside it.
  // The device toggle sits under it, outside the profile button, for the
  // same reason.
  const showDevices = deviceCount !== undefined && !!onToggleDevices;
  return (
    <View>
      <View style={styles.row}>
        <TouchableOpacity
          style={styles.rowProfile}
          onPress={tappable ? () => onPress(member) : undefined}
          activeOpacity={tappable ? 0.6 : 1}
          accessibilityLabel={
            isAdmin
              ? `${profileLabel}. ${t('groupMembersSheet.adminA11y', { name: member.name })}`
              : profileLabel
          }
          testID={`group-member-row-${tid}`}
        >
          <View style={styles.avatar}>
            {member.picture && isSupportedImageUrl(member.picture) ? (
              <Image
                source={{ uri: member.picture }}
                style={styles.avatarImage}
                cachePolicy="memory-disk"
                recyclingKey={member.picture}
                autoplay={false}
              />
            ) : (
              <UserRound size={22} color={colors.textBody} strokeWidth={1.75} />
            )}
          </View>
          <View style={styles.rowNameWrap}>
            <Text style={styles.rowName} numberOfLines={1}>
              {member.name}
              {member.isSelf ? (
                <Text style={styles.youTag}>{t('groupMembersSheet.youTag')}</Text>
              ) : null}
            </Text>
            {isAdmin ? (
              <View style={styles.adminBadge} testID={`group-member-admin-badge-${tid}`}>
                <Text style={styles.adminBadgeText}>{t('groupMembersSheet.admin')}</Text>
              </View>
            ) : null}
          </View>
        </TouchableOpacity>
        {member.isSelf ? null : member.following ? (
          <View
            style={styles.followingMarker}
            accessible
            accessibilityLabel={t('groupMembersSheet.followingA11y', { name: member.name })}
            testID={`group-member-following-${tid}`}
          >
            <Check size={14} color={colors.textSupplementary} strokeWidth={2.5} />
            <Text style={styles.followingText}>{t('groupMembersSheet.following')}</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.followButton, followDisabled && styles.followButtonDisabled]}
            onPress={() => onFollow(member)}
            disabled={followPending || followDisabled}
            accessibilityRole="button"
            accessibilityLabel={t('groupMembersSheet.followMember', { name: member.name })}
            accessibilityState={{ busy: followPending, disabled: followPending || followDisabled }}
            testID={`group-member-follow-${tid}`}
            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          >
            {followPending ? (
              <BrandedSpinner size="small" onGradient />
            ) : (
              <>
                <UserPlus size={14} color={colors.white} strokeWidth={2.5} />
                <Text style={styles.followButtonText}>{t('groupMembersSheet.follow')}</Text>
              </>
            )}
          </TouchableOpacity>
        )}
        {onAdminActions ? (
          <TouchableOpacity
            style={[styles.actionsButton, adminActionsDisabled && styles.followButtonDisabled]}
            onPress={() => onAdminActions(member)}
            disabled={adminActionsDisabled}
            accessibilityRole="button"
            accessibilityLabel={t('groupMembersSheet.adminActions', { name: member.name })}
            accessibilityState={{ disabled: adminActionsDisabled }}
            testID={`group-member-actions-${tid}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ellipsis size={18} color={colors.textBody} strokeWidth={2.5} />
          </TouchableOpacity>
        ) : null}
        {canRemove && !member.isSelf ? (
          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => onRemove(member)}
            accessibilityLabel={t('groupMembersSheet.removeMember', { name: member.name })}
            testID={`group-member-remove-${tid}`}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={18} color={colors.brandPink} strokeWidth={2.5} />
          </TouchableOpacity>
        ) : null}
      </View>
      {inviteStatus ? (
        <Text
          style={styles.inviteStatus}
          testID={`group-member-invite-status-${tid}`}
          accessibilityLabel={t(inviteStatusTextKey(inviteStatus, remoteSigner), {
            name: member.name,
          })}
        >
          {t(inviteStatusTextKey(inviteStatus, remoteSigner), { name: member.name })}
        </Text>
      ) : null}
      {showDevices ? (
        <TouchableOpacity
          style={styles.deviceToggle}
          onPress={() => onToggleDevices(member)}
          accessibilityRole="button"
          accessibilityLabel={t(
            devicesExpanded ? 'chatDevices.hideDevicesA11y' : 'chatDevices.showDevicesA11y',
            { name: member.name },
          )}
          accessibilityState={{ expanded: devicesExpanded }}
          testID={`group-member-devices-toggle-${tid}`}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={styles.deviceToggleText}>
            {t('chatDevices.deviceCount', { count: deviceCount })}
          </Text>
          {devicesExpanded ? (
            <ChevronUp size={14} color={colors.textSupplementary} strokeWidth={2} />
          ) : (
            <ChevronDown size={14} color={colors.textSupplementary} strokeWidth={2} />
          )}
        </TouchableOpacity>
      ) : null}
      {showDevices && devicesExpanded ? (
        <MemberDeviceList tid={tid} devices={devices} styles={styles} colors={colors} />
      ) : null}
    </View>
  );
};

export default React.memo(GroupMemberListRow);
