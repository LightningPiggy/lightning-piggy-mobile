import { useChatCardWidth } from '../styles/chatCardWidth';
import { useGifMedia } from '../hooks/useGifMedia';
import TapToLoadMedia, { displayHost } from './TapToLoadMedia';
import { sanitizeDisplayText } from '../utils/sanitizeDisplayText';
import { npubEncode } from 'nostr-tools/nip19';
import MessageReactionRow from './MessageReactionRow';
import OutgoingBubbleBackground from './OutgoingBubbleBackground';
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity, Pressable, StyleSheet } from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { Zap, UserRound, Radio } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createMessageBubbleStyles } from '../styles/MessageBubble.styles';
import type { NostrProfile } from '../types/nostr';
import { formatCoordsForDisplay, type SharedLocation } from '../services/locationService';
import type { BtcMapPlace } from '../services/btcMapService';
import type { ParsedCache, ParsedEvent } from '../services/nostrPlacesService';
import {
  type BubbleContent,
  extractBitcoinUri,
  parseImageMessage,
  parseVoiceNote,
  extractInvoice,
  extractLightningAddress,
  extractSharedContact,
  isSecretModeTrigger,
  formatRelativeFuture,
} from '../utils/messageContent';
import type { PollTally } from '../utils/nip88Poll';
import MessageFileBubble from './MessageFileBubble';
import MessageSharedListing from './MessageSharedListing';
import { extractSharedListing, sharedListingParts } from '../utils/listingShare';
import { useSharedContactAvatar } from '../hooks/useSharedContactAvatar';
import { type DeliveryStatus } from '../utils/dmDeliveryStatus';
import { resendPayloadFor } from '../utils/messageInfo';
import type { ShowMessageInfoArgs } from '../hooks/useMessageInfoSheet';
import { firstPreviewableUrl } from '../services/linkPreviewBlocklist';
import type { MessageReactionState } from '../utils/reactions';
import MessageLinkPreview from './MessageLinkPreview';
import { MessageQuote } from './MessageQuote';
import { LinkifiedText } from './LinkifiedText';
import type { MessageQuote as MessageQuoteData } from '../utils/messageQuote';
import MessageInvoiceActions from './MessageInvoiceActions';
import VoiceNotePlayer from './VoiceNotePlayer';
import MessageImageBubble from './MessageImageBubble';
import LibreMiniMap from './LibreMiniMap';
import { BubbleFooter } from './MessageBubbleFooter';
import MessageSatsAmount from './MessageSatsAmount';
import { PollBubble } from './PollBubble';
import { LocationBubble } from './LocationBubble';
import { liveKey } from '../services/liveLocationUpdateStore';
import { liveLocationBubbleText } from '../utils/liveLocationBubbleText';

// Stable empty arrays for the location-card mini-maps — LibreMiniMap
// requires merchants/caches/events, but DM cards never plot any. Module
// constants so the memoised map doesn't see a fresh [] each render.
const EMPTY_MERCHANTS: BtcMapPlace[] = [];
const EMPTY_CACHES: ParsedCache[] = [];
const EMPTY_EVENTS: ParsedEvent[] = [];

interface Props {
  // Identifying fields used for testID stability and parent diffing.
  id: string;
  fromMe: boolean;
  createdAt: number;
  // Pre-classified content. The parent classifies once (gif vs location vs
  // text) so we don't re-parse `geo:` / GIF URLs on every render frame. The
  // remaining variants (image / invoice / lnaddr / contact) ride on the
  // `text` kind and are detected here on render — those parsers are cheap
  // (regex + one bolt11Decode), so the savings of pre-binding them aren't
  // worth the extra parent-side state.
  content: BubbleContent;
  // Group chats want a "From: Sender" line above non-self bubbles. 1:1 chats
  // pass `null` (the conversation is implicitly with one peer).
  senderName?: string | null;
  // Shared-contact card needs the resolved kind-0 profile to render an
  // avatar + display name. Parent owns the fetch (so it can batch and
  // cache); the bubble looks up by pubkey.
  sharedProfiles?: Record<string, NostrProfile | null>;
  // Optional invoice paid-status predicate. 1:1 polls NWC to flip "Paid";
  // groups currently can't (no per-message wallet binding), so they pass
  // `undefined` and the bubble renders as Unpaid until expiry.
  isInvoicePaid?: (paymentHash: string, fromMe: boolean) => boolean;
  // Pay-button taps. Parent opens its SendSheet pre-filled with the
  // bolt11 raw / lightning address.
  onPayInvoice: (rawInvoice: string) => void;
  onPayLightningAddress: (address: string) => void;
  // Tap a shared-contact card → parent opens its ContactProfileSheet.
  onOpenContact: (pubkey: string, profile: NostrProfile | null) => void;
  // Tap a location card → parent opens OSM in the system browser.
  onOpenLocation: (location: SharedLocation) => void;
  // Live-location bubble extras. The parent owns the live state (most
  // recent ping, remaining time) so the bubble stays a pure renderer
  // and doesn't need its own context dependency.
  //   - `liveLocationLatest`: latest coords seen since the start marker
  //     landed, keyed by sessionId. Falls back to the marker's coords.
  //   - `liveLocationStatus`: `active` | `paused` | `ended` per session.
  //   - `liveLocationRemainingMs`: countdown for the sender's bubble.
  //   - `onStopLiveLocation`: tapped the in-bubble "Stop" button (sender
  //     side only — pass `undefined` for receiver bubbles).
  liveLocationLatest?: Record<string, { location: SharedLocation; ts: number } | undefined>;
  liveLocationStatus?: Record<string, 'active' | 'paused' | 'ended' | 'expired' | undefined>;
  liveLocationRemainingMs?: Record<string, number | undefined>;
  onStopLiveLocation?: (sessionId: string) => void;
  /** Group bubbles: the marker's sender — the live records are keyed
   *  `sender:sessionId` so one member can't drive another's share (#1300).
   *  1:1 bubbles omit it and read the owner-resolved `sessionId` key. */
  liveLocationSender?: string;
  // Location-card mini-map plumbing (#206). All optional — group bubbles
  // pass none, so their cards just centre on the shared point with no
  // me-dot / peer marker.
  myLat?: number | null; // my live latitude (for the blue "me" dot)
  myLon?: number | null; // my live longitude
  myAccuracyMetres?: number | null; // my GPS accuracy → blue halo radius
  myAvatarUri?: string | null; // my own profile picture → "me" dot avatar
  peerAvatarUri?: string | null; // the other party's profile picture URL
  onOpenMap?: () => void; // tap the mini-map → open the full-screen Map
  // Tap a GIF or image bubble → parent shows fullscreen modal. Optional —
  // when omitted the cards still render but tap is a no-op.
  onOpenGifFullscreen?: (url: string) => void;
  onOpenImageFullscreen?: (url: string) => void;
  // Pre-aggregated poll tally keyed by poll-message id. The parent runs
  // `aggregateVotes` over the conversation history once per messages
  // update; the bubble looks up its own row by `id`. When `undefined`,
  // poll bubbles still render but with zero counts (cold start).
  pollAggregates?: Map<string, PollTally>;
  // Tap an option row on a poll → parent sends the vote message.
  // Optional: omit on read-only contexts (none currently).
  onVotePoll?: (pollId: string, optionId: string) => void;
  // Tapping the "Toggle Secret Mode" button on the magic-trigger card
  // (when the message body is exactly "secretthreewords"). Parent
  // owns the secretMode setter + celebration overlay so a list of
  // cells doesn't each render their own confetti instance.
  onToggleSecretMode?: () => void;
  // Test-id prefix lets 1:1 and group bubbles coexist in the same Maestro
  // run with stable selectors. e.g. `conversation` → `conversation-pay-…`.
  testIdPrefix: string;
  // Per-relay delivery breakdown for a sent (fromMe) message (#856). Drives
  // the footer tick; absent on received bubbles.
  deliveryStatus?: DeliveryStatus;
  // Wire protocol (4 = NIP-04, 14/15 = NIP-17) for the message-info sheet.
  wireKind?: number;
  // Tapping a bubble (sent OR received) opens the message-info sheet. The
  // parent builds the MessageInfo from these fields; `resendText` is the raw
  // payload for the sheet's Re-publish (sent text only). (#856)
  onShowInfo?: (args: ShowMessageInfoArgs) => void;
  // Long-press handler (#205) — opens the parent's MessageActionsSheet for
  // per-message reactions + zap. Optional; when omitted the long-press is a
  // no-op rather than falling back to system text-select.
  onLongPress?: () => void;
  // NIP-25 reaction state for THIS message id, or undefined if the parent
  // hasn't fetched any reactions yet. Renders a compact pill row beneath the
  // bubble: e.g. "❤️ 2  🔥 1". Tapping a pill toggles the viewer's own
  // reaction. Pulled from the parent's `reactionsByTarget` map (#205).
  reactions?: MessageReactionState;
  // Tap handler for a reaction pill. Receives the emoji and (when the viewer
  // has already reacted) the existing reaction event id so the parent can
  // NIP-09 delete. Optional — when omitted the pills are display-only.
  onToggleReaction?: (emoji: string, existingReactionId: string | null) => void;
  // Marmot reply: the quoted parent shown above the text.
  quote?: MessageQuoteData;
  // Marmot edit: show an "Edited" mark in the footer.
  edited?: boolean;
  // Trust gate (#1338): true when the sender is me or someone I follow. Only
  // then do link previews, images and voice notes load without a tap — the
  // parent decides per SENDER (see utils/mediaTrust), never per chat.
  autoLoadMedia: boolean;
}

const MessageBubble: React.FC<Props> = ({
  id,
  fromMe,
  createdAt,
  content,
  senderName,
  sharedProfiles,
  isInvoicePaid,
  onPayInvoice,
  onPayLightningAddress,
  onOpenContact,
  onOpenLocation,
  liveLocationLatest,
  liveLocationStatus,
  liveLocationRemainingMs,
  onStopLiveLocation,
  liveLocationSender,
  myLat,
  myLon,
  myAccuracyMetres,
  myAvatarUri,
  peerAvatarUri,
  onOpenMap,
  onOpenGifFullscreen,
  onOpenImageFullscreen,
  pollAggregates,
  onVotePoll,
  onToggleSecretMode,
  testIdPrefix,
  deliveryStatus,
  wireKind,
  onShowInfo,
  onLongPress,
  reactions,
  onToggleReaction,
  quote,
  edited,
  autoLoadMedia,
}) => {
  const contact = content.kind === 'text' ? extractSharedContact(content.text) : null;
  const contactAvatarUri = useSharedContactAvatar(
    contact ? sharedProfiles?.[contact.pubkey]?.picture : undefined,
    autoLoadMedia,
  );
  const colors = useThemeColors();
  const cardWidth = useChatCardWidth();
  const styles = useMemo(() => createMessageBubbleStyles(colors, cardWidth), [colors, cardWidth]);
  const { t } = useLocale();
  const {
    uri: gifUri,
    loadAllowed: gifLoadAllowed,
    reveal: revealGif,
    safe: gifSafe,
  } = useGifMedia(id, content.kind === 'gif' ? content.url : null, autoLoadMedia);
  // Bubbles re-render on reactions / delivery ticks; bound the sender label
  // once per sender rather than on every pass (#1500 M4).
  const senderLabel = useMemo(
    () => (senderName ? sanitizeDisplayText(senderName, { maxLen: 64 }) : null),
    [senderName],
  );

  // Sender label (group bubbles, incoming) + a Marmot reply's quote: one header
  // slot every variant renders, so photo / GIF / invoice replies show it too.
  const quoteProps = { styles, fromMe, messageId: id, testIdPrefix };
  const QuoteStrip = quote ? <MessageQuote {...quoteProps} quote={quote} /> : null;
  const BubbleHeader =
    senderLabel || QuoteStrip ? (
      <>
        {senderLabel ? <Text style={styles.senderLabel}>{senderLabel}</Text> : null}
        {QuoteStrip}
      </>
    ) : null;

  const ReactionRow =
    reactions && Object.keys(reactions.byEmoji).length ? (
      <MessageReactionRow {...{ reactions, fromMe, styles, testIdPrefix, id, onToggleReaction }} />
    ) : null;

  // Wrap a variant's bubble row in a small column so the reaction row can sit
  // immediately under it without breaking the row's left/right alignment. Only
  // wraps when there are reactions to render — otherwise returns the bubble
  // unchanged so the render path is byte-identical to pre-#205.
  const wrapWithReactionRow = (bubble: React.ReactElement): React.ReactElement =>
    ReactionRow ? (
      <View>
        {bubble}
        {ReactionRow}
      </View>
    ) : (
      bubble
    );

  // Legacy NIP-04 (kind 4) received text retains its purple edge marker.
  // Outgoing messages share the selected bubble palette across protocols.
  const isNip04 = wireKind === 4;

  // Re-publish payload (#856): text or a GIF's URL; '' for cards, media and
  // replies (see resendPayloadFor).
  const resendPayload = resendPayloadFor(content, !!quote);

  // Opens the message-info sheet — for sent AND received bubbles (#856). The
  // bubble's `id` is prefixed (`dm-<eventId>`); strip it so the sheet shows the
  // bare event id. The rumor id (deliveryStatus.eventId) is preferred for sent.
  const openInfo = onShowInfo
    ? () =>
        onShowInfo({
          fromMe,
          eventId: deliveryStatus?.eventId ?? id.replace(/^dm-/, ''),
          wireKind,
          deliveryStatus,
          createdAt,
          ...resendPayload,
        })
    : undefined;

  // Shield-affordance tint: palette foreground on sent bubbles, supplementary
  // grey on a surface (received) one — readable on either background (#856).
  const infoTint = fromMe ? colors.outgoingBubble.foreground : colors.textSupplementary;

  // Reusable footer (time + delivery tick) shared by every bubble variant so a
  // sent GIF / image / voice note / location / invoice all show the tick, not
  // just plain text (#856). Each variant passes its own time style.
  const renderFooter = (timeStyle: object | (object | undefined)[], surface = false) => (
    <BubbleFooter
      styles={styles}
      messageId={id}
      fromMe={fromMe}
      createdAt={createdAt}
      timeStyle={timeStyle}
      deliveryStatus={deliveryStatus}
      onOpenInfo={openInfo}
      infoTint={surface ? colors.textSupplementary : infoTint}
      deliveryTint={surface ? colors.textSupplementary : undefined}
      edited={edited}
    />
  );

  if (content.kind === 'gif') {
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={
            gifSafe
              ? gifLoadAllowed
                ? () => gifUri && onOpenGifFullscreen?.(gifUri)
                : revealGif
              : undefined
          }
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.gifCard, fromMe ? styles.gifCardMe : styles.gifCardThem]}
          accessibilityLabel={
            !gifLoadAllowed && gifSafe
              ? t('messageBubble.loadImageA11y', { host: displayHost(content.url) })
              : fromMe
                ? t('messageBubble.gifSent')
                : t('messageBubble.gifReceived')
          }
          accessibilityRole={!gifLoadAllowed ? 'button' : 'imagebutton'}
          testID={`${testIdPrefix}-gif-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          {!gifSafe || !gifLoadAllowed ? (
            <TapToLoadMedia
              variant="image"
              url={content.url}
              fromMe={fromMe}
              testID={`${testIdPrefix}-gif-${gifSafe ? 'tap-to-load' : 'blocked'}-${id}`}
            />
          ) : gifUri ? (
            <ExpoImage
              source={{ uri: gifUri }}
              style={styles.gifImage}
              contentFit="cover"
              cachePolicy="memory-disk"
              transition={150}
              accessibilityIgnoresInvertColors
            />
          ) : null}
          {renderFooter([styles.gifTime, fromMe && styles.gifTimeMe])}
        </TouchableOpacity>
      </View>,
    );
  }

  if (content.kind === 'liveLocationMarker') {
    const { marker } = content;
    // No separate card for the end marker — it would duplicate the start card (which flips to "ended"); its coords are folded into liveLocationLatest so the one card shows the last known location.
    if (marker.phase === 'end') return null;
    // The receiver's running view of where the sender is right now —
    // ConversationScreen feeds this from its kind-20069 subscription.
    // Falls back to the marker's own coordinates so the bubble always
    // renders a map even before the first ping has landed.
    const liveRecordKey = liveLocationSender
      ? liveKey(liveLocationSender, marker.sessionId)
      : marker.sessionId;
    const latest = liveLocationLatest?.[liveRecordKey];
    // May be null on a coordless `end` marker (sender stopped with no fix).
    const displayLocation: SharedLocation | null = latest?.location ?? marker.location;
    // Map centre: my own live position on my outgoing share, the peer's
    // latest position on an incoming one. Falls back to the marker coords
    // when my live fix isn't wired / hasn't landed yet.
    const haveMine = typeof myLat === 'number' && typeof myLon === 'number';
    const centreLat = fromMe && haveMine ? myLat : (displayLocation?.lat ?? null);
    const centreLon = fromMe && haveMine ? myLon : (displayLocation?.lon ?? null);
    // My blue dot shows on incoming cards (where am I vs them) and on my
    // own live share. Suppressed when I have no fix.
    const showMyDot = haveMine;
    // Peer avatar marker only on incoming cards, at their location. The
    // `peerAvatarUri !== undefined` guard scopes this to the 1:1 path —
    // group bubbles pass no avatar plumbing, so their card just centres
    // on the point with no peer chip (#206 group follow-up).
    const peerMarker =
      !fromMe && displayLocation && peerAvatarUri !== undefined
        ? { lat: displayLocation.lat, lon: displayLocation.lon, avatarUri: peerAvatarUri ?? null }
        : null;
    // Only `start` markers reach here (end markers return null above), so the wall-clock default is 'active' unless the context says otherwise.
    const status = liveLocationStatus?.[liveRecordKey] ?? 'active';
    const remaining = liveLocationRemainingMs?.[liveRecordKey] ?? null;
    // Sender bubble while the share is still active gets a Stop button.
    // Receiver bubbles never see one (no `onStopLiveLocation` plumbed).
    const showStop = fromMe && status === 'active' && !!onStopLiveLocation;
    const {
      title: titleText,
      subtitle: subtitleText,
      remaining: remainingLabel,
    } = liveLocationBubbleText({ status, fromMe, latest, remainingMs: remaining, now: Date.now() });
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => displayLocation && onOpenLocation(displayLocation)}
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.locationCard, fromMe ? styles.locationCardMe : styles.locationCardThem]}
          accessibilityLabel={
            fromMe
              ? t('messageBubble.sharingLiveLocationA11y', {
                  remaining: remainingLabel ?? t('messageBubble.noTimeRemaining'),
                })
              : t('messageBubble.receivingLiveLocationA11y', {
                  status: subtitleText ?? t('messageBubble.waiting'),
                })
          }
          testID={`${testIdPrefix}-live-location-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          {centreLat !== null && centreLon !== null ? (
            <View style={styles.locationMap}>
              <LibreMiniMap
                lat={centreLat}
                lon={centreLon}
                merchants={EMPTY_MERCHANTS}
                caches={EMPTY_CACHES}
                events={EMPTY_EVENTS}
                fill
                defaultZoom={15}
                userLat={showMyDot ? (myLat ?? null) : null}
                userLon={showMyDot ? (myLon ?? null) : null}
                userAccuracyMetres={showMyDot ? (myAccuracyMetres ?? null) : null}
                userAvatarUri={showMyDot ? (myAvatarUri ?? null) : null}
                profileMarker={peerMarker}
                onTapMap={onOpenMap}
              />
            </View>
          ) : null}
          <View style={styles.locationBody}>
            <View style={styles.locationLabelRow}>
              <Radio
                size={14}
                color={fromMe ? colors.outgoingBubble.foreground : colors.textSupplementary}
              />
              <Text style={[styles.locationLabel, fromMe && styles.locationLabelMe]}>
                {titleText}
              </Text>
            </View>
            {displayLocation ? (
              <Text style={[styles.locationCoords, fromMe && styles.locationCoordsMe]}>
                {formatCoordsForDisplay(displayLocation)}
              </Text>
            ) : null}
            {subtitleText ? (
              <Text style={[styles.locationAccuracy, fromMe && styles.locationAccuracyMe]}>
                {subtitleText}
              </Text>
            ) : null}
            {remainingLabel ? (
              <Text style={[styles.locationAccuracy, fromMe && styles.locationAccuracyMe]}>
                {remainingLabel}
              </Text>
            ) : null}
            {showStop ? (
              <TouchableOpacity
                style={styles.liveStopButton}
                onPress={() => onStopLiveLocation?.(marker.sessionId)}
                accessibilityLabel={t('messageBubble.stopSharingLiveLocation')}
                testID={`${testIdPrefix}-live-location-stop-${id}`}
              >
                <Text style={[styles.invoicePayText, styles.bubbleTextMe]}>
                  {t('messageBubble.stopSharing')}
                </Text>
              </TouchableOpacity>
            ) : null}
            {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
          </View>
        </TouchableOpacity>
      </View>,
    );
  }

  if (content.kind === 'location') {
    return wrapWithReactionRow(
      <LocationBubble
        location={content.location}
        fromMe={fromMe}
        id={id}
        testIdPrefix={testIdPrefix}
        styles={styles}
        senderLabel={BubbleHeader}
        footer={renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        myLat={myLat}
        myLon={myLon}
        myAccuracyMetres={myAccuracyMetres}
        myAvatarUri={myAvatarUri}
        peerAvatarUri={peerAvatarUri}
        onOpenLocation={onOpenLocation}
        onOpenMap={onOpenMap}
        onLongPress={onLongPress}
      />,
    );
  }

  // Generic, future-proof fallback for an inner event kind the app doesn't
  // render (#market follow-up). Instead of a blank bubble, show a small muted/
  // italic placeholder naming the raw Nostr kind. Side-aligned like a normal
  // bubble so the sender context (fromMe) is preserved, but visually subdued so
  // it reads as "nothing to do here" rather than a real message.
  if (content.kind === 'unsupported') {
    return (
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <View
          style={[styles.bubble, styles.unsupportedBubble]}
          accessibilityLabel={t('messageBubble.unsupportedSender', {
            name: senderName ?? t('messageBubble.unknownSender'),
          })}
          testID={`${testIdPrefix}-unsupported-${id}`}
        >
          <View testID={`chat-unsupported-bubble-${id.replace(/^dm-/, '').slice(0, 8)}`}>
            <Text style={styles.unsupportedText}>
              {t('messageBubble.unsupportedSender', {
                name: senderName ?? t('messageBubble.unknownSender'),
              })}
            </Text>
            <Text style={styles.bubbleTime}>
              {t('messageBubble.unsupportedKind', { kind: content.rawKind })}
            </Text>
          </View>
          {renderFooter([styles.bubbleTime])}
        </View>
      </View>
    );
  }

  if (content.kind === 'pollVote') {
    // Vote events are an internal protocol message — they're rolled up into
    // the referenced poll's tally by the parent's `tallyPoll` call, so the
    // in-app conversation never shows them as bubbles. (Structured kind-1018
    // votes are dropped even earlier, at the item-build layer.)
    return null;
  }

  if (content.kind === 'poll') {
    // Vote target / tally key: the structured poll rumor id when present
    // (set by the 1:1 item mapping), else the message id (legacy text polls +
    // groups, whose votes were keyed by the message id in the text MVP).
    const pollKey = content.pollId ?? id;
    return (
      <PollBubble
        poll={content.poll}
        agg={pollAggregates?.get(pollKey)}
        fromMe={fromMe}
        id={pollKey}
        createdAt={createdAt}
        onVotePoll={onVotePoll}
        testIdPrefix={testIdPrefix}
        styles={styles}
        colors={colors}
        senderLabel={BubbleHeader}
      />
    );
  }

  if (content.kind === 'file')
    return wrapWithReactionRow(
      <MessageFileBubble
        id={id}
        file={content.file}
        autoLoad={autoLoadMedia}
        fromMe={fromMe}
        header={BubbleHeader}
        onLongPress={onLongPress}
        footer={renderFooter([styles.bubbleTime], true)}
      />,
    );

  const text = content.text;

  // Image (#688) — encrypted NIP-17 kind-15 (fetch ciphertext → decrypt →
  // display) OR a plain image URL (legacy / other clients → display directly).
  // Both render through the same bubble; DecryptedImage owns the decrypt path.
  const image = parseImageMessage(text);
  if (image) {
    return wrapWithReactionRow(
      <MessageImageBubble
        // Remount on an edited URL so neither consent nor the resolved
        // display URI carries over to the new image (#1338).
        key={image.url}
        styles={styles}
        image={image}
        messageId={id}
        testIdPrefix={testIdPrefix}
        fromMe={fromMe}
        autoLoad={autoLoadMedia}
        senderLabel={BubbleHeader}
        onOpenImageFullscreen={onOpenImageFullscreen}
        onLongPress={onLongPress}
        testID={`${testIdPrefix}-image-${id}`}
        footer={renderFooter([styles.imageBubbleTime, fromMe && styles.imageBubbleTimeMe])}
      />,
    );
  }

  // Voice note (#235) — inline player card (play/pause + waveform), shown
  // for both sender and receiver. Detected before the text/link fallback
  // so the Blossom `.mp4` URL renders as a player, not a bare link.
  const voice = parseVoiceNote(text);
  if (voice) {
    return wrapWithReactionRow(
      <VoiceNotePlayer
        url={voice.url}
        encrypted={voice.encrypted}
        sha256={voice.sha256}
        keyHex={voice.keyHex}
        nonceHex={voice.nonceHex}
        marmot={voice.marmot}
        mime={voice.mime}
        size={voice.size}
        fromMe={fromMe}
        autoLoad={autoLoadMedia}
        createdAt={createdAt}
        senderName={senderName}
        header={QuoteStrip}
        onLongPress={onLongPress}
        testID={`${testIdPrefix}-voice-${id}`}
        footer={
          fromMe && deliveryStatus
            ? renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])
            : undefined
        }
      />,
    );
  }

  // "secretthreewords" magic trigger — render an inline card with a
  // Toggle Secret Mode button. Only LP renders the special UI; on
  // other Nostr clients the recipient sees the plain word and won't
  // know what it does. We render the card on BOTH sides (sender +
  // receiver) so the sender sees a confirmation that the trigger
  // landed, but only the receiver can usefully tap the button —
  // sender's button is harmless (toggles their own mode).
  if (isSecretModeTrigger(text)) {
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.invoiceCard, fromMe ? styles.invoiceCardMe : styles.invoiceCardThem]}
          testID={`${testIdPrefix}-secret-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          <Text style={[styles.invoiceLabel, fromMe && styles.invoiceLabelMe]}>
            {t('messageBubble.secretMode')}
          </Text>
          <Text style={[styles.invoiceMemo, fromMe && styles.invoiceMemoMe]}>
            {fromMe
              ? t('messageBubble.secretModeSenderMemo')
              : t('messageBubble.secretModeReceiverMemo')}
          </Text>
          {!fromMe && onToggleSecretMode && (
            <TouchableOpacity
              style={styles.invoicePayButton}
              onPress={onToggleSecretMode}
              accessibilityRole="button"
              accessibilityLabel={t('messageBubble.toggleSecretMode')}
              testID={`${testIdPrefix}-secret-mode-toggle-${id}`}
            >
              <Text style={styles.invoicePayText}>{t('messageBubble.toggleSecretMode')}</Text>
            </TouchableOpacity>
          )}
          {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        </Pressable>
      </View>,
    );
  }

  const bitcoinUri = extractBitcoinUri(text);
  if (bitcoinUri) {
    // On-chain BIP-21 share. Tap → parent's onPayInvoice (which opens
    // SendSheet pre-filled — SendSheet already parses `bitcoin:` URIs
    // and pre-fills both address and BIP-21 amount, so we hand the raw
    // URI straight through). Receiver-only Pay button — outgoing
    // bubbles are informational.
    const shortAddr =
      bitcoinUri.address.length > 16
        ? `${bitcoinUri.address.slice(0, 8)}…${bitcoinUri.address.slice(-6)}`
        : bitcoinUri.address;
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.invoiceCard, fromMe ? styles.invoiceCardMe : styles.invoiceCardThem]}
          testID={`${testIdPrefix}-bitcoin-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          <Text style={[styles.invoiceLabel, fromMe && styles.invoiceLabelMe]}>
            {fromMe ? t('messageBubble.onchainAddressSent') : t('messageBubble.onchainAddress')}
          </Text>
          {bitcoinUri.amountSats !== null ? (
            <Text style={[styles.invoiceAmount, fromMe && styles.invoiceAmountMe]}>
              <MessageSatsAmount amountSats={bitcoinUri.amountSats} />
            </Text>
          ) : null}
          <Text style={[styles.invoiceMemo, fromMe && styles.invoiceMemoMe]} numberOfLines={1}>
            {shortAddr}
          </Text>
          {fromMe ? null : (
            <TouchableOpacity
              style={styles.invoicePayButton}
              onPress={() => onPayInvoice(bitcoinUri.raw)}
              accessibilityRole="link"
              accessibilityLabel={t('messageBubble.payOnchainAddress')}
              testID={`${testIdPrefix}-bitcoin-pay-${id}`}
            >
              <Zap size={16} color={colors.white} fill={colors.white} />
              <Text style={styles.invoicePayText}>{t('messageBubble.pay')}</Text>
            </TouchableOpacity>
          )}
          {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        </Pressable>
      </View>,
    );
  }

  const invoice = extractInvoice(text);
  if (invoice) {
    const expired = invoice.expiresAt !== null && invoice.expiresAt * 1000 < Date.now();
    const paid =
      invoice.paymentHash !== null &&
      isInvoicePaid !== undefined &&
      isInvoicePaid(invoice.paymentHash, fromMe);
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.invoiceCard, fromMe ? styles.invoiceCardMe : styles.invoiceCardThem]}
          testID={`${testIdPrefix}-invoice-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          <Text style={[styles.invoiceLabel, fromMe && styles.invoiceLabelMe]}>
            {fromMe ? t('messageBubble.invoiceSent') : t('messageBubble.invoiceReceived')}
          </Text>
          <Text style={[styles.invoiceAmount, fromMe && styles.invoiceAmountMe]}>
            <MessageSatsAmount amountSats={invoice.amountSats} />
          </Text>
          {invoice.description ? (
            <Text style={[styles.invoiceMemo, fromMe && styles.invoiceMemoMe]} numberOfLines={2}>
              {invoice.description}
            </Text>
          ) : null}
          <View style={styles.invoiceTagRow}>
            {paid ? (
              <View
                style={[styles.invoiceTag, styles.invoiceTagPaid]}
                accessibilityLabel={t('messageBubble.invoicePaid')}
                testID={`${testIdPrefix}-paid-badge-${id}`}
              >
                <Text style={styles.invoiceTagPaidText}>{t('messageBubble.paid')}</Text>
              </View>
            ) : expired ? (
              <View style={[styles.invoiceTag, styles.invoiceTagExpired]}>
                <Text style={styles.invoiceTagExpiredText}>{t('messageBubble.expired')}</Text>
              </View>
            ) : fromMe ? (
              <View style={[styles.invoiceTag, styles.invoiceTagUnpaid]}>
                <Text style={styles.invoiceTagUnpaidText}>{t('messageBubble.unpaid')}</Text>
              </View>
            ) : null}
            {!paid && !expired && invoice.expiresAt !== null ? (
              <Text style={[styles.invoiceExpiry, fromMe && styles.invoiceExpiryMe]}>
                {t('messageBubble.expiresIn', {
                  time: formatRelativeFuture(invoice.expiresAt * 1000),
                })}
              </Text>
            ) : null}
          </View>
          {/* Received, live, unpaid → Pay + QR + copy (#948), matching the
              marketplace order card. Sent/paid/expired shows its pill instead. */}
          {fromMe || paid || expired ? null : (
            <MessageInvoiceActions
              bolt11={invoice.raw}
              onPayInvoice={onPayInvoice}
              testIdPrefix={testIdPrefix}
              id={id}
            />
          )}
          {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        </Pressable>
      </View>,
    );
  }

  // A Market listing shared as `nostr:naddr1…` (#1541) renders as its product card.
  const sharedListing = extractSharedListing(text);
  if (sharedListing) {
    const parts = sharedListingParts(text);
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.contactCard, fromMe ? styles.contactCardMe : styles.contactCardThem]}
          testID={`${testIdPrefix}-listing-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          <Text style={[styles.contactLabel, fromMe && styles.contactLabelMe]}>
            {t('market.share.sharedItem')}
          </Text>
          {parts.map((part, index) =>
            typeof part === 'string' ? (
              <LinkifiedText
                key={index}
                text={part}
                fromMe={fromMe}
                styles={styles}
                messageId={`${id}-${index}`}
                testIdPrefix={testIdPrefix}
              />
            ) : (
              <MessageSharedListing
                key={index}
                token={part}
                title={
                  typeof parts[index - 1] === 'string'
                    ? (parts[index - 1] as string).split('\n').at(-1)
                    : undefined
                }
                autoLoadMedia={autoLoadMedia}
              />
            ),
          )}
          {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        </Pressable>
      </View>,
    );
  }

  const sharedContact = extractSharedContact(text);
  if (sharedContact) {
    const loaded = sharedProfiles ? sharedContact.pubkey in sharedProfiles : false;
    const prof = sharedProfiles?.[sharedContact.pubkey] ?? null;
    const displayName = prof?.displayName || prof?.name || npubEncode(sharedContact.pubkey);
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => onOpenContact(sharedContact.pubkey, prof)}
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.contactCard, fromMe ? styles.contactCardMe : styles.contactCardThem]}
          accessibilityLabel={t('messageBubble.sharedContactA11y', { name: displayName })}
          testID={`${testIdPrefix}-contact-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          <Text style={[styles.contactLabel, fromMe && styles.contactLabelMe]}>
            {fromMe ? t('messageBubble.contactShared') : t('messageBubble.contact')}
          </Text>
          <View style={styles.contactBodyRow}>
            {/* Always render the silhouette as the base layer so it shows
                whether prof.picture is missing OR the Image fails to load
                (broken URL, offline, etc). When prof.picture is set, the
                Image is z-stacked on top via absoluteFillObject and covers
                the silhouette once it loads. textBody (dark) is used for
                the icon to guarantee contrast against the light avatar BG. */}
            <View style={[styles.contactAvatar, styles.contactAvatarFallback]}>
              <UserRound size={26} color={colors.textBody} strokeWidth={1.75} />
              {/* The shared profile's picture URL is chosen by whoever published
                  it, so it only loads for trusted senders and public hosts
                  (#1338); otherwise the silhouette stays. */}
              {contactAvatarUri ? (
                <ExpoImage
                  source={{ uri: contactAvatarUri }}
                  style={[StyleSheet.absoluteFillObject, { borderRadius: 22 }]}
                  cachePolicy="memory-disk"
                  recyclingKey={contactAvatarUri}
                  autoplay={false}
                />
              ) : null}
            </View>
            <View style={styles.contactInfo}>
              <Text style={[styles.contactName, fromMe && styles.contactNameMe]} numberOfLines={1}>
                {loaded ? displayName : t('messageBubble.loading')}
              </Text>
              {loaded && !prof ? (
                <Text style={[styles.contactLn, fromMe && styles.contactLnMe]}>
                  {t('contactProfileBody.viewProfile')}
                </Text>
              ) : prof?.lud16 ? (
                <Text style={[styles.contactLn, fromMe && styles.contactLnMe]} numberOfLines={1}>
                  {prof.lud16}
                </Text>
              ) : prof?.nip05 ? (
                <Text style={[styles.contactLn, fromMe && styles.contactLnMe]} numberOfLines={1}>
                  {prof.nip05}
                </Text>
              ) : null}
            </View>
          </View>
          {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        </TouchableOpacity>
      </View>,
    );
  }

  const lnAddress = extractLightningAddress(text);
  if (lnAddress) {
    return wrapWithReactionRow(
      <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
        <Pressable
          onLongPress={onLongPress}
          delayLongPress={350}
          style={[styles.invoiceCard, fromMe ? styles.invoiceCardMe : styles.invoiceCardThem]}
          testID={`${testIdPrefix}-lnaddr-${id}`}
        >
          <OutgoingBubbleBackground fromMe={fromMe} />
          {BubbleHeader}
          <Text style={[styles.invoiceLabel, fromMe && styles.invoiceLabelMe]}>
            {fromMe ? t('messageBubble.addressSent') : t('messageBubble.lightningAddress')}
          </Text>
          <Text style={[styles.invoiceMemo, fromMe && styles.invoiceMemoMe]} numberOfLines={1}>
            {lnAddress}
          </Text>
          {fromMe ? null : (
            <TouchableOpacity
              style={styles.invoicePayButton}
              onPress={() => onPayLightningAddress(lnAddress)}
              accessibilityLabel={t('messageBubble.payLightningAddress')}
              testID={`${testIdPrefix}-pay-${id}`}
            >
              <Zap size={16} color={colors.white} fill={colors.white} />
              <Text style={styles.invoicePayText}>{t('messageBubble.pay')}</Text>
            </TouchableOpacity>
          )}
          {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
        </Pressable>
      </View>,
    );
  }

  // Plain text fallback — no rich content detected. Cap link previews
  // at 1 per message: first previewable (public, non-blocklisted) URL wins.
  // All URLs in the body are rendered as tappable link spans below.
  const previewUrl = firstPreviewableUrl(text);

  return wrapWithReactionRow(
    <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={350}
        style={[
          styles.bubble,
          fromMe ? styles.bubbleMe : styles.bubbleThem,
          // Legacy received DMs retain their purple protocol marker.
          !fromMe && isNip04 && styles.bubbleThemNip04,
        ]}
        testID={isNip04 ? `${testIdPrefix}-nip04-bubble-${id}` : `${testIdPrefix}-text-${id}`}
      >
        <OutgoingBubbleBackground fromMe={fromMe} />
        {BubbleHeader}
        <LinkifiedText
          text={text}
          fromMe={fromMe}
          styles={styles}
          messageId={id}
          testIdPrefix={testIdPrefix}
        />
        {previewUrl ? (
          <MessageLinkPreview
            url={previewUrl}
            eventId={id}
            fromMe={fromMe}
            autoLoad={autoLoadMedia}
          />
        ) : null}
        {renderFooter([styles.bubbleTime, fromMe && styles.bubbleTimeMe])}
      </Pressable>
    </View>,
  );
};

export default MessageBubble;
