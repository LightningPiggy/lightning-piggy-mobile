import { useChatCardWidth } from '../styles/chatCardWidth';
import { preferredConversationParams } from '../services/preferredDmProtocol';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import BrandedSpinner from '../components/BrandedSpinner';
import { usePeerContact } from '../hooks/usePeerContact';
import { useDmChatTools } from '../hooks/useDmChatTools';
import { useChatLocalHistory } from '../hooks/useChatLocalHistory';
import { useChatKeyboardLift } from '../hooks/useChatKeyboardLift';
import { ChatToolsProvider } from '../components/ChatToolsProvider';
import ChatSearchHeader from '../components/ChatSearchHeader';
import { useLiveMessageIndicator } from '../hooks/useLiveMessageIndicator';
import NewMessagesPill from '../components/NewMessagesPill';
import FullscreenGifModal from '../components/FullscreenGifModal';
import ChatJumpButtons from '../components/ChatJumpButtons';
import UnreadDivider from '../components/UnreadDivider';
import {
  conversationItemKey,
  useConversationReadPosition,
} from '../hooks/useConversationReadPosition';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConversationProtocol } from '../hooks/useConversationProtocol';
import ConversationHeader from '../components/ConversationHeader';
import DmMembersSheet from '../components/DmMembersSheet';
import { useDmDevices } from '../hooks/useDmDevices';
import { View, Text, Pressable, FlatList, BackHandler, Linking, StyleSheet } from 'react-native';
import { Alert } from '../components/BrandedAlert';
import { KeyboardController } from 'react-native-keyboard-controller';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { useDmCatchUpOnOpen } from '../hooks/useDmCatchUpOnOpen';
import { useWallet } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import SendSheet from '../components/SendSheet';
import AttachPanel from '../components/AttachPanel';
import ConversationComposer from '../components/ConversationComposer';
import GifPickerSheet from '../components/GifPickerSheet';
import PollComposerSheet from '../components/PollComposerSheet';
import ReceiveSheet from '../components/ReceiveSheet';
import VoiceRecordingSheet from '../components/VoiceRecordingSheet';
import ConversationMessageRow from '../components/ConversationMessageRow';
import { useFollowedPubkeys } from '../hooks/useFollowedPubkeys';
import { canAutoLoadMedia } from '../utils/mediaTrust';
import NwcWalletShareSheet from '../components/NwcWalletShareSheet';
import MessageActionsSheet from '../components/MessageActionsSheet';
import SecretModeCelebration from '../components/SecretModeCelebration';
import { useGroups } from '../contexts/GroupsContext';
import TransactionDetailSheet, {
  TransactionDetailData,
} from '../components/TransactionDetailSheet';
import FriendPickerSheet from '../components/FriendPickerSheet';
import ContactProfileSheet from '../components/ContactProfileSheet';
import type { ContactProfileBodyData } from '../components/ContactProfileBody';
import { buildOsmViewUrl, SharedLocation } from '../services/locationService';
import { useLiveLocation } from '../contexts/LiveLocationContext';
import { useUserLocation } from '../contexts/UserLocationContext';
import LiveLocationDurationPicker from '../components/LiveLocationDurationPicker';
import { isConfigured as isGifConfigured } from '../services/giphyService';
import type { NostrProfile } from '../types/nostr';
import type { RootStackParamList } from '../navigation/types';
import { useNwcShareActions } from '../hooks/useNwcShareActions';
import { useSharedContactProfiles } from '../hooks/useSharedContactProfiles';
import { useConversationPolls } from '../hooks/useConversationPolls';
import { usePaidInvoiceTracker } from '../hooks/usePaidInvoiceTracker';
import { useConversationComposerActions } from '../hooks/useConversationComposerActions';
import { useMessageInfoSheet } from '../hooks/useMessageInfoSheet';
import { useConversationTimeline } from '../hooks/useConversationTimeline';
import { useConversationLiveLocation } from '../hooks/useConversationLiveLocation';
import type { ConversationMessageInput, Item } from '../utils/conversationItems';
import { useMessageActionsMenu } from '../hooks/useMessageActionsMenu';
import { useStartLiveLocationShare } from '../hooks/useStartLiveLocationShare';
import { useConversationReactions } from '../hooks/useConversationReactions';
import { useReactionBackend } from '../hooks/useReactionBackend';
import { useConversationLoader } from '../hooks/useConversationLoader';
import DeliveryDetailSheet from '../components/DeliveryDetailSheet';
import { createConversationScreenStyles } from '../styles/ConversationScreen.styles';
import { useTypingIndicator } from '../hooks/useTypingIndicator';

type ConversationRoute = RouteProp<RootStackParamList, 'Conversation'>;
// A row's Marmot event id: own sends keep a `local-` row id but carry it as rumorId.
const marmotIdOf = (m: ConversationMessageInput) => m.rumorId ?? m.id;
type ConversationNavigation = NativeStackNavigationProp<RootStackParamList, 'Conversation'>;

const ConversationScreen: React.FC = () => {
  const colors = useThemeColors();
  const t = useTranslation();
  const cardWidth = useChatCardWidth();
  const styles = useMemo(
    () => createConversationScreenStyles(colors, cardWidth),
    [colors, cardWidth],
  );
  const navigation = useNavigation<ConversationNavigation>();
  const route = useRoute<ConversationRoute>();
  const insets = useSafeAreaInsets();
  const animatedListLiftStyle = useChatKeyboardLift();
  const { pubkey, name, picture, lightningAddress } = route.params;
  const protocol = useConversationProtocol(route.params.protocol);

  const {
    isLoggedIn,
    fetchConversation,
    sendDirectMessage,
    sendDirectRumor,
    appendLocalDmMessage,
    loadInitialConversation,
    persistDeliveryStatuses,
    signerType,
    pubkey: myPubkey,
    relays,
    profile,
    publishReaction,
    deleteReaction,
    fetchReactionsForMessages,
    fetchReactionDeletionsForReactions,
  } = useNostr();
  // Trust gate (#1338): the peer's media auto-loads only if I follow them.
  const followed = useFollowedPubkeys();
  const peerMediaTrusted = canAutoLoadMedia(false, pubkey, followed);
  // A notification or cold start can open this chat without the Messages tab:
  // arm the live sub and catch up on messages that arrived meanwhile (#1325).
  useDmCatchUpOnOpen(isLoggedIn);
  const { wallets, addNwcWallet } = useWallet();
  const { stopShare } = useLiveLocation();

  // The loader owns live reads, refreshes, and the tapped message’s history window.
  const {
    messages: rawMessages,
    setMessages,
    loading,
    refreshing,
    handleRefresh,
  } = useConversationLoader({
    notification: { owner: myPubkey, messageId: route.params.jumpToMessage },
    protocol,
    pubkey,
    isLoggedIn,
    fetchConversation,
    loadInitialConversation,
    persistDeliveryStatuses,
  });
  const { messages, clear, clearBoundary } = useChatLocalHistory(
    myPubkey,
    `${protocol}:${pubkey}`,
    rawMessages,
  );
  const [draft, setDraft] = useState('');
  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  const [invoiceToPay, setInvoiceToPay] = useState<string | null>(null);
  const [detailTx, setDetailTx] = useState<TransactionDetailData | null>(null);
  // Profiles resolved from `nostr:` contact references the other party has
  // shared in this conversation — see useSharedContactProfiles. Keyed by hex
  // pubkey; a `null` value means the kind-0 lookup ran and came back empty.
  const sharedProfiles = useSharedContactProfiles(messages, useNostrContacts().contacts);
  const [attachPanelOpen, setAttachPanelOpen] = useState(false);
  // Secret Mode chat-trigger card overlay state — driven by
  // MessageBubble's "secretthreewords" magic message. Owned here so
  // the celebration confetti renders once over the conversation, not
  // per bubble cell.
  const { secretMode, setSecretMode } = useGroups();
  const [secretCelebrationVisible, setSecretCelebrationVisible] = useState(false);
  const [secretPendingEnabled, setSecretPendingEnabled] = useState(false);
  const handleToggleSecretMode = useCallback(() => {
    const next = !secretMode;
    setSecretMode(next);
    setSecretPendingEnabled(next);
    setSecretCelebrationVisible(true);
  }, [secretMode, setSecretMode]);
  // Memoised here (not inline at the JSX site) so the FlatList's
  // `contentContainerStyle` reference is stable across keystrokes —
  // every render of ConversationScreen would otherwise re-create the
  // array + inner object literal, forcing the FlatList to re-evaluate
  // its content container layout in a hot path.
  const listContentStyle = useMemo(
    () => [styles.listContent, { paddingTop: attachPanelOpen ? 16 : 8 }],
    [styles.listContent, attachPanelOpen],
  );

  // Inline attach panel sits ABOVE the text input inside the same
  // KeyboardStickyView. Opening dismisses the IME so we never have to
  // stack panel + composer + keyboard. Closing happens on input focus
  // (so the keyboard naturally takes back over) or hardware back.
  // No height guessing — the 4-col grid is intrinsic-sized.
  const openAttachPanel = useCallback(() => {
    setAttachPanelOpen(true);
    KeyboardController.dismiss();
  }, []);

  const closeAttachPanel = useCallback(() => {
    setAttachPanelOpen(false);
  }, []);

  // Android hardware-back: when the attach panel is open, swallow the
  // back press and close the panel instead of letting it bubble up to
  // the navigator (which would exit the conversation entirely).
  useEffect(() => {
    if (!attachPanelOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      closeAttachPanel();
      return true;
    });
    return () => sub.remove();
  }, [attachPanelOpen, closeAttachPanel]);
  const [invoiceSheetOpen, setInvoiceSheetOpen] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [pollComposerOpen, setPollComposerOpen] = useState(false);
  const [fullscreenGifUrl, setFullscreenGifUrl] = useState<string | null>(null);
  // Live-location chooser sheet (Snapshot vs Share live for…).
  const [liveLocationPickerOpen, setLiveLocationPickerOpen] = useState(false);
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  const listRef = useRef<FlatList<Item>>(null);

  // A person's devices in a Marmot 1:1 (#1267): by-line, sheet, notices, info rows.
  const dmDevices = useDmDevices({ peer: pubkey, peerName: name, protocol, myPubkey });
  const items = useConversationTimeline(
    messages,
    wallets,
    myPubkey,
    pubkey,
    protocol,
    dmDevices.noticeItems,
    clearBoundary,
  );

  // Poll aggregation + send/vote for this 1:1 thread (#203). Extracted to a
  // hook so the screen stays under the #703 size cap — see useConversationPolls.
  const { pollAggregates, handleSendPoll, handleVotePoll } = useConversationPolls({
    messages,
    myPubkey,
    pubkey,
    sendDirectMessage,
    protocol,
    sendDirectRumor,
    appendLocalDmMessage,
    setMessages,
  });

  const liveEntries = useMemo(
    () =>
      items.flatMap((item) =>
        item.kind === 'dayHeader' ? [] : [{ id: item.id, createdAt: item.createdAt }],
      ),
    [items],
  );
  const live = useLiveMessageIndicator({
    scope: `${myPubkey}:${route.params.pubkey}`,
    entries: liveEntries,
    loading,
    scrollToLatest: (animated) => listRef.current?.scrollToOffset({ offset: 0, animated }),
  });

  // Read position (#1295): open at the first unread under an "Unread
  // messages" divider; the jump-to-latest arrow carries the unread count.
  const read = useConversationReadPosition({
    listRef,
    items,
    owner: myPubkey,
    peer: pubkey,
    loading,
    leaveEdge: live.leaveEdge,
  });

  const { isInvoicePaid } = usePaidInvoiceTracker(messages);

  // Contact preview sheet — peek a counterparty without leaving the
  // conversation. Tapping "View full profile" inside the sheet drills
  // into the ContactProfile route. Shared across header avatar tap,
  // shared-contact-card tap, and tx-detail counterparty tap.
  const [sheetContact, setSheetContact] = useState<ContactProfileBodyData | null>(null);
  const [profileSheetVisible, setProfileSheetVisible] = useState(false);
  const presentContactSheet = useCallback((contact: ContactProfileBodyData) => {
    setSheetContact(contact);
    setProfileSheetVisible(true);
  }, []);
  const handleViewFullProfile = useCallback(() => {
    if (!sheetContact) return;
    setProfileSheetVisible(false);
    navigation.navigate('ContactProfile', { contact: sheetContact });
  }, [sheetContact, navigation]);

  const openSharedContact = useCallback(
    (pk: string, profile: NostrProfile | null) => {
      const name = profile?.displayName || profile?.name || `${pk.slice(0, 8)}…`;
      presentContactSheet({
        pubkey: pk,
        name,
        picture: profile?.picture ?? null,
        banner: profile?.banner ?? null,
        nip05: profile?.nip05 ?? null,
        lightningAddress: profile?.lud16 ?? null,
        source: 'nostr',
      });
    },
    [presentContactSheet],
  );

  // The peer can't be reached over Marmot and the user chose to send over
  // NIP-17: move the thread there (same in-place switch as the protocol picker).
  const handleMarmotFallback = useCallback(() => {
    navigation.setParams({ protocol: 'nip17' });
  }, [navigation]);

  // Append an optimistic local- message to BOTH React state (instant
  // paint) AND the per-conversation cache on disk (survives back-then-
  // reopen before the NIP-17 self-wrap echo arrives). The merge-side
  // dedup in mergeConversationMessages drops this local- row when the
  // real wrap echoes back from the relay.
  const {
    sending,
    uploadingImage,
    sharingLocation,
    uploadingVoice,
    appendOptimisticLocal,
    resendText,
    handleSend,
    handleShareLocation,
    handlePickAndSendImage,
    handlePickAndSendFile,
    handleTakeAndSendPhoto,
    handleShareContactPicked,
    handleSendGif,
    handleSendVoiceNote,
    shareNwcWallet,
    offerNip17ForText,
  } = useConversationComposerActions({
    protocol,
    pubkey,
    name,
    draft,
    setDraft,
    setMessages,
    setAttachPanelOpen,
    setContactPickerOpen,
    setGifPickerOpen,
    setVoiceSheetOpen,
    onMarmotFallback: handleMarmotFallback,
  });

  // Tap a bubble → message-info sheet (#856), for sent + received. Logic lives
  // in useMessageInfoSheet to keep the screen under the size cap. Declared
  // after the composer hook because it needs its `resendText` for Re-publish.
  const {
    info: messageSheetInfo,
    sender: messageSheetSender,
    sentAt: messageSheetSentAt,
    showInfo: handleShowInfo,
    closeInfo: closeMessageInfo,
    resendFromInfo: handleResendFromInfo,
    canResend: canResendFromInfo,
  } = useMessageInfoSheet(resendText, protocol, dmDevices.senderOf);

  // Live-location entry point (#206). The Attach → Location tile opens a
  // chooser sheet — snapshot or live for N — instead of going straight
  // into the snapshot flow. The snapshot path reuses the shared composer
  // hook's `handleShareLocation`; only the live path is screen-local
  // (it drives the LiveLocationProvider).
  const openLocationChooser = useCallback(() => {
    if (sharingLocation) return;
    setAttachPanelOpen(false);
    setLiveLocationPickerOpen(true);
  }, [sharingLocation]);

  const handleShareSnapshot = useCallback(async () => {
    setLiveLocationPickerOpen(false);
    await handleShareLocation();
  }, [handleShareLocation]);

  const closeLiveLocationPicker = useCallback(() => setLiveLocationPickerOpen(false), []);
  const liveTarget = useMemo(
    () => ({ kind: 'dm' as const, recipientPubkey: pubkey, protocol }),
    [pubkey, protocol],
  );
  const handleShareLive = useStartLiveLocationShare({
    target: liveTarget,
    name,
    closePicker: closeLiveLocationPicker,
    appendOptimisticLocal,
  });

  const handleStopLive = useCallback(
    async (sessionId: string) => {
      const result = await stopShare(sessionId);
      if (!result.ok) {
        Alert.alert(t('conversationScreen.couldNotStopLiveShareTitle'), result.error);
      }
    },
    [stopShare, t],
  );

  const openLocation = useCallback(
    (loc: SharedLocation) => {
      const url = buildOsmViewUrl(loc);
      Linking.openURL(url).catch(() => {
        Alert.alert(
          t('conversationScreen.couldNotOpenLinkTitle'),
          t('conversationScreen.couldNotOpenLinkBody'),
        );
      });
    },
    [t],
  );

  // Mini-maps may show an existing fix, but opening a DM (even one with
  // location messages) must never request permission or retain a GPS watch.
  // Sharing location or explicitly opening the full map owns that consent.
  const { pos: myPos } = useUserLocation({ enabled: false });
  // `Map` lives in the Explore sub-stack, so target it through the
  // Explore tab rather than the root stack (the detail screens reach it
  // via a CompositeNavigationProp; ConversationScreen is root-stack only).
  const onOpenMap = useCallback(
    () =>
      navigation.navigate('Main', {
        screen: 'MainTabs',
        params: {
          screen: 'Explore',
          params: {
            screen: 'Map',
            // Carry this DM's route so the Map's back button returns here
            // instead of dropping the user on the Explore tab.
            params: { returnTo: { screen: 'Conversation', params: route.params } },
          },
        },
      }),
    [navigation, route.params],
  );

  const handlePayInvoice = useCallback((raw: string) => {
    setInvoiceToPay(raw);
    setSendSheetOpen(true);
  }, []);

  // Share an NWC wallet (#431) — sender picker + recipient Add flows, both
  // gated behind an access warning. Extracted to keep this screen under the
  // size cap; the bearer connection string only ever moves inside the
  // encrypted NIP-17 DM.
  const {
    nwcWallets,
    nwcPickerOpen,
    openNwcSharePicker,
    closeNwcPicker,
    shareToWallet,
    addSharedWallet,
  } = useNwcShareActions({
    wallets,
    addNwcWallet,
    shareNwcWallet,
    peerName: name,
    onCloseAttachPanel: closeAttachPanel,
  });

  // Receive-side live-location plumbing (#206, #1300): coordinate updates
  // (MLS in a Marmot chat, relays otherwise) + the bubble's read models.
  const { liveLocationLatest, liveLocationBubbleStatus, liveLocationBubbleRemaining } =
    useConversationLiveLocation({
      items,
      isLoggedIn,
      myPubkey,
      pubkey,
      signerType,
      relays,
      marmot: protocol === 'marmot',
    });

  const relayReactionBackend = useMemo(
    () => ({
      fetchReactionsForMessages,
      publishReaction,
      deleteReaction,
      fetchReactionDeletions: fetchReactionDeletionsForReactions,
    }),
    [
      fetchReactionsForMessages,
      publishReaction,
      deleteReaction,
      fetchReactionDeletionsForReactions,
    ],
  );
  const reactionBackend = useReactionBackend(protocol, myPubkey, pubkey, relayReactionBackend);

  // Per-message reactions + long-press action state (#205) — kind-7 fetch /
  // reduce, optimistic publish/retract toggle, and the actioned-message
  // descriptor — live in a hook so this screen stays composition.
  const {
    reactionsByTarget,
    actionsForMessage,
    closeMessageActions,
    handleToggleReaction,
    handleZapMessage,
    reactionsForItem,
    buildOnLongPress,
    buildOnToggleReaction,
  } = useConversationReactions({
    scopeKey: `${protocol}:${pubkey}`,
    messages,
    myPubkey,
    peerPubkey: pubkey,
    ...reactionBackend,
    onZapMessage: () => setSendSheetOpen(true),
  });

  // Copy text, plus Edit / Delete for everyone on your own messages in a
  // Marmot chat (#1237) — sheet + composer props.
  const menu = useMessageActionsMenu({
    myPubkey,
    scope: myPubkey ? `${myPubkey}:${pubkey}:${protocol}` : null,
    marmotPeer: protocol === 'marmot' ? pubkey : null,
    messages,
    setMessages,
    idOf: marmotIdOf,
    draft,
    setDraft,
    actioned: actionsForMessage,
    closeActions: closeMessageActions,
    onSend: handleSend,
  });

  // Ephemeral "typing…" indicator (#dm-typing). `pubkey` is the peer here.
  const { isPeerTyping, notifyTyping } = useTypingIndicator(pubkey);

  // Failed Marmot invite → draft a "please invite me again" for them (#1269).
  const askForInvite = useCallback(() => setDraft(t('marmotInviteFailed.askDraft')), [t]);
  const renderItem = useCallback(
    ({ item }: { item: Item }) => {
      const row = (
        <ConversationMessageRow
          item={item}
          styles={styles}
          colors={colors}
          sharedProfiles={sharedProfiles}
          isInvoicePaid={isInvoicePaid}
          onPayInvoice={handlePayInvoice}
          onOpenContact={openSharedContact}
          onOpenLocation={openLocation}
          onOpenGifFullscreen={setFullscreenGifUrl}
          onToggleSecretMode={handleToggleSecretMode}
          pollAggregates={pollAggregates}
          onVotePoll={handleVotePoll}
          onShowTxDetail={setDetailTx}
          liveLocationLatest={liveLocationLatest}
          liveLocationStatus={liveLocationBubbleStatus}
          liveLocationRemainingMs={liveLocationBubbleRemaining}
          onStopLiveLocation={handleStopLive}
          myLat={myPos?.lat ?? null}
          myLon={myPos?.lon ?? null}
          myAccuracyMetres={myPos?.accuracy ?? null}
          myAvatarUri={profile?.picture ?? null}
          peerAvatarUri={picture ?? null}
          onOpenMap={onOpenMap}
          onShowInfo={handleShowInfo}
          onLongPress={buildOnLongPress(item)}
          reactions={reactionsForItem(item)}
          onToggleReaction={buildOnToggleReaction(item)}
          onAddNwc={addSharedWallet}
          peerName={name}
          peerPubkey={pubkey}
          onAskForInvite={askForInvite}
          peerMediaTrusted={peerMediaTrusted}
        />
      );
      // Inverted cells reverse direct siblings. Keep the divider and message
      // in one normal-column child so the divider stays visually above it.
      return item.id === read.dividerId ? (
        <View>
          <UnreadDivider testID="conversation-unread-divider" />
          {row}
        </View>
      ) : (
        row
      );
    },
    [
      read.dividerId,
      pubkey,
      peerMediaTrusted,
      openLocation,
      isInvoicePaid,
      sharedProfiles,
      openSharedContact,
      handlePayInvoice,
      addSharedWallet,
      pollAggregates,
      handleVotePoll,
      handleToggleSecretMode,
      handleShowInfo,
      liveLocationLatest,
      liveLocationBubbleStatus,
      liveLocationBubbleRemaining,
      handleStopLive,
      myPos,
      picture,
      profile,
      name,
      onOpenMap,
      styles,
      colors,
      reactionsForItem,
      buildOnLongPress,
      buildOnToggleReaction,
      askForInvite,
    ],
  );

  const { contact, openPeerProfile } = usePeerContact(route.params, presentContactSheet);
  const tools = useDmChatTools(
    messages,
    contact,
    route.params,
    protocol,
    dmDevices,
    read.scrollToId,
    clear,
    live.leaveEdge,
    items,
  );
  const goBack = useCallback(() => navigation.goBack(), [navigation]);

  return (
    <ChatToolsProvider query={tools.search.query} highlightedId={tools.highlightedId}>
      <View style={styles.container}>
        {/* Paint the safe-area / status-bar strip pink so the white
          system icons (time, signal, battery) stay visible against
          the brand colour instead of disappearing into our near-white
          app background. */}
        <View style={{ height: insets.top, backgroundColor: colors.brandPink }} />
        {tools.search.active ? (
          <ChatSearchHeader search={tools.search} />
        ) : (
          <ConversationHeader
            menu={tools.menu}
            name={contact.name}
            picture={contact.picture}
            protocol={protocol}
            styles={styles}
            colors={colors}
            onBack={goBack}
            onOpenProfile={openPeerProfile}
            byline={dmDevices.byline}
            onBylinePress={dmDevices.openSheet}
          />
        )}

        {/* KeyboardStickyView (below) floats the composer above the IME
          on Android 15+ edge-to-edge. `react-native-edge-to-edge` (in
          app.config.ts) installs the `WindowInsetsCompat` root listener
          that makes the IME inset visible to RNKC in the first place —
          without it every keyboard API silently reported 0 height on
          Android 16 (#194 diagnosis). `offset.opened: -insets.bottom`
          pulls the composer flush against the keyboard's top edge
          (RNKC's canonical chat pattern). */}
        <View style={styles.flex}>
          {/* Wrapping the list (and scroll-to-bottom FAB) in an
            Animated.View whose marginBottom tracks the keyboard
            height — shrinks the list's layout footprint so the
            bottom-most bubbles aren't hidden under the IME. The
            composer below this wrapper sits OUTSIDE the lifted
            block; KeyboardStickyView handles the composer's own
            keyboard avoidance independently. */}
          <Animated.View style={[styles.flex, animatedListLiftStyle]}>
            {loading ? (
              <View style={styles.loading}>
                <BrandedSpinner />
                <Text style={styles.loadingText}>{t('conversationScreen.loadingMessages')}</Text>
              </View>
            ) : (
              <FlatList
                ref={listRef}
                style={styles.flex}
                data={items}
                keyExtractor={conversationItemKey}
                renderItem={renderItem}
                contentContainerStyle={listContentStyle}
                inverted
                // Keep the visible history row anchored when live messages prepend.
                maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
                // Window the list so a thread with hundreds of messages
                // doesn't mount every row up front — first-frame work goes
                // from "render all N bubbles + avatars" to "render the
                // 20 newest then lazy-mount as the user scrolls". These
                // defaults are chosen for chat-style threads: one screen
                // fits ~8-10 bubbles, so 20 covers the visible viewport
                // plus one screen of pre-roll for smooth momentum scrolls.
                //
                // NOTE: `removeClippedSubviews` is deliberately OFF. It's
                // broken with `inverted` on Android — breaks the contentOffset
                // reporting so onScroll's `y < 200` check flips when the user
                // is visually at the bottom, making the scroll-to-bottom FAB
                // show spuriously. See facebook/react-native#30521 / #26061.
                initialNumToRender={20}
                maxToRenderPerBatch={10}
                windowSize={10}
                ListEmptyComponent={
                  <View style={styles.empty}>
                    <Text style={styles.emptyTitle}>{t('conversationScreen.noMessages')}</Text>
                    <Text style={styles.emptySubtitle}>
                      {lightningAddress
                        ? t('conversationScreen.sayHiZap')
                        : t('conversationScreen.sayHi')}
                    </Text>
                  </View>
                }
                refreshControl={
                  <BrandedRefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
                }
                onScroll={live.onScroll}
                onContentSizeChange={live.onContentSizeChange}
                scrollEventThrottle={100}
                viewabilityConfigCallbackPairs={read.viewabilityConfigCallbackPairs}
                onScrollToIndexFailed={read.onScrollToIndexFailed}
              />
            )}

            {/* Backdrop tap-to-close: when the attach panel is open, an
            absolute transparent Pressable sits above the FlatList area.
            Tapping anywhere on the messages closes the panel (matches
            WhatsApp behaviour). Trade-off: you can't tap a message bubble
            while the panel is open — close the panel first. */}
            {attachPanelOpen ? (
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={closeAttachPanel}
                accessibilityLabel={t('conversationScreen.closeAttachPanel')}
                testID="conversation-attach-backdrop"
              />
            ) : null}

            {live.hasNewMessages && !loading ? (
              <NewMessagesPill onPress={live.jumpToLatest} testID="conversation-new-messages" />
            ) : null}
            {!loading ? (
              <ChatJumpButtons
                mentionCount={0}
                onJumpToMention={read.jumpToNextMention}
                showLatest={!live.atEdge && !live.hasNewMessages}
                unreadCount={read.unread}
                onJumpToLatest={live.jumpToLatest}
                testIDs={{
                  mention: 'conversation-jump-to-mention',
                  latest: 'conversation-scroll-to-bottom',
                }}
              />
            ) : null}
          </Animated.View>

          {/* Composer + attach panel + IME-aware safe area now live in the
            shared ConversationComposer (#251). Both the 1:1 and group
            screens render through the same component so the keyboard
            wrapper, animated paddingBottom, and attach-panel placement
            can't drift again the way they did between v22 and v26. */}
          {isPeerTyping && (
            <Text
              style={styles.typingIndicator}
              testID="peer-typing-indicator"
              accessibilityLiveRegion="polite"
              accessibilityLabel={t('conversationScreen.typing')}
            >
              {t('conversationScreen.typing')}
            </Text>
          )}
          <ConversationComposer
            attachmentsEnabled={protocol !== 'nip04'}
            value={draft}
            onChangeText={(text) => {
              setDraft(text);
              notifyTyping();
            }}
            {...menu.composer}
            onStartVoiceNote={() => setVoiceSheetOpen(true)}
            sending={sending}
            disabled={!isLoggedIn}
            onAttachToggle={() => (attachPanelOpen ? closeAttachPanel() : openAttachPanel())}
            attachOpen={attachPanelOpen}
            attachDisabled={sharingLocation || uploadingImage}
            attachLoading={sharingLocation || uploadingImage}
            onInputFocus={closeAttachPanel}
            placeholder={t('conversationScreen.messagePlaceholder')}
            // 1:1 ships the compact lucide Send icon (40x40) + a light-grey
            // attach button background. Defaults match this so we keep the
            // shipped 1:1 visuals byte-for-byte.
            sendButtonVariant="icon"
            attachButtonHasBackground
            composerPaddingHorizontal={10}
            testIDs={{
              input: 'conversation-input',
              attach: 'conversation-attach',
              send: 'conversation-send',
            }}
            attachPanel={
              <AttachPanel
                onShareLocation={openLocationChooser}
                onSendImage={handlePickAndSendImage}
                onSendFile={handlePickAndSendFile}
                onTakePhoto={handleTakeAndSendPhoto}
                onSendZap={() => {
                  closeAttachPanel();
                  setSendSheetOpen(true);
                }}
                zapDisabled={!lightningAddress}
                zapAccessibilityLabel={t('conversationScreen.zapUnavailable')}
                onSendInvoice={() => {
                  closeAttachPanel();
                  setInvoiceSheetOpen(true);
                }}
                onShareContact={() => {
                  // Picker opens over the conversation; don't close the
                  // panel until the user actually picks (or cancels).
                  setContactPickerOpen(true);
                }}
                onShareWallet={openNwcSharePicker}
                onSendGif={
                  isGifConfigured()
                    ? () => {
                        // GifPickerSheet opens over the panel.
                        setGifPickerOpen(true);
                      }
                    : undefined
                }
                onSharePoll={() => {
                  // Composer opens over the AttachPanel — close the panel
                  // first so the BottomSheet snaps without competing for
                  // touch focus with the visible attach grid behind it.
                  closeAttachPanel();
                  setPollComposerOpen(true);
                }}
                onSendVoiceNote={() => {
                  // VoiceRecordingSheet opens over the panel; leave the panel
                  // mounted so dismissing the sheet returns the user to it.
                  setVoiceSheetOpen(true);
                }}
              />
            }
          />
        </View>
        <LiveLocationDurationPicker
          visible={liveLocationPickerOpen}
          onClose={() => setLiveLocationPickerOpen(false)}
          onChooseSnapshot={handleShareSnapshot}
          onChooseLive={handleShareLive}
        />
        <VoiceRecordingSheet
          visible={voiceSheetOpen}
          onClose={() => setVoiceSheetOpen(false)}
          onSend={handleSendVoiceNote}
          sending={uploadingVoice}
        />
        <GifPickerSheet
          visible={gifPickerOpen}
          onClose={() => {
            setGifPickerOpen(false);
            setAttachPanelOpen(false);
          }}
          onSelect={handleSendGif}
        />
        <PollComposerSheet
          visible={pollComposerOpen}
          onClose={() => setPollComposerOpen(false)}
          onSend={handleSendPoll}
        />
        <FullscreenGifModal
          url={fullscreenGifUrl}
          onClose={() => setFullscreenGifUrl(null)}
          closeLabel={t('conversationScreen.closeFullscreenGif')}
          testID="conversation-gif-fullscreen"
        />
        <FriendPickerSheet
          visible={contactPickerOpen}
          onClose={() => {
            // Closing the picker with no selection also closes the
            // AttachPanel underneath — the user has navigated away from
            // the attach flow, the parent is no longer relevant.
            setContactPickerOpen(false);
            setAttachPanelOpen(false);
          }}
          onSelect={handleShareContactPicked}
          title={t('conversationScreen.shareContactTitle', { name })}
          subtitle={t('conversationScreen.shareContactSubtitle')}
        />
        <NwcWalletShareSheet
          visible={nwcPickerOpen}
          onClose={closeNwcPicker}
          wallets={nwcWallets}
          onSelect={shareToWallet}
        />
        <ReceiveSheet
          visible={invoiceSheetOpen}
          onClose={() => setInvoiceSheetOpen(false)}
          presetFriend={{
            pubkey,
            name,
            picture: picture ?? null,
            lightningAddress: lightningAddress ?? null,
          }}
          presetProtocol={protocol}
          onSent={(payload) => {
            appendOptimisticLocal(payload);
          }}
          onMarmotUnreachable={offerNip17ForText}
        />
        <SendSheet
          visible={sendSheetOpen}
          onClose={() => {
            setSendSheetOpen(false);
            setInvoiceToPay(null);
            handleRefresh();
          }}
          initialAddress={invoiceToPay ?? lightningAddress ?? undefined}
          // Paying a bolt11 invoice encodes the recipient in the invoice
          // itself, so clear the per-conversation recipient hints. Paying a
          // lightning address (contains `@`, not `ln…`) keeps the hints so
          // SendSheet's label reads `Pay to <name>`.
          initialPicture={
            invoiceToPay && !invoiceToPay.includes('@') ? undefined : (picture ?? undefined)
          }
          recipientPubkey={invoiceToPay && !invoiceToPay.includes('@') ? undefined : pubkey}
          recipientName={invoiceToPay && !invoiceToPay.includes('@') ? undefined : name}
        />
        <TransactionDetailSheet
          visible={detailTx !== null}
          tx={detailTx}
          onClose={() => setDetailTx(null)}
          onCounterpartyPress={(contact) => {
            setDetailTx(null);
            presentContactSheet(contact);
          }}
        />
        <MessageActionsSheet
          visible={actionsForMessage !== null}
          onClose={closeMessageActions}
          myReactions={
            actionsForMessage
              ? (reactionsByTarget.get(actionsForMessage.targetId)?.myReactions ?? {})
              : {}
          }
          onToggleReaction={handleToggleReaction}
          // Zap is only meaningful for an incoming bubble whose author has a
          // lightning route. Hidden for our own outgoing bubbles (zapping
          // yourself is a no-op) and when the peer has no lud16.
          onZap={
            actionsForMessage && !actionsForMessage.fromMe && lightningAddress
              ? handleZapMessage
              : undefined
          }
          {...menu.sheet}
        />
        <ContactProfileSheet
          visible={profileSheetVisible}
          onClose={() => setProfileSheetVisible(false)}
          contact={sheetContact}
          onViewFullProfile={handleViewFullProfile}
          onMessage={
            sheetContact?.pubkey && sheetContact.pubkey !== pubkey
              ? async () => {
                  const c = sheetContact;
                  if (!c?.pubkey) return;
                  setProfileSheetVisible(false);
                  navigation.replace(
                    'Conversation',
                    await preferredConversationParams(myPubkey, { ...c, pubkey: c.pubkey }),
                  );
                }
              : undefined
          }
          onZap={
            sheetContact?.lightningAddress
              ? () => {
                  setProfileSheetVisible(false);
                  setSendSheetOpen(true);
                }
              : undefined
          }
        />
        <SecretModeCelebration
          visible={secretCelebrationVisible}
          enabled={secretPendingEnabled}
          onDismiss={() => setSecretCelebrationVisible(false)}
        />
        <DeliveryDetailSheet
          info={messageSheetInfo}
          onClose={closeMessageInfo}
          onResend={canResendFromInfo ? handleResendFromInfo : undefined}
          devices={dmDevices.messageDevices(messageSheetSender, messageSheetSentAt)}
        />
        <DmMembersSheet
          visible={dmDevices.sheetOpen}
          onClose={dmDevices.closeSheet}
          peer={{ pubkey, name, picture: picture ?? null }}
          chatId={dmDevices.chatId}
          deviceCounts={dmDevices.counts}
          onMemberTap={openPeerProfile}
        />
      </View>
    </ChatToolsProvider>
  );
};

export default ConversationScreen;
