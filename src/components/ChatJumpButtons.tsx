import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { ArrowDown } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createChatJumpButtonsStyles } from '../styles/ChatJumpButtons.styles';

/** Badge text: counts past 99 collapse to "99+". */
const badge = (n: number) => (n > 99 ? '99+' : String(n));

/**
 * Floating chat buttons on one row above the composer (#1295): the arrow,
 * centred, jumps to the newest message (shown while the reader is up in
 * history); `@`, right-aligned on the same row, jumps to the next unread
 * mention (shown while there are any). Each carries a count.
 */
const ChatJumpButtons: React.FC<{
  mentionCount: number;
  onJumpToMention: () => void;
  showLatest: boolean;
  unreadCount: number;
  onJumpToLatest: () => void;
  testIDs: { mention: string; latest: string };
}> = ({ mentionCount, onJumpToMention, showLatest, unreadCount, onJumpToLatest, testIDs }) => {
  const colors = useThemeColors();
  const styles = useMemo(() => createChatJumpButtonsStyles(colors), [colors]);
  const t = useTranslation();
  if (mentionCount === 0 && !showLatest) return null;
  return (
    <View style={styles.row} pointerEvents="box-none">
      {mentionCount > 0 ? (
        <TouchableOpacity
          style={[styles.fab, styles.mention]}
          onPress={onJumpToMention}
          accessibilityRole="button"
          accessibilityLabel={t('liveMessages.jumpToMention', { count: mentionCount })}
          testID={testIDs.mention}
        >
          <Text style={styles.atSign}>@</Text>
          {mentionCount > 1 ? (
            <View style={styles.count}>
              <Text style={styles.countText}>{badge(mentionCount)}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      ) : null}
      {showLatest ? (
        <TouchableOpacity
          style={styles.fab}
          onPress={onJumpToLatest}
          accessibilityRole="button"
          accessibilityLabel={
            unreadCount > 0
              ? t('liveMessages.jumpToLatestUnread', { count: unreadCount })
              : t('liveMessages.jumpToLatest')
          }
          testID={testIDs.latest}
        >
          <ArrowDown size={20} color={colors.white} />
          {unreadCount > 0 ? (
            <View style={styles.count} testID={`${testIDs.latest}-count`}>
              <Text style={styles.countText}>{badge(unreadCount)}</Text>
            </View>
          ) : null}
        </TouchableOpacity>
      ) : null}
    </View>
  );
};

export default React.memo(ChatJumpButtons);
