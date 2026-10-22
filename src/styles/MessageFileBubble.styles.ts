import { CHAT_CARD_MAX_WIDTH } from './chatCardWidth';
import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createMessageFileBubbleStyles = (colors: Palette, cardWidth = CHAT_CARD_MAX_WIDTH) =>
  StyleSheet.create({
    row: { flexDirection: 'row', marginVertical: 2 },
    sent: { justifyContent: 'flex-end' },
    bubble: {
      width: cardWidth,
      borderRadius: 14,
      overflow: 'hidden',
      backgroundColor: colors.surface,
    },
    sentBubble: { backgroundColor: colors.brandPinkLight },
    body: { padding: 12 },
    preview: {
      width: '100%',
      aspectRatio: 1 / Math.SQRT2,
      backgroundColor: '#fff',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
    },
    // Tap-to-load / loading / retry box, the size of the first-page preview.
    previewBox: {
      width: 'auto',
      alignSelf: 'stretch',
      aspectRatio: 1 / Math.SQRT2,
      margin: 8,
      marginBottom: 0,
    },
    name: { color: colors.textBody, fontWeight: '600', marginTop: 6 },
    caption: { color: colors.textSupplementary, fontSize: 12, marginTop: 4 },
    actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
    action: {
      flex: 1,
      minHeight: 40,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderWidth: 1.5,
      borderColor: colors.brandPink,
      borderRadius: 20,
      backgroundColor: colors.surface,
    },
    busy: { opacity: 0.5 },
    actionText: { color: colors.brandPink, fontWeight: '600' },
  });
