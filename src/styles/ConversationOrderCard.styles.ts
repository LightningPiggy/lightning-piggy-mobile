import { CHAT_CARD_MAX_WIDTH } from './chatCardWidth';
import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Marketplace order card in a 1:1 conversation (Gamma Markets kind 16/17). */
export const createConversationOrderCardStyles = (
  colors: Palette,
  cardWidth = CHAT_CARD_MAX_WIDTH,
) =>
  StyleSheet.create({
    // A structured card for a kind-16/17 event, distinct from a chat bubble.
    // Accent uses the bitcoin orange to read as transactional.
    orderRow: {
      flexDirection: 'row',
      marginVertical: 4,
    },
    orderRowLeft: { justifyContent: 'flex-start' },
    orderRowRight: { justifyContent: 'flex-end' },
    orderCard: {
      width: cardWidth,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderWidth: 1,
      backgroundColor: colors.surface,
      borderColor: colors.bitcoinOrange,
      borderLeftWidth: 4,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    orderCardHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    orderCardEmoji: {
      fontSize: 16,
    },
    orderCardLabel: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    orderCardId: {
      fontSize: 13,
      color: colors.textBody,
      marginTop: 6,
    },
    orderCardAmount: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
      marginTop: 2,
    },
    orderCardMeta: {
      fontSize: 13,
      color: colors.textBody,
      marginTop: 2,
    },
    orderCardMessage: {
      fontSize: 13,
      color: colors.textSupplementary,
      marginTop: 6,
    },
    orderCardWaiting: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: 8,
    },
    orderCardWaitingText: {
      flexShrink: 1,
      fontSize: 13,
      fontStyle: 'italic',
      color: colors.textSupplementary,
    },
    // Same as the chat bubble timestamp.
    orderCardTime: {
      fontSize: 10,
      color: colors.textSupplementary,
      marginTop: 4,
      alignSelf: 'flex-end',
    },
  });

export type ConversationOrderCardStyles = ReturnType<typeof createConversationOrderCardStyles>;
