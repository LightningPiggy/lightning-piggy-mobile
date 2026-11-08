import { sendSharedDm } from '../services/sendSharedDm';
import { DEFAULT_DM_PROTOCOL } from '../utils/dmProtocol';
import { preferredDmProtocol } from '../services/preferredDmProtocol';
import { openDirectChat } from '../utils/openDirectChat';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import BrandedSpinner from '../components/BrandedSpinner';
import { useCollectionFilter } from '../hooks/useCollectionFilter';
import MarketCollectionChips from '../components/MarketCollectionChips';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Linking,
  Share,
  useWindowDimensions,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import ContactActionsSheet from '../components/ContactActionsSheet';
import * as Clipboard from 'expo-clipboard';
import { ChevronLeft, MoreHorizontal } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useIsFocused, useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Alert } from '../components/BrandedAlert';
import Toast from '../components/BrandedToast';
import NfcWriteSheet from '../components/NfcWriteSheet';
import QrSheet from '../components/QrSheet';
import SendSheet from '../components/SendSheet';
import ContactProfileHeader from '../components/profile/ContactProfileHeader';
import ProfileTabBar from '../components/profile/ProfileTabBar';
import ProfileFeedRow from '../components/profile/ProfileFeedRow';
import ProfileStickyBar from '../components/profile/ProfileStickyBar';
import PostsFilterSwitch from '../components/profile/PostsFilterSwitch';
import FriendPickerSheet, { PickedFriend } from '../components/FriendPickerSheet';
import { type ContactProfileBodyData } from '../components/ContactProfileBody';
import FullscreenImageModal from '../components/FullscreenImageModal';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { useWallet } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createContactProfileScreenStyles } from '../styles/ContactProfileScreen.styles';
import { createProfileTabsStyles } from '../styles/ProfileTabs.styles';
import {
  profileHeaderLayout,
  profileStickyPhase,
  type ProfileStickyPhase,
} from '../utils/profileHeaderLayout';
import {
  buildProfileRows,
  countTopLevelPosts,
  shouldAutoPage,
  type PostsMode,
  type ProfileRow,
  type ProfileTab,
} from '../utils/profileFeedRows';
import { useProfileFeed } from '../hooks/useProfileFeed';
import { useSellerProducts } from '../hooks/useSellerProducts';
import type { MarketProduct } from '../data/marketProducts';
import { isNfcSupported } from '../services/nfcService';
import {
  npubEncode,
  nprofileEncode,
  buildProfileRelayHints,
  fetchProfile,
} from '../services/nostrService';
import { setLightningAddress } from '../services/contactsService';
import { getVerifiedLud16, peekVerifiedLud16 } from '../services/verifiedLud16Cache';
import type { RootStackParamList } from '../navigation/types';

type ContactProfileNavigation = NativeStackNavigationProp<RootStackParamList, 'ContactProfile'>;
type ContactProfileRoute = RouteProp<RootStackParamList, 'ContactProfile'>;

// Fills a missing Lightning address from the last verified kind-0, so a warm
// profile shows it (and an enabled zap button) on the first frame (#1719).
function withCachedLud16(contact: ContactProfileBodyData): ContactProfileBodyData {
  if (!contact.pubkey || contact.lightningAddress) return contact;
  const cached = peekVerifiedLud16(contact.pubkey);
  return cached ? { ...contact, lightningAddress: cached } : contact;
}

// Full-page friends profile route. Layout follows Primal/Damus
// convention: back chevron pinned top-left, the identity header
// (ContactProfileHeader: banner, avatar, action row, name, nip05, npub,
// lud16, NIP-27-aware bio), then Posts / Media / Products tabs (#1332).
// Header, tab bar and the active tab's rows are ONE virtualised FlashList
// so long feeds stay cheap. Share / open externally / NFC live behind the
// "…" button. The quick-glance sheet (ContactProfileSheet +
// ContactProfileBody) is separate — see issue #435.
const ContactProfileScreen: React.FC = () => {
  const t = useTranslation();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<ContactProfileNavigation>();
  const route = useRoute<ContactProfileRoute>();
  const { sendDirectMessage, relays, pubkey: viewerPubkey, appendLocalDmMessage } = useNostr();
  const { contacts, followContact, unfollowContact } = useNostrContacts();
  const { hasWallets } = useWallet();

  const [contact, setContact] = useState<ContactProfileBodyData>(() =>
    withCachedLud16(route.params.contact),
  );
  const [following, setFollowing] = useState(false);
  const [loadingFollow, setLoadingFollow] = useState(false);
  // Tap the avatar / a picture → view it full screen (#661 — same as the sheet).
  const [fullscreenUrl, setFullscreenUrl] = useState<string | null>(null);
  const [sendSheetOpen, setSendSheetOpen] = useState(false);
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [actionsSheetOpen, setActionsSheetOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [nfcWriteVisible, setNfcWriteVisible] = useState(false);
  const [nfcSupported, setNfcSupported] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Bumped on pull-to-refresh so the feed re-subscribes and the Shop tab
  // refetches.
  const [notesReloadNonce, setNotesReloadNonce] = useState(0);
  const [tab, setTab] = useState<ProfileTab>(route.params.initialTab ?? 'posts');
  // Posts tab filter: top-level posts by default, or posts and replies.
  const [postsMode, setPostsMode] = useState<PostsMode>('posts');
  // The Shop tab's listings are fetched only once it has been opened.
  const [productsOpened, setProductsOpened] = useState(route.params.initialTab === 'shop');

  // React Navigation may reuse this screen instance and only update params
  // when navigating to ContactProfile while it's already in the stack.
  // Re-sync the local `contact` state when the param identity changes —
  // gated on `pubkey` so navigating from FriendsScreen → profile → back
  // → tap-same-friend (which builds a fresh `ContactProfileBodyData`
  // each time but with the same pubkey) doesn't blow away our locally
  // fetched `about` bio + avatar-load state.
  const paramContact = route.params.contact;
  // Use the pubkey for Nostr contacts (stable hex) and the phone
  // contact id for phone-only contacts (where pubkey is null). Without
  // the phone fallback, navigating between two different phone contacts
  // while the screen is reused would no-op (`null === null`) and keep
  // showing the previous contact's data.
  const paramIdentityKey = paramContact.pubkey ?? route.params.phoneContactId ?? null;
  useEffect(() => {
    setContact(withCachedLud16(paramContact));
    // Seller links open Shop; other profile entry points start on Posts.
    setTab(route.params.initialTab ?? 'posts');
    setPostsMode('posts');
    setProductsOpened(route.params.initialTab === 'shop');
    // Profile objects may refresh without changing the intended identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramIdentityKey, route.params.initialTab]);

  const npub = useMemo(
    () => (contact.pubkey ? npubEncode(contact.pubkey) : null),
    [contact.pubkey],
  );

  // `nostr:nprofile1…` (pubkey + relay hints) to write to an NFC tag —
  // strictly more useful than a bare npub for a cold-contact scanner, who
  // can resolve this person's metadata even on niche relays (#755). Mirrors
  // the relay-hint sourcing used by the OS/DM share handlers below.
  // Recomputed when the QR / NFC sheet opens, so a write relay discovered
  // after the first render (the outbox lookup, #1390) is in the hints.
  const nprofileRef = useMemo(() => {
    if (!contact.pubkey) return undefined;
    const readRelays = relays.filter((r) => r.read).map((r) => r.url);
    const relayHints = buildProfileRelayHints(contact.pubkey, contacts, readRelays);
    return `nostr:${nprofileEncode(contact.pubkey, relayHints)}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contact.pubkey, contacts, relays, qrSheetOpen, nfcWriteVisible]);

  // Probe NFC capability once on mount.
  useEffect(() => {
    let cancelled = false;
    isNfcSupported().then((ok) => {
      if (!cancelled) setNfcSupported(ok);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Most entry points pre-build ContactProfileBodyData without the bio (it
  // isn't shown on the row item), so it's lazily hydrated here too.
  // Resolves the *verified* profile once per pubkey to fill in the bio AND
  // the Lightning address. The contacts-list profile has its lud16 stripped
  // (anti-redirect slimming), so this verified single-fetch is what re-arms
  // the zap button and yields a safe-to-pay address. Meanwhile the address
  // from the last verified fetch shows at once (#1719), so a slow network
  // doesn't grey out a known address. Keyed on the pubkey alone, so seeding
  // the address can't cancel the fetch.
  const relaysRef = useRef(relays);
  const contactsRef = useRef(contacts);
  useEffect(() => {
    relaysRef.current = relays;
    contactsRef.current = contacts;
  }, [relays, contacts]);
  // The contact's kind-3 relay hint, for a profile missing from the viewer's
  // relays (#1390): every fetch of this profile passes it.
  // Who the screen shows NOW, for lookups that finish after it changed.
  const shownPubkeyRef = useRef(contact.pubkey);
  useEffect(() => {
    shownPubkeyRef.current = contact.pubkey;
  }, [contact.pubkey]);
  const hintsFor = useCallback((pubkey: string) => {
    const hint = contactsRef.current.find((c) => c.pubkey === pubkey)?.relay;
    return hint ? [hint] : undefined;
  }, []);
  useEffect(() => {
    const pubkey = contact.pubkey;
    if (!pubkey) return;
    let cancelled = false;
    const readRelays = relaysRef.current.filter((r) => r.read).map((r) => r.url);
    const cachedLud16 = getVerifiedLud16(pubkey).catch(() => null);
    void cachedLud16.then((cached) => {
      if (cancelled || !cached) return;
      setContact((prev) =>
        prev.pubkey === pubkey && !prev.lightningAddress
          ? { ...prev, lightningAddress: cached }
          : prev,
      );
    });
    // A profile missing from those relays is looked for on the person's own
    // relays and their kind-3 hint (#1390).
    Promise.all([fetchProfile(pubkey, readRelays, { hints: hintsFor(pubkey) }), cachedLud16])
      .then(([profile, cached]) => {
        if (cancelled || !profile) return;
        setContact((prev) => {
          if (prev.pubkey !== pubkey) return prev;
          // Authoritative over a cached address (since replaced or removed);
          // an address the caller passed in still wins.
          const keepAddress = !!prev.lightningAddress && prev.lightningAddress !== cached;
          return {
            ...prev,
            // A profile opened from a bare reference (an @mention chip, a
            // deep link) arrives as a stub named after its npub — fill the
            // identity in too, never overwriting what the caller passed.
            name:
              prev.name.startsWith('npub1') && prev.name.endsWith('…')
                ? (profile.displayName ?? profile.name ?? prev.name)
                : prev.name,
            picture: prev.picture ?? profile.picture ?? null,
            banner: prev.banner ?? profile.banner ?? null,
            nip05: prev.nip05 ?? profile.nip05 ?? null,
            about: prev.about ?? profile.about ?? null,
            lightningAddress: keepAddress ? prev.lightningAddress : (profile.lud16 ?? null),
          };
        });
      })
      .catch(() => {
        // best-effort — bio + address are non-critical to first paint
      });
    return () => {
      cancelled = true;
    };
  }, [contact.pubkey, hintsFor]);

  // Pull-to-refresh: unlike the gap-fill effect above (which only fills
  // missing about/lud16, once), this re-fetches the kind-0 from relays and
  // OVERWRITES every displayed field with the latest (the address being the
  // newest verified one, see fetchProfile) — so a friend who
  // updated their name, picture, banner, bio or Lightning address surfaces
  // without waiting out the 24h profile cache. `fetchProfile` is a direct
  // relay query, so there's no cache to bypass.
  const handleRefresh = useCallback(async () => {
    const pubkey = contact.pubkey;
    if (!pubkey) return;
    setRefreshing(true);
    try {
      const readRelays = relays.filter((r) => r.read).map((r) => r.url);
      const fresh = await fetchProfile(pubkey, readRelays, { hints: hintsFor(pubkey) });
      // The screen may show someone else by now: never apply this person's
      // profile (or Lightning address) to them.
      if (fresh && shownPubkeyRef.current === pubkey) {
        setContact((prev) =>
          prev.pubkey !== pubkey
            ? prev
            : {
                ...prev,
                name: fresh.displayName ?? fresh.name ?? prev.name,
                picture: fresh.picture ?? null,
                banner: fresh.banner ?? null,
                about: fresh.about ?? null,
                lightningAddress: fresh.lud16 ?? null,
                nip05: fresh.nip05 ?? null,
              },
        );
      }
    } catch {
      // best-effort — a failed refresh leaves the current data in place
    } finally {
      setRefreshing(false);
    }
    // Re-query the kind-1 note feed for new posts too.
    setNotesReloadNonce((n) => n + 1);
  }, [contact.pubkey, relays, hintsFor]);

  useEffect(() => {
    if (contact.pubkey) {
      setFollowing(contacts.some((c) => c.pubkey === contact.pubkey));
    }
  }, [contact.pubkey, contacts]);

  const handleMessage = useCallback(async () => {
    if (!contact.pubkey) return;
    // `navigate` (not `replace`) so the user can back-button from
    // Conversation → Profile → previous screen. The dedupe inside the
    // Conversation route already collapses re-opens of the same DM
    // peer, so we don't worry about a profile→conversation→profile
    // bounce stacking duplicates.
    const state = navigation.getState();
    const previous = state.routes[state.index - 1];
    const thread =
      previous?.name === 'Conversation'
        ? (previous.params as RootStackParamList['Conversation'])
        : undefined;
    const explicit =
      thread?.pubkey === contact.pubkey ? (thread.protocol ?? DEFAULT_DM_PROTOCOL) : undefined;
    await openDirectChat(navigation, viewerPubkey, {
      protocol: explicit,
      pubkey: contact.pubkey,
      name: contact.name,
      picture: contact.picture,
      lightningAddress: contact.lightningAddress,
    });
  }, [contact, navigation, viewerPubkey]);

  const handleZap = useCallback(async () => {
    if (!hasWallets) {
      Alert.alert(
        t('contactProfileScreen.noWalletTitle'),
        t('contactProfileScreen.noWalletMessage'),
      );
      return;
    }
    let address = contact.lightningAddress;
    const pubkey = contact.pubkey;
    if (!address && pubkey) {
      // The on-mount verified fetch may not have finished yet (or failed) —
      // resolve once more on demand so a present lud16 isn't false-negatived
      // into a "no Lightning address" alert.
      const readRelays = relays.filter((r) => r.read).map((r) => r.url);
      const verified = await fetchProfile(pubkey, readRelays, { hints: hintsFor(pubkey) });
      // Moved on to someone else meanwhile: never pay them this address.
      if (shownPubkeyRef.current !== pubkey) return;
      if (verified?.lud16) {
        address = verified.lud16;
        setContact((prev) =>
          prev.pubkey === pubkey ? { ...prev, lightningAddress: verified.lud16 } : prev,
        );
      }
    }
    if (!address) {
      Alert.alert(
        t('contactProfileScreen.noLightningAddressTitle'),
        t('contactProfileScreen.noLightningAddressMessage', { name: contact.name }),
      );
      return;
    }
    setSendSheetOpen(true);
  }, [hasWallets, contact.lightningAddress, contact.pubkey, contact.name, relays, t, hintsFor]);

  const handleSetLightningAddress = useCallback(
    async (address: string) => {
      if (!route.params.phoneContactId) return;
      await setLightningAddress(route.params.phoneContactId, address);
      // Update local state so the row re-renders with the saved value.
      setContact((prev) => ({ ...prev, lightningAddress: address }));
    },
    [route.params.phoneContactId],
  );

  const handleFollowToggle = useCallback(async () => {
    if (!contact.pubkey || loadingFollow) return;
    if (following) {
      // Don't flip loadingFollow until the user actually confirms the
      // Unfollow — back-gesture / tap-outside dismissal doesn't fire
      // either button's onPress and would otherwise leave the chip
      // stuck spinning forever.
      Alert.alert(
        t('contactProfileScreen.unfollow'),
        t('contactProfileScreen.unfollowMessage', { name: contact.name }),
        [
          { text: t('contactProfileScreen.cancel'), style: 'cancel' },
          {
            text: t('contactProfileScreen.unfollow'),
            style: 'destructive',
            onPress: async () => {
              setLoadingFollow(true);
              try {
                const success = await unfollowContact(contact.pubkey!);
                if (success) setFollowing(false);
              } finally {
                setLoadingFollow(false);
              }
            },
          },
        ],
      );
      return;
    }
    setLoadingFollow(true);
    try {
      const success = await followContact(contact.pubkey);
      if (success) setFollowing(true);
    } finally {
      setLoadingFollow(false);
    }
  }, [contact.pubkey, contact.name, loadingFollow, following, followContact, unfollowContact, t]);

  const handleCopyNpub = useCallback(async () => {
    if (!npub) return;
    await Clipboard.setStringAsync(npub);
    Toast.show({
      type: 'success',
      text1: t('contactProfileScreen.publicKeyCopied'),
      position: 'top',
      visibilityTime: 1800,
    });
  }, [npub, t]);

  const handleCopyLnAddress = useCallback(async () => {
    if (!contact.lightningAddress) return;
    await Clipboard.setStringAsync(contact.lightningAddress);
    Toast.show({
      type: 'success',
      text1: t('contactProfileScreen.lightningAddressCopied'),
      position: 'top',
      visibilityTime: 1800,
    });
  }, [contact.lightningAddress, t]);

  // "Share to friend" — opens FriendPickerSheet for NIP-17 DM share.
  const handleShareToFriendOpen = useCallback(() => {
    if (!contact.pubkey) return;
    setShareOpen(true);
  }, [contact.pubkey]);

  // "Share" — native OS share sheet (other apps, clipboard, system intents).
  const handleOsShare = useCallback(async () => {
    if (!contact.pubkey || !npub) return;
    const readRelays = relays.filter((r) => r.read).map((r) => r.url);
    const relayHints = buildProfileRelayHints(contact.pubkey, contacts, readRelays);
    const nprofile = nprofileEncode(contact.pubkey, relayHints);
    const label = contact.name || t('contactProfileScreen.contactFallback');
    const nostrUri = `nostr:${nprofile}`;
    const webUrl = `https://njump.me/${npub}`;
    try {
      await Share.share({
        message: `${label}\n${nostrUri}\n${webUrl}`,
        url: webUrl,
      });
    } catch {
      // User dismissed or platform rejected — nothing to surface.
    }
  }, [contact.pubkey, contact.name, npub, contacts, relays, t]);

  const handleShareToFriend = useCallback(
    async (friend: PickedFriend) => {
      if (!contact.pubkey || sharing) return;
      setSharing(true);
      setShareOpen(false);
      try {
        const readRelays = relays.filter((r) => r.read).map((r) => r.url);
        const relayHints = buildProfileRelayHints(contact.pubkey, contacts, readRelays);
        const nprofile = nprofileEncode(contact.pubkey, relayHints);
        const label = contact.name || t('contactProfileScreen.contactFallback');
        const payload = t('contactProfileScreen.sharedContactPayload', { label, nprofile });
        const protocol = await preferredDmProtocol(viewerPubkey, friend.pubkey);
        const result = await sendSharedDm({
          peer: friend.pubkey,
          text: payload,
          protocol,
          send: () => sendDirectMessage(friend.pubkey, payload, { protocol }),
          append: appendLocalDmMessage,
        });
        if (!result.success) {
          Toast.show({
            type: 'error',
            text1: t('contactProfileScreen.shareFailed'),
            text2: result.error ?? t('contactProfileScreen.couldNotShareContact'),
            position: 'top',
            visibilityTime: 4000,
          });
          return;
        }
        navigation.navigate('Conversation', { ...friend, protocol });
        Toast.show({
          type: 'success',
          text1: t('contactProfileScreen.sharedWith', { label, name: friend.name }),
          position: 'top',
          visibilityTime: 2500,
        });
      } finally {
        setSharing(false);
      }
    },
    [
      contact.pubkey,
      contact.name,
      sharing,
      sendDirectMessage,
      appendLocalDmMessage,
      contacts,
      relays,
      viewerPubkey,
      navigation,
      t,
    ],
  );

  const handleViewProfile = useCallback(async () => {
    if (!npub) return;
    const nostrUri = `nostr:${npub}`;
    const canOpen = await Linking.canOpenURL(nostrUri);
    if (canOpen) {
      Linking.openURL(nostrUri);
    } else {
      Linking.openURL(`https://primal.net/p/${npub}`);
    }
  }, [npub]);

  const showFollowButton = !!contact.pubkey && contact.source === 'nostr';
  const canEditLnAddress = contact.source === 'contacts' && !!route.params.phoneContactId;

  // Identity-row sizing (#1332): regular or compact so the buttons + Follow
  // always fit on one row beside the avatar.
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const iconCount = (npub ? 1 : 0) + 1 + (contact.pubkey ? 1 : 0);
  const layout = useMemo(
    () => profileHeaderLayout(windowWidth, fontScale, iconCount, showFollowButton),
    [windowWidth, fontScale, iconCount, showFollowButton],
  );
  const styles = useMemo(() => createContactProfileScreenStyles(colors, layout), [colors, layout]);
  const tabStyles = useMemo(() => createProfileTabsStyles(colors), [colors]);

  // Posts + Media share one focus-gated feed subscription; the Shop loads on
  // first open of their tab.
  const feed = useProfileFeed(contact.pubkey, notesReloadNonce);
  const seller = useSellerProducts(contact.pubkey, productsOpened, notesReloadNonce, contact.name);
  const collectionFilter = useCollectionFilter(
    seller.products,
    tab === 'shop',
    contact.pubkey ?? null,
  );
  const selectTab = useCallback((next: ProfileTab) => {
    setTab(next);
    if (next === 'shop') setProductsOpened(true);
  }, []);
  const rows = useMemo(
    () =>
      contact.pubkey
        ? buildProfileRows({
            tab,
            postsMode,
            feed: feed.events,
            feedLoading: feed.loading && feed.hasRelays,
            feedUnavailable: feed.unavailable,
            products: collectionFilter.products,
            productsLoading: seller.loading,
            productsIncomplete: seller.incomplete,
          })
        : [],
    [
      contact.pubkey,
      tab,
      postsMode,
      feed.events,
      feed.unavailable,
      feed.loading,
      feed.hasRelays,
      collectionFilter.products,
      seller.loading,
      seller.incomplete,
    ],
  );

  // "Posts" hides replies, so a page can be mostly invisible. Keep paging
  // until there are enough top-level posts or the feed ends — bounded per
  // person + filter, after which "Load more" stays available.
  const autoPagesRef = useRef(0);
  useEffect(() => {
    autoPagesRef.current = 0;
  }, [contact.pubkey, postsMode]);
  const topLevelCount = useMemo(() => countTopLevelPosts(feed.events), [feed.events]);
  const { loadMore, loading: feedLoading, loadingMore, reachedEnd } = feed;
  // Fetched events, hidden comments included (#1337): a page of only those
  // must still let paging reach older posts.
  const feedSize = feed.fetchedCount;
  // Never while blurred: an abort on blur settles `loadingMore`, which must
  // not re-arm paging behind the next screen (review #1334).
  const focused = useIsFocused();
  useEffect(() => {
    const go = shouldAutoPage({
      focused,
      tab,
      postsMode,
      loading: feedLoading,
      loadingMore,
      reachedEnd,
      feedSize,
      topLevelCount,
      autoPages: autoPagesRef.current,
    });
    if (!go) return;
    autoPagesRef.current += 1;
    void loadMore();
  }, [
    focused,
    tab,
    postsMode,
    feedLoading,
    loadingMore,
    reachedEnd,
    feedSize,
    topLevelCount,
    loadMore,
  ]);

  const openProduct = useCallback(
    (product: MarketProduct) =>
      navigation.push('ProductDetail', { productId: product.id, product }),
    [navigation],
  );
  const renderRow = useCallback(
    ({ item }: { item: ProfileRow }) => (
      <ProfileFeedRow
        row={item}
        styles={tabStyles}
        onOpenImage={setFullscreenUrl}
        onOpenProduct={openProduct}
      />
    ),
    [tabStyles, openProduct],
  );
  const openQr = useCallback(() => setQrSheetOpen(true), []);

  // Pinned app bar (#1332 review): the tab bar's offset in the list is
  // measured once laid out; the scroll handler only commits state when the
  // phase actually changes (three values), never per scroll event.
  const tabBarYRef = useRef<number | null>(null);
  const scrollYRef = useRef(0);
  const [stickyPhase, setStickyPhase] = useState<ProfileStickyPhase>(0);
  const updateStickyPhase = useCallback(() => {
    const next = profileStickyPhase(scrollYRef.current, insets.top, tabBarYRef.current);
    setStickyPhase((prev) => (prev === next ? prev : next));
  }, [insets.top]);
  const handleScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollYRef.current = e.nativeEvent.contentOffset.y;
      updateStickyPhase();
    },
    [updateStickyPhase],
  );
  const handleTabBarLayout = useCallback(
    (e: LayoutChangeEvent) => {
      tabBarYRef.current = e.nativeEvent.layout.y;
      updateStickyPhase();
    },
    [updateStickyPhase],
  );

  const listHeader = useMemo(
    () => (
      <View>
        <ContactProfileHeader
          contact={contact}
          styles={styles}
          npub={npub}
          hasWallets={hasWallets}
          following={following}
          loadingFollow={loadingFollow}
          showFollowButton={showFollowButton}
          canEditLnAddress={canEditLnAddress}
          onOpenImage={setFullscreenUrl}
          onQr={openQr}
          onZap={handleZap}
          onMessage={handleMessage}
          onFollowToggle={handleFollowToggle}
          onCopyNpub={handleCopyNpub}
          onCopyLnAddress={handleCopyLnAddress}
          onSaveLightningAddress={handleSetLightningAddress}
        />
        {contact.pubkey ? (
          <View onLayout={handleTabBarLayout}>
            <ProfileTabBar active={tab} onChange={selectTab} styles={tabStyles} />
          </View>
        ) : null}
        {tab === 'shop' ? (
          <MarketCollectionChips
            collections={collectionFilter.collections}
            selected={collectionFilter.selected}
            onSelect={collectionFilter.select}
          />
        ) : null}
        {contact.pubkey && tab === 'posts' ? (
          <PostsFilterSwitch mode={postsMode} onChange={setPostsMode} styles={tabStyles} />
        ) : null}
      </View>
    ),
    [
      collectionFilter.collections,
      collectionFilter.selected,
      collectionFilter.select,
      contact,
      styles,
      npub,
      hasWallets,
      following,
      loadingFollow,
      showFollowButton,
      canEditLnAddress,
      openQr,
      handleZap,
      handleMessage,
      handleFollowToggle,
      handleCopyNpub,
      handleCopyLnAddress,
      handleSetLightningAddress,
      tab,
      selectTab,
      tabStyles,
      handleTabBarLayout,
      postsMode,
    ],
  );

  // Posts / Media page backwards on demand; nothing to page on Shop (the
  // seller's listings come in one bounded snapshot).
  const canPage = tab !== 'shop' && feed.fetchedCount > 0 && !feed.reachedEnd;
  const listFooter = canPage ? (
    <View style={tabStyles.footer}>
      {feed.loadingMore ? (
        <BrandedSpinner size="small" />
      ) : (
        <TouchableOpacity
          style={tabStyles.loadMoreButton}
          onPress={feed.loadMore}
          accessibilityRole="button"
          accessibilityLabel={t('profileTabs.loadMore')}
          testID="profile-load-more"
        >
          <Text style={tabStyles.loadMoreText}>{t('profileTabs.loadMore')}</Text>
        </TouchableOpacity>
      )}
    </View>
  ) : null;

  return (
    <View style={styles.container}>
      {/* Header strip pinned over the banner. The banner extends up behind
          the status bar (battery / clock / wifi) — `topBar` is absolute so
          the buttons sit just under the status bar (the safe-area inset,
          which already clears a camera cutout), with no extra gap. Back on
          the left, the "More" actions button on the right (mirrors the
          back chevron). Both buttons use a solid dark-pill background for
          contrast against busy banner imagery. */}
      <View style={[styles.topBar, { top: insets.top }]}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={() => navigation.goBack()}
          style={styles.headerButton}
          accessibilityLabel={t('contactProfileScreen.goBack')}
          testID="contact-profile-back"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <ChevronLeft size={22} color={colors.white} strokeWidth={2.4} />
        </TouchableOpacity>
        {contact.pubkey && (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{ disabled: sharing }}
            onPress={() => setActionsSheetOpen(true)}
            disabled={sharing}
            style={styles.headerButton}
            accessibilityLabel={t('contactProfileScreen.moreActions')}
            testID="contact-more-button"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <MoreHorizontal size={22} color={colors.white} strokeWidth={2.4} />
          </TouchableOpacity>
        )}
      </View>

      <FlashList
        data={rows}
        renderItem={renderRow}
        keyExtractor={(row) => row.key}
        getItemType={(row) => row.type}
        ListHeaderComponent={listHeader}
        ListFooterComponent={listFooter}
        // Posts page in as you scroll; the Media grid pages from its footer
        // button, since a text-heavy author can need several pages per row.
        onEndReached={tab === 'posts' && canPage ? feed.loadMore : undefined}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<BrandedRefreshControl refreshing={refreshing} onRefresh={handleRefresh} />}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        testID="contact-profile-list"
      />

      <ProfileStickyBar
        phase={stickyPhase}
        topInset={insets.top}
        title={contact.name}
        showTabs={!!contact.pubkey}
        tab={tab}
        onChangeTab={selectTab}
        styles={tabStyles}
      />

      {npub && (
        <QrSheet
          visible={qrSheetOpen}
          onClose={() => setQrSheetOpen(false)}
          npub={npub}
          nostrRef={nprofileRef}
          lightningAddress={contact.lightningAddress}
        />
      )}

      {npub && (
        <NfcWriteSheet
          visible={nfcWriteVisible}
          onClose={() => setNfcWriteVisible(false)}
          npub={npub}
          nostrRef={nprofileRef}
          displayName={contact.name}
        />
      )}

      <FriendPickerSheet
        visible={shareOpen}
        onClose={() => setShareOpen(false)}
        onSelect={handleShareToFriend}
        title={t('contactProfileScreen.shareTitle', {
          name: contact.name || t('contactProfileScreen.contactShort'),
        })}
        subtitle={t('contactProfileScreen.shareSubtitle')}
      />

      <ContactActionsSheet
        visible={actionsSheetOpen}
        onClose={() => setActionsSheetOpen(false)}
        onShare={handleOsShare}
        onOpenIn={handleViewProfile}
        onShareToFriend={handleShareToFriendOpen}
        onWriteToNfc={() => setNfcWriteVisible(true)}
        nfcSupported={nfcSupported}
      />

      <SendSheet
        visible={sendSheetOpen}
        onClose={() => setSendSheetOpen(false)}
        initialAddress={contact.lightningAddress ?? undefined}
        initialPicture={contact.picture ?? undefined}
        recipientPubkey={contact.pubkey ?? undefined}
        recipientName={contact.name}
      />

      <FullscreenImageModal url={fullscreenUrl} onClose={() => setFullscreenUrl(null)} />
    </View>
  );
};

export default ContactProfileScreen;
