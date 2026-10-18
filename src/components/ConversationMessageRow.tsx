import { MessageHighlight } from './MessageHighlight';
import { useLocale } from '../contexts/LocaleContext';
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Zap } from 'lucide-react-native';
import MessageBubble from './MessageBubble';
import ConversationOrderCard from './ConversationOrderCard';
import NwcShareCard from './NwcShareCard';
import MarmotInviteFailedNotice from './MarmotInviteFailedNotice';
import DeviceNoticeLine from './DeviceNoticeLine';
import type { TransactionDetailData } from './TransactionDetailSheet';
import type { Palette } from '../styles/palettes';
import type { ConversationStyles } from '../styles/ConversationScreen.styles';
import type { Item } from '../utils/conversationItems';
import type { NwcShareCard as NwcShareCardData } from '../utils/nwcShareMessage';
import { formatTime } from '../utils/messageContent';
import { withPeerName } from '../utils/messageQuote';

// Reuse MessageBubble's own prop types so the pass-through handlers can never
// drift from what the bubble expects.
type BubbleProps = React.ComponentProps<typeof MessageBubble>;

export interface ConversationMessageRowProps {
  item: Item;
  styles: ConversationStyles;
  colors: Palette;
  sharedProfiles: BubbleProps['sharedProfiles'];
  isInvoicePaid: BubbleProps['isInvoicePaid'];
  onPayInvoice: BubbleProps['onPayInvoice'];
  onOpenContact: BubbleProps['onOpenContact'];
  onOpenLocation: BubbleProps['onOpenLocation'];
  onOpenGifFullscreen: BubbleProps['onOpenGifFullscreen'];
  onToggleSecretMode: BubbleProps['onToggleSecretMode'];
  pollAggregates: BubbleProps['pollAggregates'];
  onVotePoll: BubbleProps['onVotePoll'];
  onShowTxDetail: (tx: TransactionDetailData) => void;
  // Live-location pass-throughs (#206) — latest coords / status / countdown
  // per session, plus the in-bubble "Stop" handler for the sender.
  liveLocationLatest: BubbleProps['liveLocationLatest'];
  liveLocationStatus: BubbleProps['liveLocationStatus'];
  liveLocationRemainingMs: BubbleProps['liveLocationRemainingMs'];
  onStopLiveLocation: BubbleProps['onStopLiveLocation'];
  // Location-card mini-map plumbing (#206) — my live position (for the
  // blue "me" dot + halo), the peer's avatar, and the Open-Map handler.
  myLat: BubbleProps['myLat'];
  myLon: BubbleProps['myLon'];
  myAccuracyMetres: BubbleProps['myAccuracyMetres'];
  myAvatarUri: BubbleProps['myAvatarUri'];
  peerAvatarUri: BubbleProps['peerAvatarUri'];
  onOpenMap: BubbleProps['onOpenMap'];
  // Tap a bubble → parent presents the message-info sheet (sent OR received,
  // #856). Passed straight through to MessageBubble.
  onShowInfo: BubbleProps['onShowInfo'];
  // Per-message reactions + long-press → action sheet (#205). The screen
  // builds these per-item (only for message/gif/location rows with a stable
  // rumor id) and passes them straight through to the bubble.
  onLongPress: BubbleProps['onLongPress'];
  reactions: BubbleProps['reactions'];
  onToggleReaction: BubbleProps['onToggleReaction'];
  // Recipient taps Add on a shared-NWC card → parent re-confirms the trust
  // warning and runs the NWC import path.
  onAddNwc: (card: NwcShareCardData) => void;
  /** The contact's display name — who a 1:1 reply's quoted parent is from. */
  peerName?: string;
  /** The contact's pubkey (hex) — the buyer on an order I received. */
  peerPubkey?: string;
  /** A failed Marmot invite's "Ask for a new invite" (#1269). */
  onAskForInvite?: () => void;
  /** I follow the peer (#1338): their media / link previews load without a
   *  tap. My own messages always load. */
  peerMediaTrusted: boolean;
}

/**
 * One row of the 1:1 ConversationScreen FlatList. Extracted from the screen's
 * inline `renderItem` to keep the screen under the #703 size cap. Renders the
 * day-header rule, the wallet-derived zap card (1:1-only — groups don't pair
 * zap receipts to a single peer), or a MessageBubble for text/gif/location.
 */
function ConversationMessageRow({
  item,
  styles,
  colors,
  sharedProfiles,
  isInvoicePaid,
  onPayInvoice,
  onOpenContact,
  onOpenLocation,
  onOpenGifFullscreen,
  onToggleSecretMode,
  pollAggregates,
  onVotePoll,
  onShowTxDetail,
  liveLocationLatest,
  liveLocationStatus,
  liveLocationRemainingMs,
  onStopLiveLocation,
  myLat,
  myLon,
  myAccuracyMetres,
  myAvatarUri,
  peerAvatarUri,
  onOpenMap,
  onShowInfo,
  onLongPress,
  reactions,
  onToggleReaction,
  onAddNwc,
  peerName,
  peerPubkey,
  onAskForInvite,
  peerMediaTrusted,
}: ConversationMessageRowProps): React.ReactElement {
  const { formatLocale, t } = useLocale();
  if (item.kind === 'dayHeader') {
    return (
      <View style={styles.dayHeaderRow}>
        <View style={styles.dayHeaderRule} />
        <Text style={styles.dayHeaderText}>{item.label}</Text>
        <View style={styles.dayHeaderRule} />
      </View>
    );
  }
  // Wallet-derived zap variant — Lightning tx pulled from the wallet's
  // ledger, NOT a Nostr message. Stays here because it's the only
  // 1:1-specific Item kind: groups don't pair zap receipts to a single
  // peer, so MessageBubble doesn't carry this case.
  if (item.kind === 'zap') {
    return (
      <View style={[styles.zapRow, item.fromMe ? styles.zapRowRight : styles.zapRowLeft]}>
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => onShowTxDetail(item.tx)}
          style={[styles.zapCard, item.fromMe ? styles.zapCardMe : styles.zapCardThem]}
          accessibilityLabel={item.fromMe ? 'Zap sent' : 'Zap received'}
          testID={`conversation-zap-${item.id}`}
        >
          <View
            style={[
              styles.zapCardIconBadge,
              item.fromMe ? styles.zapCardIconBadgeMe : styles.zapCardIconBadgeThem,
            ]}
          >
            <Zap
              size={18}
              color={item.fromMe ? colors.brandPink : colors.white}
              fill={item.fromMe ? colors.brandPink : colors.white}
            />
          </View>
          <View style={styles.zapCardBody}>
            <Text style={[styles.zapCardLabel, item.fromMe && styles.zapCardLabelMe]}>
              {item.fromMe ? 'Zap sent' : 'Zap received'}
            </Text>
            <Text style={[styles.zapCardAmount, item.fromMe && styles.zapCardAmountMe]}>
              {item.amountSats.toLocaleString(formatLocale)} sats
            </Text>
            {item.comment ? (
              <Text style={[styles.zapCardComment, item.fromMe && styles.zapCardCommentMe]}>
                {item.comment}
              </Text>
            ) : null}
            <Text style={[styles.bubbleTime, item.fromMe && styles.bubbleTimeMe]}>
              {formatTime(item.createdAt)}
            </Text>
          </View>
        </TouchableOpacity>
      </View>
    );
  }
  // Marketplace order / receipt card (#market) — a Gamma kind-16/17 rumor,
  // rendered as its own structured card rather than a chat bubble.
  if (item.kind === 'order') {
    return (
      <ConversationOrderCard
        item={item}
        peerPubkey={peerPubkey}
        isInvoicePaid={isInvoicePaid}
        onPayInvoice={onPayInvoice}
      />
    );
  }
  // "Add NWC Wallet" card (#431) — a peer shared an NWC wallet over an encrypted
  // NIP-17 DM. Structured, non-text, and carries a bearer secret, so it renders
  // as its own QR-plus-warning card (like the zap / order cards) rather than a
  // MessageBubble.
  if (item.kind === 'nwcShare') {
    return (
      <NwcShareCard
        card={item.card}
        fromMe={item.fromMe}
        createdAt={item.createdAt}
        colors={colors}
        onAdd={onAddNwc}
      />
    );
  }
  if (item.kind === 'deviceNotice') {
    return (
      <DeviceNoticeLine
        id={item.id}
        createdAt={item.createdAt}
        name={
          item.isSelf ? t('chatDevices.you') : peerName?.trim() || t('marmotInviteFailed.someone')
        }
        joined={item.joined}
        clients={item.clients}
        colors={colors}
      />
    );
  }
  if (item.kind === 'marmotInviteFailed') {
    return (
      <MarmotInviteFailedNotice
        id={item.id}
        createdAt={item.createdAt}
        peerName={peerName}
        colors={colors}
        onAskAgain={onAskForInvite}
      />
    );
  }
  // Map the local Item shape to MessageBubble's `BubbleContent`. The Items
  // array was already classified upstream (buildConversationItems calls
  // classifyMessageContent) so this is a flat re-tag — MessageBubble handles
  // the remaining text-format detection (image / invoice / lnaddr / contact).
  const content =
    item.kind === 'gif'
      ? ({ kind: 'gif', url: item.url } as const)
      : item.kind === 'location'
        ? ({ kind: 'location', location: item.location } as const)
        : item.kind === 'poll'
          ? ({ kind: 'poll', poll: item.poll, pollId: item.pollId } as const)
          : item.kind === 'liveLocationMarker'
            ? ({ kind: 'liveLocationMarker', marker: item.marker } as const)
            : item.kind === 'unsupported'
              ? ({ kind: 'unsupported', rawKind: item.rawKind } as const)
              : item.file
                ? ({ kind: 'file', file: item.file } as const)
                : ({ kind: 'text', text: item.text } as const);
  return (
    <MessageBubble
      id={item.id}
      fromMe={item.fromMe}
      createdAt={item.createdAt}
      content={content}
      senderName={
        item.kind === 'unsupported'
          ? item.fromMe
            ? t('messageBubble.quoteYou')
            : peerName
          : undefined
      }
      sharedProfiles={sharedProfiles}
      isInvoicePaid={isInvoicePaid}
      onPayInvoice={onPayInvoice}
      onPayLightningAddress={onPayInvoice}
      onOpenContact={onOpenContact}
      onOpenLocation={onOpenLocation}
      onOpenGifFullscreen={onOpenGifFullscreen}
      onToggleSecretMode={onToggleSecretMode}
      pollAggregates={pollAggregates}
      onVotePoll={onVotePoll}
      liveLocationLatest={liveLocationLatest}
      liveLocationStatus={liveLocationStatus}
      liveLocationRemainingMs={liveLocationRemainingMs}
      onStopLiveLocation={onStopLiveLocation}
      myLat={myLat}
      myLon={myLon}
      myAccuracyMetres={myAccuracyMetres}
      myAvatarUri={myAvatarUri}
      peerAvatarUri={peerAvatarUri}
      onOpenMap={onOpenMap}
      deliveryStatus={item.kind === 'message' ? item.deliveryStatus : undefined}
      wireKind={item.kind === 'message' ? item.wireKind : undefined}
      onShowInfo={onShowInfo}
      onLongPress={onLongPress}
      reactions={reactions}
      onToggleReaction={onToggleReaction}
      quote={'quote' in item ? withPeerName(item.quote, peerName) : undefined}
      edited={item.kind === 'message' ? item.edited : undefined}
      autoLoadMedia={item.fromMe || peerMediaTrusted}
      testIdPrefix="conversation"
    />
  );
}

const MemoConversationMessageRow = React.memo(ConversationMessageRow);
export default React.memo(function HighlightedConversationMessageRow(
  props: ConversationMessageRowProps,
) {
  return (
    <MessageHighlight messageId={props.item.id.replace(/^dm-/, '')}>
      <MemoConversationMessageRow {...props} />
    </MessageHighlight>
  );
});
