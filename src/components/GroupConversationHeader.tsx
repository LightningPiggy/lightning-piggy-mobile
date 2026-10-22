import React, { useMemo } from 'react';
import { Text, TouchableOpacity } from 'react-native';
import ChatHeaderBar from './ChatHeaderBar';
import GroupAvatar, { type ContactInfo } from './GroupAvatar';
import GroupHeaderActions from './GroupHeaderActions';
import GroupHeaderTitle from './GroupHeaderTitle';
import type { ChatMenuProps } from './ChatMenu';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createChatHeaderStyles } from '../styles/ChatHeader.styles';
import type { Group } from '../types/groups';
import type { GroupMemberRow } from '../utils/groupMemberRows';

const HEADER_AVATAR_SIZE = 36;
const MAX_AVATARS = 3;

interface Props {
  group: Pick<Group, 'name' | 'protocol'>;
  members: GroupMemberRow[];
  canRename: boolean;
  menu: ChatMenuProps;
  onBack: () => void;
  onRename: () => void;
  onOpenMembers: () => void;
}

/**
 * The group thread header, in the same compact single-row layout as a 1:1
 * chat (ChatHeaderBar): back, the group avatar (other members' faces, or the
 * group-letter monogram) → members sheet, the name (→ rename when allowed)
 * over a quiet "13 members" line (→ members sheet), then the protocol pill
 * and the chat menu.
 */
function GroupConversationHeader({
  group,
  members,
  canRename,
  menu,
  onBack,
  onRename,
  onOpenMembers,
}: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createChatHeaderStyles(colors), [colors]);

  // The other members' faces (self excluded) feed the stacked avatar; the
  // member rows already resolve pictures for people the viewer doesn't follow.
  const { avatarPubkeys, contactInfoMap } = useMemo(() => {
    const map = new Map<string, ContactInfo>();
    const pubkeys: string[] = [];
    for (const m of members) {
      if (m.isSelf) continue;
      const pk = m.pubkey.toLowerCase();
      map.set(pk, { picture: m.picture, name: m.name, lightningAddress: null });
      if (pubkeys.length < MAX_AVATARS) pubkeys.push(pk);
    }
    return { avatarPubkeys: pubkeys, contactInfoMap: map };
  }, [members]);

  const memberCount =
    members.length === 1
      ? t('groupConversationScreen.memberCountOne', { count: members.length })
      : t('groupConversationScreen.memberCountOther', { count: members.length });

  return (
    <ChatHeaderBar
      onBack={onBack}
      backLabel={t('groupConversationScreen.back')}
      backTestID="group-back"
      avatar={
        <TouchableOpacity
          onPress={onOpenMembers}
          accessibilityLabel={t('groupConversationScreen.manageMembers')}
          testID="group-header-avatar"
        >
          <GroupAvatar
            pubkeys={avatarPubkeys}
            groupName={group.name}
            size={HEADER_AVATAR_SIZE}
            contactInfoMap={contactInfoMap}
            fillSingle
          />
        </TouchableOpacity>
      }
      title={<GroupHeaderTitle name={group.name} canRename={canRename} onRename={onRename} />}
      subtitle={
        // Tappable member-count line — opens GroupMembersSheet for
        // add/remove (#259).
        <TouchableOpacity
          onPress={onOpenMembers}
          accessibilityLabel={t('groupConversationScreen.manageMembers')}
          testID="group-member-count"
          hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={styles.headerByline} numberOfLines={1}>
            {memberCount}
          </Text>
        </TouchableOpacity>
      }
      trailing={<GroupHeaderActions group={group} menu={menu} />}
    />
  );
}

export default React.memo(GroupConversationHeader);
