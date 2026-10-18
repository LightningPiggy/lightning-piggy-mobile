import { useLocale } from '../contexts/LocaleContext';
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { createGroupRowStyles } from '../styles/GroupRow.styles';
import type { GroupSummary } from '../types/groups';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import GroupAvatar, { type ContactInfo } from './GroupAvatar';
import DmProtocolTag from './DmProtocolTag';
import { formatConversationTimestamp } from '../utils/conversationSummaries';
import { groupDmProtocol } from '../utils/groupProtocol';
import { previewMentions } from '../utils/chatMentions';
import { shortNpub } from '../utils/shortNpub';

interface Props {
  summary: GroupSummary;
  // Receives `summary` so the parent can pass a single stable handler
  // reference across all rows (no fresh arrow per render). Without this,
  // React.memo's prop comparison saw a new onPress every render and
  // re-rendered the row even when its data hadn't changed (#300 follow-up).
  onPress?: (summary: GroupSummary) => void;
  /**
   * Optional precomputed pubkey → ContactInfo map shared with sibling
   * rows by the parent screen. Forwarded to GroupAvatar (for the avatar
   * cluster) and consulted directly here for the sender-name lookup —
   * so neither path iterates the contacts list per row. See issue #245.
   */
  contactInfoMap?: Map<string, ContactInfo>;
  /** An unread message mentions the viewer (#1295): show the `@` badge. */
  mentioned?: boolean;
}

/** Resolve a friendly display name for a sender pubkey (kind-0 displayName
 * → name → petname → short npub fallback, never raw hex). When a parent has supplied
 * `contactInfoMap` we read from it (O(1)); otherwise we fall back to a
 * linear scan of `contacts` (legacy path for non-list call sites). */
function senderName(
  pubkey: string,
  contactInfoMap: Map<string, ContactInfo> | undefined,
  contacts: ReturnType<typeof useNostrContacts>['contacts'],
): string {
  const lc = pubkey.toLowerCase();
  const fromMap = contactInfoMap?.get(lc)?.name;
  if (fromMap) return fromMap;
  const c = contacts.find((x) => x.pubkey.toLowerCase() === lc);
  return (
    c?.profile?.displayName?.trim() ||
    c?.profile?.name?.trim() ||
    c?.petname?.trim() ||
    shortNpub(pubkey)
  );
}

const GroupRow: React.FC<Props> = ({ summary, onPress, contactInfoMap, mentioned = false }) => {
  const { t, formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createGroupRowStyles(colors), [colors]);
  const { pubkey: myPubkey } = useNostr();
  const { contacts } = useNostrContacts();
  const { group, activity } = summary;
  // Bind summary into the parent handler at the leaf so TouchableOpacity
  // sees a stable callback per render — see ConversationRow note.
  const handlePress = useMemo(
    () => (onPress ? () => onPress(summary) : undefined),
    [onPress, summary],
  );

  const timestamp = formatConversationTimestamp(activity.lastActivityAt, undefined, formatLocale);

  const preview = useMemo(() => {
    if (!activity.lastSenderPubkey || !activity.lastText) {
      const count = group.memberPubkeys.length + 1;
      return t(count === 1 ? 'groupsScreen.memberCountOne' : 'groupsScreen.memberCountOther', {
        count,
      });
    }
    const isMe = myPubkey && activity.lastSenderPubkey === myPubkey.toLowerCase();
    const who = isMe
      ? t('groupConversationScreen.you')
      : senderName(activity.lastSenderPubkey, contactInfoMap, contacts);
    // Mentions read as `@Name`, not the raw `nostr:npub…` (#1295).
    const text = previewMentions(
      activity.lastText,
      (pk) =>
        (pk === myPubkey?.toLowerCase() ? t('groupConversationScreen.you') : null) ??
        senderName(pk, contactInfoMap, contacts),
      shortNpub,
    );
    return `${who}: ${text}`;
  }, [activity, contacts, contactInfoMap, myPubkey, group.memberPubkeys.length, t]);

  // Avatar pubkeys: lead with recent senders so the people who've been
  // talking show up first. Top up from [viewer, ...members] so the cluster
  // size matches the actual people-count in the group (#363) — without
  // the viewer prefix, an inactive 1:1 group would render a single avatar
  // and a 3-person group only 2.
  const avatarPubkeys = useMemo(() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const pk of activity.recentSenderPubkeys) {
      const lc = pk.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(lc);
      if (out.length === 3) return out;
    }
    const fillSources = myPubkey ? [myPubkey, ...group.memberPubkeys] : group.memberPubkeys;
    for (const pk of fillSources) {
      const lc = pk.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(lc);
      if (out.length === 3) break;
    }
    return out;
  }, [activity.recentSenderPubkeys, group.memberPubkeys, myPubkey]);

  return (
    <TouchableOpacity
      style={styles.container}
      onPress={handlePress}
      activeOpacity={onPress ? 0.6 : 1}
      accessibilityLabel={`Open group ${group.name}`}
      testID={`group-row-${group.id}`}
    >
      <GroupAvatar
        pubkeys={avatarPubkeys}
        groupName={group.name}
        size={48}
        contactInfoMap={contactInfoMap}
      />
      <View style={styles.info}>
        <View style={styles.topRow}>
          <Text style={styles.name} numberOfLines={1}>
            {group.name}
          </Text>
          {/* Tag groups by transport like 1:1 rows (#1139): NIP-17 or Marmot. */}
          <DmProtocolTag
            protocol={groupDmProtocol(group)}
            testID={`group-protocol-tag-${group.id}`}
          />
          <Text style={styles.timestamp} numberOfLines={1}>
            {timestamp}
          </Text>
        </View>
        <View style={styles.previewRow}>
          <Text style={styles.preview} numberOfLines={1}>
            {preview}
          </Text>
          {mentioned ? (
            <View
              style={styles.mentionBadge}
              testID={`group-mention-badge-${group.id}`}
              accessibilityLabel={t('chatMentions.rowBadge')}
            >
              <Text style={styles.mentionBadgeText}>@</Text>
            </View>
          ) : null}
        </View>
      </View>
    </TouchableOpacity>
  );
};

export default React.memo(GroupRow);
