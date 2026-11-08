import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import ConversationRow from './ConversationRow';
import GroupRow from './GroupRow';
import { useNostrContacts, useNostrDmInbox } from '../contexts/NostrContext';
import { useGroups } from '../contexts/GroupsContext';
import { useTrustGraph } from '../contexts/TrustGraphContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createShareTargetRecentsStyles } from '../styles/ShareTargetRecents.styles';
import { buildDmSummaries, type ConversationSummary } from '../utils/conversationSummaries';
import { recentShareTargets } from '../utils/shareTargets';
import type { GroupSummary } from '../types/groups';

interface Props {
  query: string;
  onSelectDm: (summary: ConversationSummary) => void;
  onSelectGroup: (summary: GroupSummary) => void;
}

/**
 * The top of the "Share to Lightning Piggy" picker (#1692): the user's most
 * recent chats — 1:1 (NIP-17 and Marmot) and groups — as the same rows the
 * Messages tab shows, then a heading for the friend list below. Uses the same
 * trust gate as the Messages tab, so nobody shows here who wouldn't there.
 */
const ShareTargetRecents: React.FC<Props> = ({ query, onSelectDm, onSelectGroup }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createShareTargetRecentsStyles(colors), [colors]);
  const { dmInbox } = useNostrDmInbox();
  const { contacts } = useNostrContacts();
  const { groupSummaries, effectiveWotTier } = useGroups();
  const { trustSetForTier } = useTrustGraph();

  const dmSummaries = useMemo(
    () =>
      buildDmSummaries(
        dmInbox,
        contacts,
        effectiveWotTier !== 'all' ? trustSetForTier(effectiveWotTier) : undefined,
      ),
    [dmInbox, contacts, effectiveWotTier, trustSetForTier],
  );
  const recents = useMemo(
    () => recentShareTargets(dmSummaries, groupSummaries, query),
    [dmSummaries, groupSummaries, query],
  );

  return (
    <View>
      {recents.length > 0 ? (
        <>
          <Text style={styles.sectionLabel} accessibilityRole="header">
            {t('shareIntent.recentChats')}
          </Text>
          {recents.map((row, index) => (
            <View key={row.key} testID={`share-target-recent-${index}`}>
              {row.kind === 'dm' ? (
                <ConversationRow summary={row.summary} onPress={onSelectDm} />
              ) : (
                <GroupRow summary={row.summary} onPress={onSelectGroup} />
              )}
            </View>
          ))}
        </>
      ) : null}
      <Text style={styles.sectionLabel} accessibilityRole="header">
        {t('shareIntent.friends')}
      </Text>
    </View>
  );
};

export default React.memo(ShareTargetRecents);
