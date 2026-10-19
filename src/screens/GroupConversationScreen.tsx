import { preferredConversationParams } from '../services/preferredDmProtocol';
import BrandedSpinner from '../components/BrandedSpinner';
import { useGroupConversationLoader } from '../hooks/useGroupConversationLoader';
import { useGroupChatTools } from '../hooks/useGroupChatTools';
import { useChatLocalHistory } from '../hooks/useChatLocalHistory';
import { ChatToolsProvider } from '../components/ChatToolsProvider';
import ChatSearchHeader from '../components/ChatSearchHeader';
import { useAccountState } from '../contexts/useAccountState';
import { useLiveMessageIndicator } from '../hooks/useLiveMessageIndicator';
import NewMessagesPill from '../components/NewMessagesPill';
import ChatJumpButtons from '../components/ChatJumpButtons';
import UnreadDivider from '../components/UnreadDivider';
import MentionPicker from '../components/MentionPicker';
import { useChatReadPosition } from '../hooks/useChatReadPosition';
import { useListScrollToId } from '../hooks/useListScrollToId';
import { useMentionComposer } from '../hooks/useMentionComposer';
import { useSharedContactProfiles } from '../hooks/useSharedContactProfiles';
import { groupReadKey } from '../services/chatReadPositions';
import { messageMentions } from '../utils/chatMentions';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, Linking } from 'react-native';
import { Alert } from '../components/BrandedAlert';
import {
  KeyboardController,
  useReanimatedKeyboardAnimation,
} from 'react-native-keyboard-controller';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation, useRoute, useIsFocused } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createGroupConversationScreenStyles } from '../styles/GroupConversationScreen.styles';
import { useGroups } from '../contexts/GroupsContext';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { useGroupComposerActions } from '../hooks/useGroupComposerActions';
import { useGroupMemberProfiles } from '../hooks/useGroupMemberProfiles';
import { buildGroupMemberRows } from '../utils/groupMemberRows';
import { shortNpub } from '../utils/shortNpub';
import RenameGroupSheet from '../components/RenameGroupSheet';
import GroupMembersSheet from '../components/GroupMembersSheet';
import ChatHeaderBar from '../components/ChatHeaderBar';
import GroupConversationHeader from '../components/GroupConversationHeader';
import { canManageGroup } from '../utils/groupAdmins';
import AttachPanel from '../components/AttachPanel';
import ConversationComposer from '../components/ConversationComposer';
import FullscreenGifModal from '../components/FullscreenGifModal';
import GifPickerSheet from '../components/GifPickerSheet';
import PollComposerSheet from '../components/PollComposerSheet';
import ReceiveSheet from '../components/ReceiveSheet';
import VoiceRecordingSheet from '../components/VoiceRecordingSheet';
import SendSheet from '../components/SendSheet';
import FriendPickerSheet from '../components/FriendPickerSheet';
import ContactProfileSheet from '../components/ContactProfileSheet';
import type { ContactProfileBodyData } from '../components/ContactProfileBody';
import GroupMessageRow from '../components/GroupMessageRow';
import { groupSenderRunStarts } from '../utils/groupSenderRuns';
import LiveLocationDurationPicker from '../components/LiveLocationDurationPicker';
import { useGroupLiveLocation } from '../hooks/useGroupLiveLocation';
import { useFollowedPubkeys } from '../hooks/useFollowedPubkeys';
import { canAutoLoadMedia } from '../utils/mediaTrust';
import MessageActionsSheet from '../components/MessageActionsSheet';
import { useGroupMessageActions } from '../hooks/useGroupMessageActions';
import { useMessageActionsMenu } from '../hooks/useMessageActionsMenu';
import { isMarmotGroupId } from '../services/marmotSession';
import DeliveryDetailSheet from '../components/DeliveryDetailSheet';
import DeviceNoticeLine from '../components/DeviceNoticeLine';
import { useGroupDevices } from '../hooks/useGroupDevices';
import {
  isDeviceNoticeRow,
  useGroupTimeline,
  groupSenderLabel,
  type GroupTimelineRow,
} from '../hooks/useGroupTimeline';
import { useMessageInfoSheet } from '../hooks/useMessageInfoSheet';
import SecretModeCelebration from '../components/SecretModeCelebration';
import { isConfigured as isGifConfigured } from '../services/giphyService';
import { buildOsmViewUrl, type SharedLocation } from '../services/locationService';
import { type GroupMessage } from '../services/groupMessagesStorageService';
import { useGroupPolls } from '../hooks/useGroupPolls';
import { usePaidInvoiceTracker } from '../hooks/usePaidInvoiceTracker';
import type { NostrProfile } from '../types/nostr';
import type { UnreadEntry } from '../utils/chatUnread';
import type { GroupConversationRoute, RootStackParamList } from '../navigation/types';

type GroupConversationNavigation = NativeStackNavigationProp<
  RootStackParamList,
  'GroupConversation'
>;

const EMPTY_PUBKEYS: string[] = [];
const EMPTY_MESSAGES: GroupMessage[] = [];
const groupMessageId = (m: GroupMessage) => m.id;
const timelineRowId = (row: GroupTimelineRow) => row.id;
const GROUP_LIST_ANCHOR = { minIndexForVisible: 0 };

const GroupConversationScreen: React.FC = () => {
  const insets = useSafeAreaInsets();
  // The composer's own keyboard wiring lives in ConversationComposer
  // (#251). The screen ALSO listens to the keyboard so the FlatList
  // shrinks by the keyboard height when the IME opens — without this
  // the bottom bubbles render under the keyboard because
  // KeyboardStickyView only translates the composer visually, it
  // doesn't reduce the FlatList's layout footprint (#470).
  const keyboard = useReanimatedKeyboardAnimation();
  const animatedListLiftStyle = useAnimatedStyle(() => ({
    marginBottom: -keyboard.height.value,
  }));
  const navigation = useNavigation<GroupConversationNavigation>();
  const route = useRoute<GroupConversationRoute>();
  const focused = useIsFocused();
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createGroupConversationScreenStyles(colors), [colors]);
  const { getGroup, secretMode, setSecretMode } = useGroups();
  const { pubkey: myPubkey, profile: myProfile, fetchProfilesForPubkeys } = useNostr();
  const { contacts } = useNostrContacts();
  // Trust gate (#1338), decided per SENDER: a stranger's media in a group
  // stays tap-to-load even when I follow other members.
  const followed = useFollowedPubkeys();
  const [renameVisible, setRenameVisible] = useState(false);
  const [membersSheetVisible, setMembersSheetVisible] = useState(false);
  const goBack = useCallback(() => navigation.goBack(), [navigation]);
  const openRename = useCallback(() => setRenameVisible(true), []);
  const openMembers = useCallback(() => setMembersSheetVisible(true), []);
  const messageOwner = myPubkey ? `${myPubkey}:${route.params.groupId}` : null;
  const [draft, setDraft] = useAccountState(messageOwner, '');
  const [rawMessages, setMessages] = useAccountState(messageOwner, EMPTY_MESSAGES);
  const { messages, clear, clearBoundary } = useChatLocalHistory(
    myPubkey,
    `group:${route.params.groupId}`,
    rawMessages,
  );
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [attachPanelOpen, setAttachPanelOpen] = useState(false);
  const [gifPickerOpen, setGifPickerOpen] = useState(false);
  const [invoiceSheetOpen, setInvoiceSheetOpen] = useState(false);
  const [contactPickerOpen, setContactPickerOpen] = useState(false);
  const [pollComposerOpen, setPollComposerOpen] = useState(false);
  const [voiceSheetOpen, setVoiceSheetOpen] = useState(false);
  // Sheets surfaced by MessageBubble taps. Mirror the 1:1 conversation
  // wiring (ConversationScreen) so the rich-card affordances work the
  // same in groups.
  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  const [invoiceToPay, setInvoiceToPay] = useState<string | null>(null);
  const [fullscreenGifUrl, setFullscreenGifUrl] = useState<string | null>(null);
  // Secret Mode chat-trigger card overlay state. Mirrors the 1:1
  // wiring in ConversationScreen — owned at screen level so the
  // celebration confetti renders once over the group conversation,
  // not per bubble cell.
  const [secretCelebrationVisible, setSecretCelebrationVisible] = useState(false);
  const [secretPendingEnabled, setSecretPendingEnabled] = useState(false);
  const handleToggleSecretMode = useCallback(() => {
    const next = !secretMode;
    setSecretMode(next);
    setSecretPendingEnabled(next);
    setSecretCelebrationVisible(true);
  }, [secretMode, setSecretMode]);
  // Contact preview sheet — peek a member or shared contact without
  // leaving the group conversation. The sheet's "View full profile"
  // link drills into ContactProfile when the user wants the deep view.
  const [sheetContact, setSheetContact] = useState<ContactProfileBodyData | null>(null);
  const [profileSheetVisible, setProfileSheetVisible] = useState(false);
  const listRef = useRef<FlatList<GroupTimelineRow>>(null);

  const group = getGroup(route.params.groupId);

  const loadedGroupId = group?.id;

  useGroupConversationLoader(myPubkey, loadedGroupId, setMessages, setLoadingMessages);

  const liveEntries = useMemo(
    () => messages.map((message) => ({ id: message.id, createdAt: message.createdAt })),
    [messages],
  );
  const live = useLiveMessageIndicator({
    scope: `${myPubkey}:${route.params.groupId}`,
    entries: liveEntries,
    loading: loadingMessages,
    edge: 'end',
    scrollToLatest: (animated) => listRef.current?.scrollToEnd({ animated }),
  });

  // NOTE: We used to call refreshDmInbox({ force: true }) on mount here
  // to drain any pending kind-14 group rumors before the live subscription
  // kicked in. That cost 3-25 s of JS-thread blocking depending on inbox
  // size — perceived as freeze on back-tap (#286). The live subscription
  // (`subscribeGroupMessages` above) handles delivery for any wraps that
  // land while the screen is open; missed wraps from before mount get
  // drained on the next MessagesScreen focus or app-foreground refresh.

  // Stored `memberPubkeys` excludes the viewer by LP convention (see
  // GroupsContext). For display we re-include self pinned at the top so
  // the header count and the members sheet reflect the true group size,
  // matching Signal / WhatsApp / Telegram (#473). The "You" suffix on
  // the self row is wired via `memberNameByPubkey` below + the sheet's
  // own self-row marker.
  // Members the viewer doesn't follow resolve through the shared profile
  // cache, plus one bounded kind-0 batch while the members sheet is open
  // (#1268). Rows feed the header count, sender labels and the sheet.
  const memberPubkeys = group?.memberPubkeys ?? EMPTY_PUBKEYS;
  const memberProfiles = useGroupMemberProfiles({
    memberPubkeys,
    messages,
    selfPubkey: myPubkey,
    contacts,
    // One bounded batch supplies sender avatars while the thread is focused.
    enabled: focused,
    fetchProfilesForPubkeys,
  });
  const members = useMemo(
    () =>
      group
        ? buildGroupMemberRows({
            memberPubkeys,
            selfPubkey: myPubkey,
            selfProfile: myProfile,
            contacts,
            profiles: memberProfiles,
          })
        : [],
    [group, memberPubkeys, myPubkey, myProfile, contacts, memberProfiles],
  );

  const memberNameByPubkey = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of members) map.set(m.pubkey, m.name);
    if (myPubkey) map.set(myPubkey, t('groupConversationScreen.you'));
    return map;
  }, [members, myPubkey, t]);

  const marmotGroupId = group && isMarmotGroupId(group.id) ? group.id : null;
  // A person's devices in a Marmot group (#1267): sheet counts, notices, info rows.
  const groupDevices = useGroupDevices({ groupId: marmotGroupId, myPubkey, memberNameByPubkey });
  // Rows classified once per update, with the alpha device notices merged in.
  const { rows: timelineRows, senderOf } = useGroupTimeline({
    messages,
    myPubkey,
    memberNameByPubkey,
    formatLocale,
    deviceNotices: groupDevices.notices,
    clearBoundary,
  });
  // @mentions (#1295): the member picker + `@Name` → `nostr:npub…` on send.
  const mention = useMentionComposer({ draft, setDraft, members, selfPubkey: myPubkey });

  const reactions = useGroupMessageActions({
    messages,
    myPubkey,
    groupId: marmotGroupId,
    memberNameByPubkey,
    formatLocale,
  });
  const actioned = reactions.actionsForMessage;
  const closeActions = reactions.closeMessageActions;
  // Destructured: `reactions` itself is a new object every render, so a
  // renderItem depending on it re-rendered every row on screen each time.
  const { replyTo, cancelReply, startReply, replyQuote, propsForMessage } = reactions;

  // Send / upload / share orchestration + in-flight flags live in the
  // useGroupComposerActions hook (parallel to the 1:1 screen's
  // useConversationComposerActions). Everything funnels through the hook's
  // sendText (optimistic append + scroll).
  const {
    sending,
    uploadingImage,
    sharingLocation,
    uploadingVoice,
    sendText,
    handleSend,
    handlePickAndSendImage,
    handlePickAndSendFile,
    handleTakeAndSendPhoto,
    handleShareLocation,
    handleSendGif,
    handleShareContactPicked,
    handleSendInvoiceToGroup,
    handleSendVoiceNote,
    resendText,
  } = useGroupComposerActions({
    group,
    draft,
    setDraft,
    setMessages,
    // Same as the arrow: keeps re-aiming until the list really is at the end.
    scrollToEnd: live.jumpToLatest,
    setAttachPanelOpen,
    setGifPickerOpen,
    setContactPickerOpen,
    setVoiceSheetOpen,
    encodeMessage: mention.encode,
    replyTo,
    onReplySent: reactions.onReplySent,
  });

  // Tap a group bubble → the same message-info sheet 1:1 chats use (#856).
  // Group sends aren't per-relay tracked (no delivery store), so the sheet
  // shows the protocol/kind/id metadata + a Re-publish for sent text.
  const {
    info: messageSheetInfo,
    sender: messageSheetSender,
    sentAt: messageSheetSentAt,
    showInfo: handleShowInfo,
    closeInfo: closeMessageInfo,
    resendFromInfo: handleResendFromInfo,
    canResend: canResendFromInfo,
  } = useMessageInfoSheet(resendText, marmotGroupId ? 'marmot' : 'nip17', senderOf);

  const menu = useMessageActionsMenu({
    myPubkey,
    scope: messageOwner,
    marmotGroupId,
    messages,
    setMessages,
    idOf: groupMessageId,
    draft,
    setDraft,
    actioned,
    closeActions,
    onSend: handleSend,
  });

  const closeAttachPanel = useCallback(() => setAttachPanelOpen(false), []);
  // Mirror ConversationScreen's openAttachPanel: dismiss the IME first
  // so the panel + composer + keyboard never have to stack. Without this,
  // tapping the attach button while the message input is focused leaves
  // the keyboard up, forcing the sticky layout to compete with the IME.
  const openAttachPanel = useCallback(() => {
    setAttachPanelOpen(true);
    KeyboardController.dismiss();
  }, []);

  // MessageBubble handler — Pay button on an invoice / lightning address
  // bubble routes through SendSheet, same UX as 1:1 conversations.
  const handlePayInvoice = useCallback((raw: string) => {
    setInvoiceToPay(raw);
    setSendSheetOpen(true);
  }, []);

  const presentContactSheet = useCallback((contact: ContactProfileBodyData) => {
    setSheetContact(contact);
    setProfileSheetVisible(true);
  }, []);
  const handleViewFullProfile = useCallback(() => {
    if (!sheetContact) return;
    setProfileSheetVisible(false);
    navigation.navigate('ContactProfile', { contact: sheetContact });
  }, [sheetContact, navigation]);

  // MessageBubble handler — open the contact preview sheet for the
  // shared contact, falling back to a short-pubkey placeholder when
  // the kind-0 hasn't loaded yet (sharedProfiles fetch is below).
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

  // MessageBubble handler — opens OSM in the system browser. Identical
  // to 1:1 conversation behaviour.
  const openLocation = useCallback(
    (loc: SharedLocation) => {
      const url = buildOsmViewUrl(loc);
      Linking.openURL(url).catch(() => {
        Alert.alert(
          t('groupConversationScreen.couldNotOpenLinkTitle'),
          t('groupConversationScreen.couldNotOpenLinkMessage'),
        );
      });
    },
    [t],
  );

  // Kind-0 profiles for shared-contact cards, keyed by pubkey (`null` = looked
  // up, none found) — the same batched fetch the 1:1 thread uses.
  const sharedProfiles = useSharedContactProfiles(messages, contacts);

  // Read position (#1295): jump to the first unread with a divider, the `@`
  // button for unread mentions, and the unread count on jump-to-latest.
  const readEntries = useMemo<UnreadEntry[]>(() => {
    const me = myPubkey?.toLowerCase();
    const out: UnreadEntry[] = [];
    for (const row of timelineRows) {
      if (isDeviceNoticeRow(row)) continue; // local notices aren't messages
      const fromMe = row.senderPubkey.toLowerCase() === me;
      out.push({
        id: row.id,
        createdAt: row.createdAt,
        fromMe,
        mentionsMe: !fromMe && messageMentions(row, myPubkey),
      });
    }
    return out;
  }, [timelineRows, myPubkey]);
  const { scrollToId, onScrollToIndexFailed } = useListScrollToId(
    listRef,
    timelineRows,
    timelineRowId,
    0.1,
  );
  const tools = useGroupChatTools(
    messages,
    group,
    members,
    groupDevices,
    scrollToId,
    clear,
    live.leaveEdge,
    timelineRows,
  );
  const read = useChatReadPosition({
    initialTarget: route.params.jumpToMessage,
    owner: myPubkey,
    conversationKey: loadedGroupId ? groupReadKey(loadedGroupId) : null,
    entries: readEntries,
    loading: loadingMessages,
    scrollToId,
    leaveEdge: live.leaveEdge,
  });

  // Live location (#1300): chooser + live bubbles' read models (Marmot groups).
  const liveLoc = useGroupLiveLocation({
    groupId: group?.id ?? null,
    marmotGroupId,
    groupName: group?.name ?? '',
    messages: timelineRows,
    handleShareLocation,
    closeAttachPanel,
  });

  // Text-encoded group polls: tallies + send / vote (see useGroupPolls).
  const { pollAggregates, handleSendPoll, handleVotePoll } = useGroupPolls(
    messages,
    myPubkey,
    sendText,
  );

  const trackedMessages = useMemo(
    () =>
      messages.map((m) => ({
        text: m.text,
        fromMe: m.senderPubkey === myPubkey,
        createdAt: m.createdAt,
      })),
    [messages, myPubkey],
  );
  const { isInvoicePaid } = usePaidInvoiceTracker(trackedMessages);

  const senderRuns = useMemo(
    () => groupSenderRunStarts(timelineRows, myPubkey),
    [timelineRows, myPubkey],
  );
  const memberByPubkey = useMemo(
    () => new Map(members.map((m) => [m.pubkey.toLowerCase(), m])),
    [members],
  );
  const openSender = useCallback(
    (pk: string) => {
      const member = memberByPubkey.get(pk.toLowerCase());
      const contact = contacts.find((c) => c.pubkey.toLowerCase() === pk.toLowerCase());
      setMembersSheetVisible(false);
      presentContactSheet({
        pubkey: pk,
        name: member?.name ?? shortNpub(pk),
        picture: member?.picture ?? null,
        banner: contact?.profile?.banner ?? null,
        nip05: contact?.profile?.nip05 ?? null,
        lightningAddress: contact?.profile?.lud16 ?? null,
        source: 'nostr',
      });
    },
    [memberByPubkey, contacts, presentContactSheet],
  );

  const renderMessage = useCallback(
    ({ item }: { item: GroupTimelineRow }) => {
      if (isDeviceNoticeRow(item)) {
        return (
          <DeviceNoticeLine
            id={item.id}
            createdAt={item.createdAt}
            name={memberNameByPubkey.get(item.pubkey) ?? shortNpub(item.pubkey)}
            joined={item.joined}
            clients={item.clients}
            colors={colors}
          />
        );
      }
      const fromMe = item.senderPubkey.toLowerCase() === myPubkey?.toLowerCase();
      const senderName = groupSenderLabel(
        fromMe,
        item.content.kind,
        memberByPubkey.get(item.senderPubkey.toLowerCase())?.name ?? shortNpub(item.senderPubkey),
        t('messageBubble.quoteYou'),
      );
      // Reuse the shared bubble — same renderer 1:1 chats use, so contact /
      // invoice / location / image / GIF / poll cards all render identically
      // across chat types (#239). The classifier handles geo: + GIF + poll
      // detection up front; image / invoice / lnaddr / contact ride on the
      // text variant and detect at render time.
      const bubble = (
        <GroupMessageRow
          senderPubkey={item.senderPubkey}
          senderPicture={memberByPubkey.get(item.senderPubkey.toLowerCase())?.picture ?? null}
          showSender={senderRuns.has(item.id)}
          onOpenSender={openSender}
          id={item.id}
          fromMe={fromMe}
          createdAt={item.createdAt}
          content={item.content}
          senderName={senderName}
          sharedProfiles={sharedProfiles}
          onPayInvoice={handlePayInvoice}
          onPayLightningAddress={handlePayInvoice}
          onOpenContact={openSharedContact}
          onOpenLocation={openLocation}
          liveLocationLatest={liveLoc.liveLocationLatest}
          liveLocationStatus={liveLoc.liveLocationBubbleStatus}
          liveLocationRemainingMs={liveLoc.liveLocationBubbleRemaining}
          onStopLiveLocation={liveLoc.stopLive}
          liveLocationSender={item.senderPubkey}
          onOpenGifFullscreen={setFullscreenGifUrl}
          pollAggregates={pollAggregates}
          onVotePoll={handleVotePoll}
          onToggleSecretMode={handleToggleSecretMode}
          isInvoicePaid={isInvoicePaid}
          // Stored kind: 14 chat or 15 encrypted file (voice/image) — a Marmot
          // group's kind-9 rumors are stored the same way. The info sheet reads this,
          // so pass the per-message wireKind derived above rather than a hard
          // 14. Group sends aren't per-relay tracked, so no deliveryStatus (the
          // sheet shows "Not tracked").
          wireKind={item.wireKind}
          onShowInfo={handleShowInfo}
          quote={item.quote}
          edited={item.editedAt !== undefined}
          autoLoadMedia={canAutoLoadMedia(fromMe, item.senderPubkey, followed)}
          {...propsForMessage(item)}
          testIdPrefix="group-conversation"
        />
      );
      return item.id === read.dividerId ? (
        <>
          <UnreadDivider testID="group-unread-divider" />
          {bubble}
        </>
      ) : (
        bubble
      );
    },
    [
      t,
      colors,
      senderRuns,
      memberByPubkey,
      openSender,
      followed,
      read.dividerId,
      propsForMessage,
      myPubkey,
      memberNameByPubkey,
      sharedProfiles,
      handlePayInvoice,
      openSharedContact,
      openLocation,
      liveLoc.liveLocationLatest,
      liveLoc.liveLocationBubbleStatus,
      liveLoc.liveLocationBubbleRemaining,
      liveLoc.stopLive,
      pollAggregates,
      handleVotePoll,
      handleToggleSecretMode,
      isInvoicePaid,
      handleShowInfo,
    ],
  );

  if (!group) {
    return (
      <View style={styles.container}>
        <View style={{ height: insets.top, backgroundColor: colors.brandPink }} />
        <ChatHeaderBar
          onBack={goBack}
          backLabel={t('groupConversationScreen.back')}
          backTestID="group-back"
          avatar={null}
          title={<Text style={styles.title}>{t('groupConversationScreen.group')}</Text>}
          trailing={null}
        />
        <View style={styles.content}>
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{t('groupConversationScreen.groupNotFound')}</Text>
            <Text style={styles.emptySubtitle}>{t('groupConversationScreen.groupDeleted')}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <ChatToolsProvider query={tools.search.query} highlightedId={tools.highlightedId}>
      <View style={styles.container}>
        {/* Same pink status-bar strip as the 1:1 thread, so the light
          system icons stay legible above the compact header. */}
        <View style={{ height: insets.top, backgroundColor: colors.brandPink }} />
        {tools.search.active ? (
          <ChatSearchHeader search={tools.search} />
        ) : (
          <GroupConversationHeader
            group={group}
            members={members}
            canRename={canManageGroup(group, myPubkey)}
            menu={tools.menu}
            onBack={goBack}
            onRename={openRename}
            onOpenMembers={openMembers}
          />
        )}

        <View style={styles.content}>
          {/* See #470 — wrap the FlatList (NOT the composer) in an
            Animated.View whose marginBottom tracks the keyboard
            height so the IME doesn't hide the bottom messages. The
            composer below this wrapper handles its own keyboard
            avoidance via KeyboardStickyView. */}
          <Animated.View style={[{ flex: 1 }, animatedListLiftStyle]}>
            {loadingMessages ? (
              <BrandedSpinner style={{ marginTop: 32 }} />
            ) : (
              <FlatList
                ref={listRef}
                data={timelineRows}
                keyExtractor={timelineRowId}
                renderItem={renderMessage}
                contentContainerStyle={styles.messagesList}
                testID="group-messages-list"
                onScroll={live.onScroll}
                onScrollBeginDrag={live.onScrollBeginDrag}
                scrollEventThrottle={100}
                // Keep the rows on screen still when rows above them change
                // height (re-mounted while scrolling back, history landing).
                maintainVisibleContentPosition={GROUP_LIST_ANCHOR}
                onContentSizeChange={live.onContentSizeChange}
                viewabilityConfigCallbackPairs={read.viewabilityConfigCallbackPairs}
                onScrollToIndexFailed={onScrollToIndexFailed}
                ListEmptyComponent={
                  <View style={styles.emptyState}>
                    <Text style={styles.emptySubtitle}>
                      {t('groupConversationScreen.noMessages')}
                    </Text>
                  </View>
                }
              />
            )}
            {live.hasNewMessages && !loadingMessages && (
              <NewMessagesPill onPress={live.jumpToLatest} testID="group-new-messages" />
            )}
            {!loadingMessages && (
              <ChatJumpButtons
                mentionCount={read.pendingMentions.length}
                onJumpToMention={read.jumpToNextMention}
                showLatest={!live.atEdge && !live.hasNewMessages}
                unreadCount={read.unread}
                onJumpToLatest={live.jumpToLatest}
                testIDs={{ mention: 'group-jump-to-mention', latest: 'group-jump-to-latest' }}
              />
            )}
          </Animated.View>

          {/* Composer + attach panel + IME-aware safe area now live in the
            shared ConversationComposer (#251). Style overrides preserve
            the group-specific look (paper-plane Send button, transparent
            attach button, 12 dp horizontal padding). */}
          <ConversationComposer
            value={draft}
            onChangeText={setDraft}
            {...menu.composer}
            replying={replyQuote ? { quote: replyQuote, onCancel: cancelReply } : undefined}
            accessory={<MentionPicker candidates={mention.candidates} onPick={mention.pick} />}
            onSelectionChange={mention.onSelectionChange}
            selection={mention.selection}
            onStartVoiceNote={() => setVoiceSheetOpen(true)}
            sending={sending}
            onAttachToggle={() => (attachPanelOpen ? closeAttachPanel() : openAttachPanel())}
            attachOpen={attachPanelOpen}
            attachDisabled={sharingLocation || uploadingImage}
            attachLoading={sharingLocation || uploadingImage}
            onInputFocus={closeAttachPanel}
            placeholder={t('groupConversationScreen.typeMessage')}
            sendButtonVariant="paper-plane"
            composerPaddingHorizontal={12}
            accessibilityLabels={{
              input: t('groupConversationScreen.messageInput'),
              attach: t('groupConversationScreen.attach'),
              send: t('groupConversationScreen.sendMessage'),
            }}
            testIDs={{
              input: 'group-message-input',
              attach: 'group-attach-button',
              send: 'group-send-button',
            }}
            attachPanel={
              <AttachPanel
                onShareLocation={liveLoc.openLocation}
                onSendImage={handlePickAndSendImage}
                onSendFile={handlePickAndSendFile}
                onTakePhoto={handleTakeAndSendPhoto}
                onSendGif={isGifConfigured() ? () => setGifPickerOpen(true) : undefined}
                // Zap renders but stays disabled — there's no single recipient
                // to zap in a group, but hiding the tile entirely confused
                // users who expected the same set as 1:1 (#237).
                onSendZap={() => {}}
                zapDisabled
                zapAccessibilityLabel={t('groupConversationScreen.zapUnavailable')}
                onSendInvoice={() => {
                  closeAttachPanel();
                  setInvoiceSheetOpen(true);
                }}
                onShareContact={() => {
                  // Picker opens over the panel; close on cancel/select.
                  setContactPickerOpen(true);
                }}
                onSharePoll={() => {
                  // Composer opens over the panel — close it first so the
                  // BottomSheet snaps without competing for touch focus
                  // with the visible attach grid behind it.
                  closeAttachPanel();
                  setPollComposerOpen(true);
                }}
                onSendVoiceNote={() => setVoiceSheetOpen(true)}
                // Shown but disabled: wallet connections are only shared 1:1.
                onShareWallet={() => {}}
                walletDisabled
                walletAccessibilityLabel={t('groupConversationScreen.walletUnavailable')}
              />
            }
          />
        </View>

        <LiveLocationDurationPicker
          visible={liveLoc.pickerOpen}
          onClose={liveLoc.closePicker}
          onChooseSnapshot={liveLoc.shareSnapshot}
          onChooseLive={liveLoc.shareLive}
        />

        <VoiceRecordingSheet
          visible={voiceSheetOpen}
          onClose={() => setVoiceSheetOpen(false)}
          onSend={handleSendVoiceNote}
          sending={uploadingVoice}
        />

        <RenameGroupSheet
          visible={renameVisible}
          groupId={group.id}
          onClose={() => setRenameVisible(false)}
        />

        <GroupMembersSheet
          visible={membersSheetVisible}
          groupId={group.id}
          onClose={() => setMembersSheetVisible(false)}
          members={members}
          chatId={groupDevices.chatId}
          deviceCounts={groupDevices.counts}
          onMemberTap={openSender}
        />

        <GifPickerSheet
          visible={gifPickerOpen}
          onClose={() => setGifPickerOpen(false)}
          onSelect={handleSendGif}
        />

        <PollComposerSheet
          visible={pollComposerOpen}
          onClose={() => setPollComposerOpen(false)}
          onSend={handleSendPoll}
        />

        <FriendPickerSheet
          visible={contactPickerOpen}
          onClose={() => {
            // Closing the picker (cancel or pick) also closes the
            // AttachPanel underneath — same behaviour as 1:1 chats.
            setContactPickerOpen(false);
            setAttachPanelOpen(false);
          }}
          onSelect={handleShareContactPicked}
          title={t('groupConversationScreen.shareContactTitle', { name: group.name })}
          subtitle={t('groupConversationScreen.shareContactSubtitle')}
        />

        <ReceiveSheet
          visible={invoiceSheetOpen}
          onClose={() => setInvoiceSheetOpen(false)}
          presetGroup={{ name: group.name }}
          onSendToGroup={handleSendInvoiceToGroup}
        />

        {/* Pay button on a received invoice routes to SendSheet pre-filled
          with the bolt11. Group invoices have no per-message wallet
          binding, so we leave initialPicture / recipientPubkey unset and
          let SendSheet decode the invoice for the destination. */}
        <SendSheet
          visible={sendSheetOpen}
          onClose={() => {
            setSendSheetOpen(false);
            setInvoiceToPay(null);
          }}
          initialAddress={invoiceToPay ?? undefined}
        />

        <FullscreenGifModal
          url={fullscreenGifUrl}
          onClose={() => setFullscreenGifUrl(null)}
          closeLabel={t('groupConversationScreen.closeFullscreenGif')}
          testID="group-conversation-gif-fullscreen"
        />

        <MessageActionsSheet
          visible={actioned !== null}
          onClose={closeActions}
          myReactions={
            actioned ? (reactions.reactionsByTarget.get(actioned.targetId)?.myReactions ?? {}) : {}
          }
          onToggleReaction={reactions.handleToggleReaction}
          showReactions={!!marmotGroupId}
          onReply={
            actioned
              ? () => {
                  menu.composer.editing?.onCancel();
                  startReply();
                }
              : undefined
          }
          {...menu.sheet}
          onEdit={
            menu.sheet.onEdit
              ? () => {
                  cancelReply();
                  menu.sheet.onEdit?.();
                }
              : undefined
          }
        />

        <ContactProfileSheet
          visible={profileSheetVisible}
          onClose={() => setProfileSheetVisible(false)}
          contact={sheetContact}
          onViewFullProfile={handleViewFullProfile}
          onMessage={
            sheetContact?.pubkey
              ? async () => {
                  const c = sheetContact;
                  if (!c?.pubkey) return;
                  setProfileSheetVisible(false);
                  navigation.navigate(
                    'Conversation',
                    await preferredConversationParams(myPubkey, { ...c, pubkey: c.pubkey }),
                  );
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
          devices={groupDevices.messageDevices(messageSheetSender, messageSheetSentAt)}
        />
      </View>
    </ChatToolsProvider>
  );
};
export default GroupConversationScreen;
