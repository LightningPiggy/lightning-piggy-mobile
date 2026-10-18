import { enabledAppRelays } from '../services/appRelayPrefs';
import { MarketShortcutsProvider } from '../contexts/MarketShortcutsContext';
import { useSellerActivityChecks } from '../hooks/useSellerActivityChecks';
import { resolveActivityListing } from '../services/sellerActivityService';
import { getCurrentUserReadRelays } from '../services/nostrActiveAccount';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { orderNavigationTarget } from '../utils/orderNavigation';
import { resolveStoredNotificationTarget } from '../services/notificationStoredTarget';
import { routeNotificationMessage } from '../services/notificationGroupNavigation';
import { getMarmotSession } from '../services/marmotSession';
import { appNavigatorStyles as styles } from '../styles/AppNavigator.styles';
import BrandedSpinner from '../components/BrandedSpinner';
import React, { useEffect, useMemo, useState } from 'react';
import { DEFAULT_DM_PROTOCOL, dmThreadId, type DmProtocol } from '../utils/dmProtocol';
import { Linking, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  NavigationState,
  StackActions,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {
  loadPersistedNavigationState,
  persistNavigationState,
} from '../utils/navigationStatePersistence';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { Wallet, MessageCircle, Compass, Users } from 'lucide-react-native';
import { useWallet } from '../contexts/WalletContext';
import { useTheme } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import {
  setActiveThread,
  setActiveCache,
  dismissNotificationsFor,
  dropMarmotPushAlerts,
  markHistoryReadFor,
  type NotificationTarget,
  type NotificationData,
} from '../services/notificationService';
import {
  RootStackParamList,
  ExploreStackParamList,
  MainTabParamList,
  AccountDrawerParamList,
  RelaySettingsParamList,
} from './types';
import type { ContactProfileBodyData } from '../components/ContactProfileBody';

import { lazyScreen } from './lazyScreen';
import { RelayListEditorProvider } from '../contexts/RelayListEditorContext';

// Tab-root + drawer-chrome screens stay EAGER — they must render instantly on
// tab switch / drawer open, so paying their Hermes parse cost up-front is the
// right trade. Everything reachable only via a stack push is `lazyScreen`'d
// below so its module isn't evaluated until first navigate (audit HIGH 1).
import HomeScreen from '../screens/HomeScreen';
import MessagesScreen from '../screens/MessagesScreen';
import ExploreHomeScreen from '../screens/ExploreHomeScreen';
import FriendsScreen from '../screens/FriendsScreen';
import AccountDrawerContent from '../components/AccountDrawerContent';
import { perfLog, perfTabTap, perfTabRendered, perfTabHidden } from '../utils/perfLog';
import { getActivePubkey } from '../services/walletStorageService';
import {
  createRouteLeaveTracker,
  isForAnotherAccount,
  resolveWrapConversation,
} from '../services/notificationWrapResolver';

// Lazy (push-only) screens — deferred module eval. Each is wrapped in its own
// Suspense boundary by `lazyScreen`, so a slow chunk only shows a themed
// spinner for that screen and never tears down siblings (keeps `freezeOnBlur` +
// persisted nav state intact). Imperative deep-link routes
// (`navigationRef.navigate(...)`) mount these the same way a user tap does, so
// the Suspense resolves the import before the screen renders — every entry
// point in this file (navigateToHuntFound / navigateToHuntPiggyDetail /
// navigateToContactProfile / navigateToUnsupportedEntity / navigateToSend /
// navigateFromNotification) continues to work.
const LessonsScreen = lazyScreen(() => import('../screens/LessonsScreen'));
const MapScreen = lazyScreen(() => import('../screens/MapScreen'));
const PlacesScreen = lazyScreen(() => import('../screens/PlacesScreen'));
const PlaceDetailScreen = lazyScreen(() => import('../screens/PlaceDetailScreen'));
const MarketScreen = lazyScreen(() => import('../screens/MarketScreen'));
const MarketProductDetailScreen = lazyScreen(() => import('../screens/MarketProductDetailScreen'));
const MarketMyShopScreen = lazyScreen(() => import('../screens/MarketMyShopScreen'));
const MarketMyOrdersScreen = lazyScreen(() => import('../screens/MarketMyOrdersScreen'));
const MarketShopCurrenciesScreen = lazyScreen(
  () => import('../screens/MarketShopCurrenciesScreen'),
);
const MarketShopShippingScreen = lazyScreen(() => import('../screens/MarketShopShippingScreen'));
const MarketShopCollectionsScreen = lazyScreen(
  () => import('../screens/MarketShopCollectionsScreen'),
);
const MarketShopListingsScreen = lazyScreen(() => import('../screens/MarketShopListingsScreen'));
const MarketShopOrdersScreen = lazyScreen(() => import('../screens/MarketShopOrdersScreen'));
const MarketLikedItemsScreen = lazyScreen(() => import('../screens/MarketLikedItemsScreen'));
const MarketListingEditorScreen = lazyScreen(() => import('../screens/MarketListingEditorScreen'));
const HuntScreen = lazyScreen(() => import('../screens/HuntScreen'));
const HuntCreateScreen = lazyScreen(() => import('../screens/HuntCreateScreen'));
const HuntFoundScreen = lazyScreen(() => import('../screens/HuntFoundScreen'));
const HuntPiggyDetailScreen = lazyScreen(() => import('../screens/HuntPiggyDetailScreen'));
const MyPigletsScreen = lazyScreen(() => import('../screens/MyPigletsScreen'));
const HuntLeaderboardScreen = lazyScreen(() => import('../screens/HuntLeaderboardScreen'));
const EventsScreen = lazyScreen(() => import('../screens/EventsScreen'));
const EventDetailScreen = lazyScreen(() => import('../screens/EventDetailScreen'));
const CourseDetailScreen = lazyScreen(() => import('../screens/CourseDetailScreen'));
const MissionDetailScreen = lazyScreen(() => import('../screens/MissionDetailScreen'));
const ConversationScreen = lazyScreen(() => import('../screens/ConversationScreen'));
const ChatInfoScreen = lazyScreen(() => import('../screens/ChatInfoScreen'));
const ChatMediaScreen = lazyScreen(() => import('../screens/ChatMediaScreen'));
const GroupsScreen = lazyScreen(() => import('../screens/GroupsScreen'));
const GroupConversationScreen = lazyScreen(() => import('../screens/GroupConversationScreen'));
const ContactProfileScreen = lazyScreen(() => import('../screens/ContactProfileScreen'));
const UnsupportedEntityScreen = lazyScreen(() => import('../screens/UnsupportedEntityScreen'));
const NotificationsScreen = lazyScreen(() => import('../screens/NotificationsScreen'));
const ProfileScreen = lazyScreen(() => import('../screens/account/ProfileScreen'));
const WalletsScreen = lazyScreen(() => import('../screens/account/WalletsScreen'));
const InvitationKeysScreen = lazyScreen(() => import('../screens/account/InvitationKeysScreen'));
const AdvancedScreen = lazyScreen(() => import('../screens/account/AdvancedScreen'));
const NotificationServerScreen = lazyScreen(
  () => import('../screens/account/NotificationServerScreen'),
);
const BubbleStyleScreen = lazyScreen(() => import('../screens/account/BubbleStyleScreen'));
const ProfilerScreen = lazyScreen(() => import('../screens/account/ProfilerScreen'));
const MessageSettingsScreen = lazyScreen(() => import('../screens/account/MessageSettingsScreen'));
const NostrScreen = lazyScreen(() => import('../screens/account/NostrScreen'));
const RelayDetailsScreen = lazyScreen(() => import('../screens/account/RelayDetailsScreen'));
const OnChainScreen = lazyScreen(() => import('../screens/account/OnChainScreen'));
const DisplayLanguageScreen = lazyScreen(() => import('../screens/account/DisplayLanguageScreen'));
const PickerScreen = lazyScreen(() => import('../screens/account/PickerScreen'));
const DisplayScreen = lazyScreen(() => import('../screens/account/DisplayScreen'));
const ShopAlertsScreen = lazyScreen(() => import('../screens/account/ShopAlertsScreen'));
const MutedAccountsScreen = lazyScreen(() => import('../screens/account/MutedAccountsScreen'));
const NotificationSettingsScreen = lazyScreen(
  () => import('../screens/account/NotificationSettingsScreen'),
);
const SecurityScreen = lazyScreen(() => import('../screens/account/SecurityScreen'));
const KeyBackupScreen = lazyScreen(() => import('../screens/account/KeyBackupScreen'));
const AboutScreen = lazyScreen(() => import('../screens/account/AboutScreen'));

let __appNavigatorFirstRenderLogged = false;

/**
 * Imperative navigation ref consumed by `App.tsx`'s Linking listener so
 * incoming `lightning:LNURL…` URIs (NFC tag tap, deep link from another
 * app) can route to HuntFoundScreen without React-Navigation's static
 * `linking` config — which doesn't fit a non-path-segmented URI scheme
 * cleanly. Use `navigateToHuntFound(lnurl)` from outside the React tree.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

/**
 * Open the SendSheet on the Home (wallet) tab pre-filled with a pay
 * payload — a bolt11 invoice (`lnbc…`), a Lightning Address (`user@host`),
 * or a resolved LNURL-pay endpoint URL. Consumed by `App.tsx`'s Linking
 * listener for scan-to-pay (#756), the outbound mirror of
 * `navigateToHuntFound` (scan-to-claim / withdraw, #341).
 *
 * HomeScreen reads `route.params.sendToAddress` and feeds it straight into
 * SendSheet's `processInput`, which already decodes bolt11 + Lightning
 * Address. Returns false if the nav tree isn't mounted yet so the caller
 * can retry on cold start.
 */
export const navigateToSend = (initialAddress: string): boolean => {
  if (!navigationRef.isReady()) return false;
  navigationRef.navigate('Main', {
    screen: 'MainTabs',
    params: { screen: 'Home', params: { sendToAddress: initialAddress } },
  });
  return true;
};

export const navigateToHuntFound = (lnurl: string): boolean => {
  if (!navigationRef.isReady()) return false;
  navigationRef.navigate('Main', {
    screen: 'MainTabs',
    params: {
      screen: 'Explore',
      params: { screen: 'HuntFound', params: { lnurl } },
    },
  });
  return true;
};

// Navigate to a specific Piggy listing by coord (`kind:pubkey:d`).
// Entry-points: the App.tsx Linking listener for
// `lightningpiggy://hunt/<coord>` AND `nostr:naddr1...` deep links
// emitted by the multi-record NFC tags (#73).
export const navigateToHuntPiggyDetail = (coord: string): boolean => {
  if (!navigationRef.isReady()) return false;
  // Set the Explore stack state explicitly so back from HuntPiggyDetail
  // walks through Hunt (Geo-caches list) → ExploreHome, matching the
  // user's mental model. Pre-fix the nested `navigate(..., { screen:
  // 'HuntPiggyDetail' })` shortcut left the Explore stack with only
  // HuntPiggyDetail at index 0 — back-press exited Explore to the
  // previous tab (usually Home), and Explore-tab-tap was a no-op
  // because there was nothing to pop. Bug spotted on Pixel: "back
  // goes to home — not to Geo-caches".
  navigationRef.navigate('Main', {
    screen: 'MainTabs',
    params: {
      screen: 'Explore',
      params: {
        state: {
          index: 2,
          routes: [
            { name: 'ExploreHome' },
            { name: 'Hunt' },
            { name: 'HuntPiggyDetail', params: { coord } },
          ],
        },
      },
    },
  });
  return true;
};

// Open a contact's full-page profile from outside the React tree —
// the App.tsx deep-link / NFC handler for `nostr:npub…` / `nostr:nprofile…`
// (#754). `contact` is a ready-built ContactProfileBodyData; when the
// kind-0 fetch hasn't resolved yet the caller passes a pubkey-only stub
// and the screen fills in the bio + Lightning address itself. Returns
// false until the nav tree is ready so a cold-start tap can retry.
export const navigateToContactProfile = (contact: ContactProfileBodyData): boolean => {
  if (!navigationRef.isReady()) return false;
  navigationRef.navigate('ContactProfile', { contact });
  return true;
};

// Graceful fallback for a scanned tag / nostr: link whose entity type
// has no in-app screen (e.g. a kind-1 note, or a `nostr:` URI we can't
// decode). Mirrors the Hunt deep-link retry contract — returns false
// until the nav tree mounts. Used by the App.tsx nostr: router (#754).
export const navigateToUnsupportedEntity = (entity: string, detail?: string): boolean => {
  if (!navigationRef.isReady()) return false;
  navigationRef.navigate('UnsupportedEntity', { entity, detail });
  return true;
};

/**
 * Route from a tapped OS notification (#279). Reads the `data` payload the
 * notificationService attached and opens the relevant surface:
 *  - dm            → the 1:1 Conversation thread
 *  - group         → the GroupConversation thread
 *  - payment / zap → the Home (wallet) tab
 *  - mention       → the Notifications screen (notification watcher push)
 *  - keyBackup     → Back up your key for that account (#1546)
 *
 * Called from the notification-response listener in App.tsx. Returns false
 * if the nav tree isn't ready yet (caller retries on cold start).
 */
// Bumped per handled notification tap, so a newer tap cancels an older one's
// pending wrap resolution.
let notificationNavGeneration = 0;

export const navigateFromNotification = (
  data: NotificationData & { kind?: string; name?: string },
): boolean => {
  if (!navigationRef.isReady()) return false;
  // A message alert for another signed-in account would open that peer's
  // thread under the wrong identity: show the list instead (#1154).
  // Cold start: the tap can arrive before the identity has hydrated. Unknown is
  // not "another account" — report not-ready so the caller retries.
  if (
    (data.kind === 'dm' || data.kind === 'group' || data.threadKind) &&
    data.owner &&
    !getActivePubkey()
  )
    return false;
  // Each handled tap supersedes any earlier one still resolving a wrap (#1154);
  // counted only once it's actually routed, not per not-ready retry.
  const generation = ++notificationNavGeneration;
  if (isForAnotherAccount({ ...data, kind: data.threadKind ?? data.kind }, getActivePubkey())) {
    navigationRef.navigate('Main', { screen: 'MainTabs', params: { screen: 'Messages' } });
    return true;
  }
  if (data.myOrderId && data.orderSellerPubkey) {
    navigationRef.navigate(
      'Main',
      orderNavigationTarget('MarketMyOrders', {
        orderId: data.myOrderId,
        sellerPubkey: data.orderSellerPubkey,
      }),
    );
    return true;
  }
  if ((data.shopOrderId || data.shopEventId) && data.shopBuyerPubkey) {
    navigationRef.navigate(
      'Main',
      orderNavigationTarget('MarketShopOrders', {
        orderId: data.shopOrderId,
        eventId: data.shopEventId,
        buyerPubkey: data.shopBuyerPubkey,
      }),
    );
    return true;
  }
  if (data.conversationPubkey || data.groupId || data.marmotGroupId) {
    return routeNotificationMessage(data, {
      getActivePubkey,
      getGroup: (groupId) => {
        const session = getMarmotSession();
        return session?.pubkey.toLowerCase() === getActivePubkey()?.toLowerCase()
          ? session?.getGroup(groupId)
          : undefined;
      },
      navigate: (target) => {
        if (target.screen === 'Messages')
          navigationRef.navigate('Main', { screen: 'MainTabs', params: { screen: 'Messages' } });
        else if (target.screen === 'Conversation')
          navigationRef.navigate(target.screen, target.params);
        else navigationRef.navigate(target.screen, target.params);
      },
      currentRoute: () => navigationRef.getCurrentRoute()?.name,
      subscribeState: (report) => navigationRef.addListener('state', report),
      shouldStop: () => generation !== notificationNavGeneration,
    });
  }

  if (data.kind === 'market' && data.listingCoord) {
    if (!getActivePubkey()) return false;
    if (data.owner && data.owner !== getActivePubkey()) {
      navigationRef.navigate('Notifications');
      return true;
    }
    const owner = getActivePubkey();
    const urls = getCurrentUserReadRelays();
    const controller = new AbortController();
    void resolveActivityListing(
      data.listingCoord,
      urls.length ? urls : enabledAppRelays('default', DEFAULT_RELAYS),
      controller.signal,
    )
      .then((product) => {
        if (generation !== notificationNavGeneration || owner !== getActivePubkey()) return;
        if (product)
          navigationRef.navigate('ProductDetail', {
            productId: product.id,
            product,
            feedbackTab: data.feedbackTab,
          });
        else navigationRef.navigate('Notifications');
      })
      .catch(() => {
        if (generation === notificationNavGeneration && owner === getActivePubkey())
          navigationRef.navigate('Notifications');
      });
    return true;
  }

  // Find-log on one of my caches (#740) → open that cache detail. The
  // background detect-and-ping path passes the sentinel `__background__`
  // coord (it didn't resolve to a specific cache) — fall through to the
  // Geo-caches list in that case instead of pushing a doomed detail.
  if (data.kind === 'cache') {
    if (data.cacheCoord && data.cacheCoord !== '__background__') {
      return navigateToHuntPiggyDetail(data.cacheCoord);
    }
    navigationRef.navigate('Main', {
      screen: 'MainTabs',
      params: { screen: 'Explore', params: { screen: 'Hunt' } },
    });
    return true;
  }
  // Generic message ping with no thread id (the background detect-and-ping
  // path, which doesn't decrypt) → open the Messages list. With a wrap id,
  // then open that message's conversation once the app has decrypted it —
  // unless the user has moved on from the list meanwhile (#1154).
  if (data.kind === 'dm' || data.kind === 'group' || data.threadKind) {
    navigationRef.navigate('Main', { screen: 'MainTabs', params: { screen: 'Messages' } });
    const owner = data.owner ?? getActivePubkey();
    // Only for the active account: another account's stored wrap would open
    // a conversation under the wrong identity, so its alert stays on the list.
    if (
      (data.wrapId || (data.marmotPush && data.historyId)) &&
      owner &&
      owner === getActivePubkey()
    ) {
      // Every route change, so leaving the list is seen even between polls.
      const tracker = createRouteLeaveTracker('Messages');
      const report = () => tracker.onRoute(navigationRef.getCurrentRoute()?.name);
      report();
      const unsubscribe = navigationRef.addListener('state', report);
      const cancelled = () =>
        tracker.movedOn() ||
        getActivePubkey() !== owner ||
        generation !== notificationNavGeneration;
      const resolved = data.wrapId
        ? resolveWrapConversation(owner, data.wrapId, {
            shouldStop: cancelled,
            fetchNow: () => catchUpNotifiedWrap(owner, data.wrapId!),
          }).then((target) =>
            target
              ? {
                  ...(target.shopOrderId || target.myOrderId || target.conversationPubkey
                    ? target
                    : { conversationPubkey: target.pubkey, protocol: target.protocol }),
                  threadKind: 'dm' as const,
                  messageId: data.messageId ?? data.wrapId,
                  owner,
                }
              : null,
          )
        : resolveStoredNotificationTarget(owner, data.historyId!, { shouldStop: cancelled });
      void resolved.then((target) => {
        unsubscribe();
        if (target && !cancelled()) navigateFromNotification({ ...target, name: data.name });
      });
    }
    return true;
  }
  // Weekly key-backup reminder (#1546) → Back up your key for that account.
  // The screen handles a non-active account itself, so no switch is needed.
  if (data.kind === 'keyBackup' && data.keyBackupPubkey) {
    navigationRef.navigate('Main', {
      screen: 'AccountKeyBackup',
      params: { pubkey: data.keyBackupPubkey },
    });
    return true;
  }
  // A mention (notification watcher push) → the Notifications screen.
  if (data.kind === 'mention') {
    navigationRef.navigate('Notifications');
    return true;
  }
  // payment / zap (or anything else) → wallet home.
  navigationRef.navigate('Main', { screen: 'MainTabs', params: { screen: 'Home' } });
  return true;
};

/**
 * Keep notificationService's "active thread" in sync with the focused route
 * (#279), so DM / group notifications are suppressed for the thread the user
 * is currently viewing. Done centrally here (off the back of the existing
 * onStateChange) rather than per-screen, to avoid growing the over-cap
 * Conversation / GroupConversation screen files (#703).
 */
/** Fetch and store the message an alert was raised for (#1325). Loaded on
 * demand so the inbox ingest stays out of the navigator's startup path. */
function catchUpNotifiedWrap(owner: string, wrapId: string): Promise<void> {
  const { catchUpWrapById } =
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep the inbox ingest out of startup.
    require('../services/backgroundDmIngest') as typeof import('../services/backgroundDmIngest');
  return catchUpWrapById(owner, wrapId);
}

function syncActiveThreadFromNav(): void {
  const route = navigationRef.getCurrentRoute();
  if (route?.name === 'Conversation') {
    const params = route.params as { pubkey?: string; protocol?: DmProtocol } | undefined;
    setActiveThread(
      params?.pubkey ? dmThreadId(params.pubkey, params.protocol ?? DEFAULT_DM_PROTOCOL) : null,
    );
  } else if (route?.name === 'GroupConversation') {
    setActiveThread((route.params as { groupId?: string } | undefined)?.groupId ?? null);
  } else {
    setActiveThread(null);
  }
  // Active-cache suppression (#740) — if the focused screen is the
  // detail view for a specific cache, find-logs against that coord stay
  // silent. Independent of the thread gate so a DM and a cache can't
  // collide on the same identifier.
  if (route?.name === 'HuntPiggyDetail') {
    setActiveCache((route.params as { coord?: string } | undefined)?.coord ?? null);
  } else {
    setActiveCache(null);
  }
  dismissNotificationsForFocusedRoute();
}

/**
 * Clear the delivered notifications the focused screen has just shown the
 * user, so the tray entry and launcher dot go away (#1142). Runs on every
 * route change and (staggered) on app resume, for a screen left open.
 */
export function dismissNotificationsForFocusedRoute(): void {
  const route = navigationRef.isReady() ? navigationRef.getCurrentRoute() : undefined;
  const params = route?.params as
    | { pubkey?: string; protocol?: DmProtocol; groupId?: string; coord?: string }
    | undefined;
  let target: NotificationTarget | null = null;
  if (route?.name === 'Conversation' && params?.pubkey) {
    const protocol = params.protocol ?? DEFAULT_DM_PROTOCOL;
    target = { conversationPubkey: params.pubkey, conversationProtocol: protocol };
  } else if (route?.name === 'GroupConversation' && params?.groupId) {
    target = { groupId: params.groupId };
  } else if (route?.name === 'HuntPiggyDetail' && params?.coord) {
    target = { cacheCoord: params.coord };
  } else if (route?.name === 'Messages') {
    target = { genericMessages: true };
    // What a Marmot push placeholder announced is on this list now: its
    // nameless "New message" history row goes, not just its tray entry.
    void dropMarmotPushAlerts();
  }
  if (target) {
    void dismissNotificationsFor(target);
    void markHistoryReadFor(target);
  }
}

const RelaySettingsStack = createNativeStackNavigator<RelaySettingsParamList>();
function RelaySettingsNavigator() {
  return (
    <RelayListEditorProvider>
      <RelaySettingsStack.Navigator screenOptions={{ headerShown: false }}>
        <RelaySettingsStack.Screen name="RelaySettingsList" component={NostrScreen} />
        <RelaySettingsStack.Screen name="RelayDetails" component={RelayDetailsScreen} />
      </RelaySettingsStack.Navigator>
    </RelayListEditorProvider>
  );
}

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<MainTabParamList>();
const ExploreStack = createNativeStackNavigator<ExploreStackParamList>();
const AccountDrawer = createDrawerNavigator<AccountDrawerParamList>();

function ExploreStackNavigator() {
  return (
    <ExploreStack.Navigator screenOptions={{ headerShown: false }}>
      <ExploreStack.Screen name="ExploreHome" component={ExploreHomeScreen} />
      <ExploreStack.Screen name="Lessons" component={LessonsScreen} />
      <ExploreStack.Screen name="CourseDetail" component={CourseDetailScreen} />
      <ExploreStack.Screen name="MissionDetail" component={MissionDetailScreen} />
      <ExploreStack.Screen name="Map" component={MapScreen} />
      <ExploreStack.Screen name="Places" component={PlacesScreen} />
      <ExploreStack.Screen name="PlaceDetail" component={PlaceDetailScreen} />
      <ExploreStack.Screen name="Market" component={MarketScreen} />
      <ExploreStack.Screen name="MarketProductDetail" component={MarketProductDetailScreen} />
      <ExploreStack.Screen name="MarketMyShop" component={MarketMyShopScreen} />
      <ExploreStack.Screen name="MarketMyOrders" component={MarketMyOrdersScreen} />
      <ExploreStack.Screen name="MarketShopCurrencies" component={MarketShopCurrenciesScreen} />
      <ExploreStack.Screen name="MarketShopShipping" component={MarketShopShippingScreen} />
      <ExploreStack.Screen name="MarketShopCollections" component={MarketShopCollectionsScreen} />
      <ExploreStack.Screen name="MarketShopListings" component={MarketShopListingsScreen} />
      <ExploreStack.Screen name="MarketShopOrders" component={MarketShopOrdersScreen} />
      <ExploreStack.Screen name="MarketLikedItems" component={MarketLikedItemsScreen} />
      <ExploreStack.Screen name="MarketListingEditor" component={MarketListingEditorScreen} />
      <ExploreStack.Screen name="Hunt" component={HuntScreen} />
      <ExploreStack.Screen name="HuntCreate" component={HuntCreateScreen} />
      <ExploreStack.Screen name="HuntFound" component={HuntFoundScreen} />
      <ExploreStack.Screen name="HuntPiggyDetail" component={HuntPiggyDetailScreen} />
      <ExploreStack.Screen name="MyPiglets" component={MyPigletsScreen} />
      <ExploreStack.Screen name="HuntLeaderboard" component={HuntLeaderboardScreen} />
      <ExploreStack.Screen name="Events" component={EventsScreen} />
      <ExploreStack.Screen name="EventDetail" component={EventDetailScreen} />
    </ExploreStack.Navigator>
  );
}

function HomeTabs() {
  useSellerActivityChecks('resume');
  const { colors } = useTheme();
  const t = useTranslation();
  // Reserve the real system-bar inset so the edge-to-edge tab bar clears gesture/3-button nav (see #862).
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        // Lazy-mount tabs so cold-start only pays for the focused one.
        // Without this, react-navigation v7 mounts every Tab.Screen at
        // boot — and the Explore stack alone fires a ~3 MB BTC Map
        // fetch, two Nostr relay subscriptions, and a foreground
        // location request before the user has ever tapped Explore.
        // Combined with `freezeOnBlur: true` below, screens still hold
        // their state across tab switches once they've been visited.
        lazy: true,
        freezeOnBlur: true,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.divider,
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.brandPink,
        tabBarInactiveTintColor: colors.textSupplementary,
        tabBarLabelStyle: {
          fontSize: 12,
          fontWeight: '600',
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{
          tabBarLabel: t('tabs.wallets'),
          tabBarButtonTestID: 'tab-wallets',
          tabBarAccessibilityLabel: 'Wallets tab',
          tabBarIcon: ({ focused, color, size }) => (
            <Wallet size={size} color={color} strokeWidth={focused ? 2.5 : 2} />
          ),
        }}
        listeners={{
          tabPress: () => perfTabTap('Home'),
          focus: () => perfTabRendered('Home'),
          blur: () => perfTabHidden('Home'),
        }}
      />
      <Tab.Screen
        name="Messages"
        component={MessagesScreen}
        options={{
          tabBarLabel: t('tabs.messages'),
          tabBarButtonTestID: 'tab-messages',
          tabBarAccessibilityLabel: 'Messages tab',
          tabBarIcon: ({ focused, color, size }) => (
            <MessageCircle size={size} color={color} strokeWidth={focused ? 2.5 : 2} />
          ),
        }}
        listeners={{
          tabPress: () => perfTabTap('Messages'),
          focus: () => perfTabRendered('Messages'),
          blur: () => perfTabHidden('Messages'),
        }}
      />
      <Tab.Screen
        name="Explore"
        component={ExploreStackNavigator}
        options={{
          tabBarLabel: t('tabs.explore'),
          tabBarButtonTestID: 'tab-explore',
          tabBarAccessibilityLabel: 'Explore tab',
          tabBarIcon: ({ focused, color, size }) => (
            <Compass size={size} color={color} strokeWidth={focused ? 2.5 : 2} />
          ),
        }}
        listeners={({ navigation }) => ({
          // Pop the Explore sub-stack back to its root every time the
          // tab is tapped — whether Explore is already focused (a
          // double-tap on the active tab) OR being switched into from
          // another tab. Pre-fix this only fired when already focused,
          // so an NFC-tap deep-link or wizard navigation that left
          // HuntPiggyDetail / HuntCreate on the stack would resume on
          // that screen the next time the user hit the Explore tab
          // from elsewhere — even though their mental model is "tap
          // the tab to go to Explore".
          //
          // The earlier version used navigation.navigate('Explore',
          // { screen: 'ExploreHome' }) which RN treats as a no-op when
          // Explore is already focused. Dispatching StackActions.popToTop
          // hits the inner Explore stack navigator directly and pops
          // every screen above ExploreHome regardless of current focus.
          tabPress: (e) => {
            perfTabTap('Explore');
            const state = navigation.getState();
            const tabRoute = state?.routes.find((r) => r.name === 'Explore');
            const subState = tabRoute?.state;
            const exploreIsFocused = state.routes[state.index]?.name === 'Explore';
            // Gated on __DEV__ so the diagnostic doesn't leak into
            // perf-instrumented release builds — EXPO_PUBLIC_KEEP_PERF_LOGS
            // disables babel's transform-remove-console plugin, which
            // would otherwise strip these (Copilot #578 r1 catch).
            if (__DEV__) {
              console.log(
                `[Tab:Explore] tabPress focused=${exploreIsFocused} subIdx=${subState?.index} subKey=${subState?.key} routes=[${(subState?.routes ?? []).map((r) => r.name).join(',')}]`,
              );
            }
            if (subState && typeof subState.index === 'number' && subState.index > 0) {
              if (exploreIsFocused) e.preventDefault();
              if (__DEV__) {
                console.log(`[Tab:Explore] dispatching popToTop target=${subState.key}`);
              }
              navigation.dispatch({
                ...StackActions.popToTop(),
                target: subState.key,
              });
            }
          },
          focus: () => perfTabRendered('Explore'),
          blur: () => perfTabHidden('Explore'),
        })}
      />
      <Tab.Screen
        name="Friends"
        component={FriendsScreen}
        options={{
          tabBarLabel: t('tabs.friends'),
          tabBarButtonTestID: 'tab-friends',
          tabBarAccessibilityLabel: 'Friends tab',
          tabBarIcon: ({ focused, color, size }) => (
            <Users size={size} color={color} strokeWidth={focused ? 2.5 : 2} />
          ),
        }}
        listeners={{
          tabPress: () => perfTabTap('Friends'),
          focus: () => perfTabRendered('Friends'),
          blur: () => perfTabHidden('Friends'),
        }}
      />
    </Tab.Navigator>
  );
}

/**
 * Drawer wrapping the main tabs + per-section account screens. Tapping
 * the avatar in the tab header opens the drawer; tapping a row closes
 * the drawer and navigates to the matching section screen. See issue
 * #100 for the Primal/Damus-style spec.
 */
function MainDrawer() {
  const { width } = useWindowDimensions();
  const { colors } = useTheme();
  // Drawer width sized to fit the menu comfortably (not a fixed 50%).
  // Capped so it still looks like a drawer on tablets.
  const drawerWidth = Math.min(Math.max(280, width * 0.65), 360);

  return (
    <MarketShortcutsProvider>
      <AccountDrawer.Navigator
        initialRouteName="MainTabs"
        drawerContent={(props) => <AccountDrawerContent {...props} />}
        screenOptions={{
          headerShown: false,
          drawerType: 'front',
          drawerPosition: 'right',
          drawerStyle: { width: drawerWidth, backgroundColor: colors.surface },
          swipeEdgeWidth: 32,
        }}
      >
        <AccountDrawer.Screen name="MainTabs" component={HomeTabs} />
        <AccountDrawer.Screen name="AccountProfile" component={ProfileScreen} />
        <AccountDrawer.Screen name="AccountWallets" component={WalletsScreen} />
        <AccountDrawer.Screen name="AccountAdvanced" component={AdvancedScreen} />
        <AccountDrawer.Screen
          name="AccountNotificationServer"
          component={NotificationServerScreen}
        />
        <AccountDrawer.Screen name="AccountBubbleStyle" component={BubbleStyleScreen} />
        <AccountDrawer.Screen name="AccountProfiler" component={ProfilerScreen} />
        <AccountDrawer.Screen name="AccountMessages" component={MessageSettingsScreen} />
        <AccountDrawer.Screen name="AccountNostr" component={RelaySettingsNavigator} />
        <AccountDrawer.Screen name="AccountInvitationKeys" component={InvitationKeysScreen} />
        <AccountDrawer.Screen name="AccountOnChain" component={OnChainScreen} />
        <AccountDrawer.Screen name="AccountDisplayLanguage" component={DisplayLanguageScreen} />
        <AccountDrawer.Screen name="AccountCurrency" component={DisplayScreen} />
        <AccountDrawer.Screen name="AccountShopAlerts" component={ShopAlertsScreen} />
        <AccountDrawer.Screen name="AccountMutedAccounts" component={MutedAccountsScreen} />
        <AccountDrawer.Screen name="AccountNotifications" component={NotificationSettingsScreen} />
        <AccountDrawer.Screen name="AccountSecurity" component={SecurityScreen} />
        <AccountDrawer.Screen name="AccountKeyBackup" component={KeyBackupScreen} />
        <AccountDrawer.Screen name="AccountAbout" component={AboutScreen} />
      </AccountDrawer.Navigator>
    </MarketShortcutsProvider>
  );
}

export default function AppNavigator() {
  if (!__appNavigatorFirstRenderLogged) {
    __appNavigatorFirstRenderLogged = true;
    perfLog('AppNavigator first render');
  }
  const { isLoading } = useWallet();
  const { scheme, colors } = useTheme();

  // Persist + restore navigation state across cold-starts so the user
  // lands back on the tab / screen they left (#598). The OS killing
  // the backgrounded process — common on GrapheneOS, also stock Android
  // under memory pressure — would otherwise drop them on Home every
  // time. A pending deep-link short-circuits the restore: the existing
  // Linking handler in App.tsx routes the user where the URL says.
  const [isRestoringNavState, setIsRestoringNavState] = useState(true);
  const [initialNavState, setInitialNavState] = useState<NavigationState | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl) return;
        const saved = await loadPersistedNavigationState();
        if (!cancelled && saved) setInitialNavState(saved);
      } catch {
        // Linking.getInitialURL() can reject on platforms where the
        // intent-resolution chain isn't ready yet (rare, but seen on
        // some Android OEMs). Treat it as "no deep-link, no saved
        // state" — the navigator renders its defaults and the user
        // lands on Home.
      } finally {
        if (!cancelled) setIsRestoringNavState(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const navTheme = useMemo(
    () => ({
      dark: scheme === 'dark',
      colors: {
        primary: colors.brandPink,
        background: colors.background,
        card: colors.surface,
        text: colors.textHeader,
        border: colors.divider,
        notification: colors.brandPink,
      },
      fonts: {
        regular: { fontFamily: 'System', fontWeight: '400' as const },
        medium: { fontFamily: 'System', fontWeight: '500' as const },
        bold: { fontFamily: 'System', fontWeight: '700' as const },
        heavy: { fontFamily: 'System', fontWeight: '900' as const },
      },
    }),
    [scheme, colors],
  );

  if (isLoading || isRestoringNavState) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: colors.brandPink }]}>
        <BrandedSpinner size="large" onGradient />
      </View>
    );
  }

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navTheme}
      initialState={initialNavState}
      // A restored initialState doesn't fire onStateChange: sync (and clear the
      // restored screen's notifications, #1142) once the tree is ready.
      onReady={syncActiveThreadFromNav}
      onStateChange={(state) => {
        // Fire-and-forget — failures are swallowed inside the util so
        // a flaky AsyncStorage write can't crash navigation.
        void persistNavigationState(state);
        // Suppress notifications for the thread the user is now viewing.
        syncActiveThreadFromNav();
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Main" component={MainDrawer} />
        <Stack.Screen name="SettingsPicker" component={PickerScreen} />
        <Stack.Screen
          name="Conversation"
          component={ConversationScreen}
          // One screen instance per (partner, protocol) thread: navigating to a
          // different thread (e.g. from a notification) pushes a fresh screen
          // instead of re-using this one, so optimistic rows and in-flight send
          // callbacks can never land in another person's thread.
          getId={({ params }) => dmThreadId(params.pubkey, params.protocol ?? DEFAULT_DM_PROTOCOL)}
        />
        <Stack.Screen name="Groups" component={GroupsScreen} />
        <Stack.Screen name="GroupConversation" component={GroupConversationScreen} />
        <Stack.Screen name="ChatInfo" component={ChatInfoScreen} />
        <Stack.Screen name="ChatMedia" component={ChatMediaScreen} />
        <Stack.Screen name="ContactProfile" component={ContactProfileScreen} />
        <Stack.Screen
          name="ProductDetail"
          // Same screen as Explore's MarketProductDetail; its navigation calls
          // (goBack, navigate('Conversation')) resolve on the root stack too.
          component={MarketProductDetailScreen as unknown as React.ComponentType<object>}
        />
        <Stack.Screen name="UnsupportedEntity" component={UnsupportedEntityScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
