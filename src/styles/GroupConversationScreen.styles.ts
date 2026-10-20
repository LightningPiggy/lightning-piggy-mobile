import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// Styles for GroupConversationScreen — own module per the src/styles/<Name>.styles.ts
// convention (and to keep the screen under the #703 size cap). Themed via Palette.
export const createGroupConversationScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    // The thread header is the compact GroupConversationHeader (shared
    // ChatHeaderBar layout with the 1:1 thread); this is only the "Group"
    // title of the not-found fallback, in the same typography.
    title: {
      color: colors.textHeader,
      fontSize: 16,
      fontWeight: '700',
    },
    content: {
      flex: 1,
      backgroundColor: colors.background,
    },
    messagesList: {
      paddingVertical: 12,
      paddingHorizontal: 12,
      gap: 6,
      flexGrow: 1,
    },
    // Bubble + per-message-type styles moved to src/components/MessageBubble
    // — both 1:1 and group screens render the same bubble component now.
    // composer + input + attachButton + sendButton + sendButtonDisabled
    // moved to ConversationComposer (#251) — kept in sync with the 1:1
    // screen via that shared component.
    emptyState: {
      padding: 40,
      alignItems: 'center',
      gap: 8,
    },
    emptyTitle: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
    },
    emptySubtitle: {
      fontSize: 14,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
  });
