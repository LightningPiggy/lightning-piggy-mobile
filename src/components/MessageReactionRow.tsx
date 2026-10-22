import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useTranslation } from '../contexts/LocaleContext';
import type { MessageReactionState } from '../utils/reactions';
import type { MessageBubbleStyles } from '../styles/MessageBubble.styles';
export default function MessageReactionRow({
  reactions,
  fromMe,
  styles,
  testIdPrefix,
  id,
  onToggleReaction,
}: {
  reactions?: MessageReactionState;
  fromMe: boolean;
  styles: MessageBubbleStyles;
  testIdPrefix: string;
  id: string;
  onToggleReaction?: (emoji: string, existingReactionId: string | null) => void;
}) {
  const t = useTranslation();
  const reactionEmojis = reactions ? Object.keys(reactions.byEmoji) : [];
  return reactionEmojis.length > 0 ? (
    <View
      style={[styles.reactionRow, fromMe ? styles.reactionRowRight : styles.reactionRowLeft]}
      testID={`${testIdPrefix}-reactions-${id}`}
    >
      {reactionEmojis.map((emoji) => {
        const reactors = reactions!.byEmoji[emoji];
        const myReactionId = reactions!.myReactions[emoji] ?? null;
        const mine = myReactionId !== null;
        const pending = mine && !!reactions!.pending?.[emoji];
        return (
          <TouchableOpacity
            key={emoji}
            activeOpacity={0.7}
            disabled={!onToggleReaction}
            onPress={() => onToggleReaction?.(emoji, myReactionId)}
            style={[
              styles.reactionPill,
              mine && styles.reactionPillMine,
              pending && styles.reactionPillPending,
            ]}
            accessibilityRole="button"
            accessibilityState={{ disabled: !onToggleReaction, busy: pending }}
            accessibilityLabel={
              mine
                ? t('messageBubble.reactionRemove', { emoji, count: reactors.length })
                : t('messageBubble.reactionAdd', { emoji, count: reactors.length })
            }
            testID={`${testIdPrefix}-reaction-${id}-${emoji}`}
          >
            <Text style={styles.reactionPillEmoji}>{emoji}</Text>
            {reactors.length > 1 ? (
              <Text style={[styles.reactionPillCount, mine && styles.reactionPillCountMine]}>
                {reactors.length}
              </Text>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  ) : null;
}
