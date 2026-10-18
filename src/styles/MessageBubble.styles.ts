import { CHAT_CARD_MAX_WIDTH } from './chatCardWidth';
import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// Presentation for MessageBubble + its ImageBubble sub-component. Extracted
// from the component (#703 size cap) — pure data, no state closure.
export const createMessageBubbleStyles = (colors: Palette, cardWidth = CHAT_CARD_MAX_WIDTH) =>
  StyleSheet.create({
    bubbleRow: {
      flexDirection: 'row',
      marginVertical: 2,
    },
    bubbleRowLeft: { justifyContent: 'flex-start' },
    bubbleRowRight: { justifyContent: 'flex-end' },
    // Reaction pills (#205) sit just under the bubble on the same axis
    // (incoming → left, outgoing → right). A slight negative top margin pulls
    // them closer to the bubble's bottom edge so the pill reads as attached.
    reactionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 4,
      marginTop: -4,
      marginBottom: 4,
      // Match the bubble's inner padding. In groups this row lives inside
      // GroupMessageRow's body, so the avatar gutter stays outside the inset.
      paddingHorizontal: 12,
    },
    reactionRowLeft: { justifyContent: 'flex-start' },
    reactionRowRight: { justifyContent: 'flex-end' },
    reactionPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 12,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
    },
    reactionPillMine: {
      borderColor: colors.brandPink,
    },
    reactionPillEmoji: {
      fontSize: 13,
    },
    reactionPillCount: {
      fontSize: 11,
      fontWeight: '600',
      color: colors.textBody,
    },
    reactionPillCountMine: {
      color: colors.textBody,
    },
    senderLabel: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.textSupplementary,
      marginBottom: 2,
      textTransform: 'uppercase',
      letterSpacing: 0.4,
    },
    bubble: {
      maxWidth: '80%',
      paddingHorizontal: 12,
      paddingTop: 8,
      paddingBottom: 4,
      borderRadius: 16,
    },
    bubbleThem: {
      backgroundColor: colors.surface,
      borderBottomLeftRadius: 4,
    },
    bubbleMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
      borderBottomRightRadius: 4,
    },
    // Legacy NIP-04 RECEIVED bubble — surface bg kept (matches NIP-17), but a
    // violet left edge marks it as legacy on the incoming side too.
    bubbleThemNip04: {
      borderLeftWidth: 3,
      borderLeftColor: colors.brandPurple,
    },
    bubbleText: {
      fontSize: 15,
      color: colors.textBody,
      lineHeight: 20,
    },
    bubbleTextMe: {
      color: colors.outgoingBubble.foreground,
    },
    // Tappable URL span inside a received bubble (surface bg) — brand accent.
    bubbleLink: {
      color: colors.brandPink,
      textDecorationLine: 'underline',
    },
    // Sent links use the selected palette foreground for contrast.
    bubbleLinkMe: {
      color: colors.outgoingBubble.foreground,
      textDecorationLine: 'underline',
      fontWeight: '600',
    },
    // Quoted parent of a Marmot reply — a tinted strip with an accent bar at
    // the top of the bubble (WhatsApp / White Noise style).
    quoteBlock: {
      borderLeftWidth: 3,
      borderLeftColor: colors.brandPink,
      backgroundColor: 'rgba(124,139,154,0.16)',
      borderRadius: 6,
      paddingHorizontal: 8,
      paddingVertical: 4,
      marginBottom: 6,
    },
    quoteBlockMe: {
      borderLeftColor: colors.outgoingBubble.foreground,
      backgroundColor: 'rgba(0,0,0,0.08)',
    },
    quoteAuthor: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.brandPink,
    },
    quoteAuthorMe: { color: colors.outgoingBubble.foreground },
    quoteText: {
      fontSize: 13,
      color: colors.textSupplementary,
    },
    quoteTextMe: { color: colors.outgoingBubble.foreground },
    quoteTextMissing: { fontStyle: 'italic' },
    bubbleTime: {
      fontSize: 10,
      color: colors.textSupplementary,
      marginTop: 4,
      alignSelf: 'flex-end',
    },
    bubbleTimeMe: {
      color: colors.outgoingBubble.foreground,
    },
    // Footer row holds the timestamp + the delivery tick (sent bubbles, #856).
    // Right-aligned to sit under the bubble tail, same edge as the bare time.
    bubbleFooterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-end',
      marginTop: 4,
      gap: 4,
    },
    // The time inside the footer row drops its own marginTop (the row owns it)
    // and gains a small gap before the tick. It carries no colour of its own so
    // the composed timeStyle wins — bubbleTimeMe on a sent gradient,
    // bubbleTime (supplementary grey) on a received surface bubble. (#864)
    bubbleFooterTime: {
      fontSize: 10,
      marginRight: 4,
      // Zero the standalone bubbleTime top margin so the tick sits level with
      // the timestamp in the footer row (the row owns vertical spacing). (#858)
      marginTop: 0,
    },
    // Delivery ticks use the same AA foreground as outgoing timestamps.
    // Glyph alone carries the meaning: single Check = delivered to ≥1 relay,
    // double CheckCheck = all relays, Clock = pending, AlertCircle = failed.
    deliveryTickDelivered: {
      color: colors.outgoingBubble.foreground,
    },
    deliveryTickPending: {
      color: colors.outgoingBubble.foreground,
    },
    deliveryTickFailed: {
      color: colors.outgoingBubble.foreground,
    },
    invoiceCard: {
      width: cardWidth,
      paddingTop: 12,
      paddingBottom: 4,
      paddingHorizontal: 14,
      borderRadius: 14,
      gap: 6,
    },
    invoiceCardMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
    },
    invoiceCardThem: {
      backgroundColor: colors.surface,
    },
    invoiceLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    invoiceLabelMe: {
      color: colors.outgoingBubble.foreground,
    },
    invoiceAmount: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.textHeader,
      marginTop: 2,
    },
    invoiceAmountMe: {
      color: colors.outgoingBubble.foreground,
    },
    invoiceMemo: {
      fontSize: 14,
      color: colors.textBody,
      marginTop: 2,
    },
    invoiceMemoMe: {
      color: colors.outgoingBubble.foreground,
    },
    invoiceExpiry: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 4,
    },
    invoiceExpiryMe: {
      color: colors.outgoingBubble.foreground,
    },
    invoiceTagRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 6,
    },
    invoiceTag: {
      paddingHorizontal: 8,
      paddingVertical: 3,
      borderRadius: 10,
      alignSelf: 'flex-start',
    },
    invoiceTagPaid: {
      backgroundColor: '#2e7d32',
    },
    invoiceTagPaidText: {
      fontSize: 11,
      fontWeight: '700',
      color: '#ffffff',
      letterSpacing: 0.3,
    },
    invoiceTagUnpaid: {
      backgroundColor: 'rgba(0,0,0,0.65)',
    },
    invoiceTagUnpaidText: {
      fontSize: 11,
      fontWeight: '700',
      color: '#ffffff',
      letterSpacing: 0.3,
    },
    invoiceTagExpired: {
      backgroundColor: 'rgba(0,0,0,0.65)',
    },
    invoiceTagExpiredText: {
      fontSize: 11,
      fontWeight: '700',
      color: '#ffffff',
      letterSpacing: 0.3,
    },
    invoicePayButton: {
      marginTop: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: colors.brandPink,
    },
    invoicePayText: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.white,
    },
    // Stop-share controls use a foreground border over the outgoing gradient.
    liveStopButton: {
      marginTop: 8,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: colors.outgoingBubble.foreground,
      backgroundColor: 'rgba(0,0,0,0.08)',
    },
    contactCard: {
      width: cardWidth,
      paddingTop: 12,
      paddingBottom: 4,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderWidth: 1,
      gap: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    contactCardMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
      borderColor: colors.outgoingBubble.gradient[0],
    },
    contactCardThem: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
    },
    contactLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    contactLabelMe: {
      color: colors.outgoingBubble.foreground,
    },
    contactBodyRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    contactAvatar: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.background,
    },
    contactAvatarFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    contactInfo: {
      flex: 1,
      minWidth: 0,
    },
    contactName: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    contactNameMe: {
      color: colors.outgoingBubble.foreground,
    },
    contactLn: {
      fontSize: 13,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    contactLnMe: {
      color: colors.outgoingBubble.foreground,
    },
    gifCard: {
      width: cardWidth,
      borderRadius: 14,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    gifCardMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
    },
    gifCardThem: {
      backgroundColor: colors.surface,
    },
    gifImage: {
      width: '100%',
      aspectRatio: 1,
      backgroundColor: colors.background,
    },
    gifTime: {
      fontSize: 10,
      color: colors.textSupplementary,
      alignSelf: 'flex-end',
      paddingHorizontal: 14,
      paddingVertical: 4,
    },
    gifTimeMe: {
      color: colors.outgoingBubble.foreground,
    },
    locationCard: {
      width: cardWidth,
      borderRadius: 14,
      borderWidth: 1,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    locationCardMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
      borderColor: colors.outgoingBubble.gradient[0],
    },
    locationCardThem: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
    },
    locationMap: {
      width: '100%',
      height: 140,
      backgroundColor: colors.background,
    },
    locationBody: {
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 4,
      gap: 2,
    },
    locationLabelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    locationLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    locationLabelMe: {
      color: colors.outgoingBubble.foreground,
    },
    locationCoords: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textHeader,
      marginTop: 2,
    },
    locationCoordsMe: {
      color: colors.outgoingBubble.foreground,
    },
    locationAccuracy: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
    locationAccuracyMe: {
      color: colors.outgoingBubble.foreground,
    },
    imageBubble: {
      width: cardWidth,
      borderRadius: 14,
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    imageBubbleMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
    },
    imageBubbleThem: {
      backgroundColor: colors.surface,
    },
    imageBubbleImage: {
      width: '100%',
      aspectRatio: 1,
      backgroundColor: colors.background,
    },
    imageBubbleTime: {
      fontSize: 10,
      color: colors.textSupplementary,
      alignSelf: 'flex-end',
      paddingHorizontal: 14,
      paddingVertical: 4,
    },
    imageBubbleTimeMe: {
      color: colors.outgoingBubble.foreground,
    },
    pollCard: {
      width: cardWidth,
      paddingTop: 12,
      paddingBottom: 4,
      paddingHorizontal: 14,
      borderRadius: 14,
      borderWidth: 1,
      gap: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.05,
      shadowRadius: 2,
      elevation: 1,
    },
    pollCardMe: {
      overflow: 'hidden',
      backgroundColor: colors.outgoingBubble.gradient[0],
      borderColor: colors.outgoingBubble.gradient[0],
    },
    pollCardThem: {
      backgroundColor: colors.surface,
      borderColor: colors.divider,
    },
    pollHeaderRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    pollLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSupplementary,
      textTransform: 'uppercase',
      letterSpacing: 0.6,
    },
    pollLabelMe: {
      color: colors.outgoingBubble.foreground,
    },
    pollQuestion: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
      marginTop: 2,
    },
    pollQuestionMe: {
      color: colors.outgoingBubble.foreground,
    },
    pollOptionRow: {
      borderRadius: 10,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
      backgroundColor: colors.background,
      marginTop: 4,
      minHeight: 40,
      justifyContent: 'center',
    },
    // Outgoing options let the gradient show through; their text uses its foreground.
    pollOptionRowMe: {
      backgroundColor: 'transparent',
      borderColor: 'rgba(255,255,255,0.45)',
    },
    pollOptionRowMineThem: {
      borderColor: colors.brandPink,
    },
    pollOptionRowMineMe: {
      borderColor: colors.outgoingBubble.foreground,
    },
    pollOptionFill: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      left: 0,
    },
    pollOptionFillThem: {
      // Light pink wash for incoming polls — matches brand without
      // overwhelming the text. Sits behind the row content layer.
      backgroundColor: 'rgba(232, 62, 140, 0.12)',
    },
    pollOptionFillMe: {
      backgroundColor: 'rgba(0,0,0,0.08)',
    },
    pollOptionContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 8,
    },
    pollOptionText: {
      flex: 1,
      fontSize: 15,
      fontWeight: '600',
      color: colors.textBody,
    },
    pollOptionTextMe: {
      color: colors.outgoingBubble.foreground,
    },
    pollOptionMeta: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    pollOptionCount: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.textSupplementary,
      minWidth: 24,
      textAlign: 'right',
    },
    pollOptionCountMe: {
      color: colors.outgoingBubble.foreground,
    },
    pollFooter: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 4,
    },
    pollFooterMe: {
      color: colors.outgoingBubble.foreground,
    },
    // Muted placeholder bubble for an unrenderable inner event kind. Subdued
    // surface + dashed border + italic supplementary text so it reads as a
    // system/placeholder note rather than a real chat bubble.
    unsupportedBubble: {
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderStyle: 'dashed',
      borderColor: colors.divider,
    },
    unsupportedText: {
      fontSize: 13,
      fontStyle: 'italic',
      color: colors.textSupplementary,
      lineHeight: 18,
    },
  });

export type MessageBubbleStyles = ReturnType<typeof createMessageBubbleStyles>;
