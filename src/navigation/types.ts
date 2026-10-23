import type { GroupProtocol } from '../utils/groupProtocol';
import type { SearchableMessage } from '../utils/chatSearch';
import type { GroupMemberRow } from '../utils/groupMemberRows';
import type { SettingsPickerParams } from '../utils/settingsPicker';
import type { DmProtocol } from '../utils/dmProtocol';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { DrawerNavigationProp } from '@react-navigation/drawer';
import { RouteProp } from '@react-navigation/native';
import { NavigatorScreenParams } from '@react-navigation/native';
import type { ContactProfileBodyData } from '../components/ContactProfileBody';
import type { MarketProduct } from '../data/marketProducts';
import type { MarketMode } from '../utils/marketMode';
import type { LeaderboardEntry } from '../utils/huntLeaderboard';

// Main tab param list
export type MainTabParamList = {
  Home:
    | { sendToAddress?: string; sendToName?: string; sendToPicture?: string; sendToPubkey?: string }
    | undefined;
  Messages: undefined;
  // Explore hosts a sub-stack so the type carries NavigatorScreenParams
  // — that's what lets the Linking listener (App.tsx → navigateToHuntFound
  // in AppNavigator.tsx) target a specific Explore-stack screen like
  // HuntFound from outside the React tree.
  Explore: NavigatorScreenParams<ExploreStackParamList> | undefined;
  Friends: undefined;
};

// Drawer wrapping the main tabs + per-section account screens. MainTabs
// is the initial drawer route, so on launch the user sees the tabs and
// can open the drawer with the top-right avatar (or edge-swipe).
export type AccountDrawerParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList>;
  AccountProfile: undefined;
  AccountWallets: undefined;
  AccountAdvanced: undefined;
  AccountNotificationServer: undefined;
  AccountBubbleStyle: undefined;
  AccountProfiler: undefined;
  AccountMessages: undefined;
  AccountNostr: undefined;
  AccountInvitationKeys: undefined;
  AccountOnChain: undefined;
  /** Experimental Ark wallet (signet), only in EXPO_PUBLIC_ENABLE_ARK=1 builds. */
  AccountArk: undefined;
  AccountDisplayLanguage: undefined;
  /** Currency picker, pushed from Display & language. */
  AccountCurrency: undefined;
  AccountNotifications: undefined;
  AccountShopAlerts: undefined;
  AccountMutedAccounts: undefined;
  AccountSecurity: undefined;
  // Back up your key (#1223). `pubkey` (public, hex) picks the account —
  // defaults to the active one. Never put key material in params.
  AccountKeyBackup: { pubkey?: string } | undefined;
  AccountAbout: undefined;
};

// Root stack
export type RootStackParamList = {
  SettingsPicker: SettingsPickerParams;
  Main: NavigatorScreenParams<AccountDrawerParamList>;
  Conversation: {
    jumpToMessage?: string;
    /** Required so every way in names its thread: rows and notifications pass
     * the thread's own protocol; "chat with this person" goes through
     * `openDirectChat`, which picks Marmot when the peer can receive it. */
    protocol: DmProtocol;
    pubkey: string;
    name: string;
    picture?: string | null;
    lightningAddress?: string | null;
  };
  Groups: undefined;
  GroupConversation: { groupId: string; jumpToMessage?: string };
  ChatInfo: {
    name: string;
    picture?: string | null;
    protocol: GroupProtocol;
    contact?: ContactProfileBodyData;
    groupId?: string;
    members?: GroupMemberRow[];
    chatId: string | null;
    deviceCounts: [string, number][];
    relays: string[];
  };
  ChatMedia: {
    messages?: SearchableMessage[];
    target:
      | { screen: 'Conversation'; params: RootStackParamList['Conversation'] }
      | { screen: 'GroupConversation'; params: RootStackParamList['GroupConversation'] };
  };
  // Full-page friends profile (#435). `phoneContactId` is set when the
  // contact came from the device address book and can be edited inline.
  ContactProfile: {
    contact: ContactProfileBodyData;
    initialTab?: 'posts' | 'media' | 'shop';
    phoneContactId?: string;
  };
  // A Market product page opened from outside the Explore tab — a seller's
  // Products tab or an embedded `nostr:naddr` product card (#1332). Same
  // screen and params as Explore's `MarketProductDetail`, registered on the
  // root stack so Back returns to the profile / note it was opened from.
  ProductDetail: {
    productId: string;
    product?: MarketProduct;
    feedbackTab?: 'comments' | 'reviews';
  };
  // Graceful fallback when a scanned tag / nostr: link resolves to an
  // entity Lightning Piggy can't display. `entity` is a human-readable
  // label for the message + warning log; `detail` carries the raw value.
  UnsupportedEntity: {
    entity: string;
    detail?: string;
  };
  // In-app history of fired notifications (#1143), opened from Home's bell.
  Notifications: undefined;
};

// Explore sub-stack — the renamed Learn tab now hosts a hub plus Lessons
// (existing course content), Map (BTC Map merchants), Hunt (geocaching
// game), and Events (NIP-52 meetups). MainTabParamList above references
// this via NavigatorScreenParams<ExploreStackParamList>; the lexical
// definition order is reversed (forward reference at type level), which
// TypeScript resolves fine — keep the order as-is.
// See plan .claude/plans/look-through-the-issues-squishy-wigderson.md
// for motivation; closes parts of #467 and #468.
// Published kind-37516 listing fields carried into the edit wizard (the
// cross-device source of truth). Named so the wizard's hydration helper can
// share the shape. `createdAt` here is the event envelope `created_at` (last
// publish), which the wizard compares against the local record's `updatedAt`
// to decide which side is fresher (#596 / #681).
export interface HuntCacheFallback {
  coord: string;
  hiderPubkey: string;
  d: string;
  name: string;
  description: string;
  geohash: string | null;
  difficulty: number | null;
  terrain: number | null;
  size: string | null;
  cacheType: string | null;
  hint: string | null;
  imageUrl: string | null;
  createdAt: number;
  expiresAt: number | null;
  waitSeconds: number | null;
  uses: number | null;
  isLpPiggy: boolean;
  payoutSats: number | null;
}

export type ExploreStackParamList = {
  ExploreHome: undefined;
  Lessons: undefined;
  CourseDetail: { courseId: string };
  MissionDetail: { courseId: string; missionId: string };
  // `returnTo` is set only when the Map is opened from a DM conversation's
  // live-location card — it carries that conversation's route so Map's back
  // button returns to the DM rather than the Explore tab. In-stack entry
  // points (Explore/Places/Events/Hunt) omit it and fall back to goBack().
  Map:
    | { returnTo?: { screen: 'Conversation'; params: RootStackParamList['Conversation'] } }
    | undefined;
  Places: undefined;
  PlaceDetail: { placeId: number };
  // Market — Lightning Piggy product grid ("See all" from the Explore Market
  // rail); tiles open MarketProductDetail. Static catalogue today (see
  // src/data/marketProducts.ts, resolved to sellers via src/data/marketVendors.ts).
  // `merchant` (hex pubkey) + `mode` open the grid filtered to one seller —
  // a product page's "More from <seller>" See all (#1542).
  Market: { merchant?: string; mode?: MarketMode } | undefined;
  // Full product page opened from a Market grid tile — product info plus
  // Nostr reviews (kind 31555) + comments (kind 1111). `productId` keys into
  // MARKET_PRODUCTS (see src/data/marketProducts.ts).
  // `preview` renders an unpublished draft from the listing editor: no
  // seller actions, reviews or comments (#1273).
  MarketProductDetail: {
    productId: string;
    product?: MarketProduct;
    preview?: boolean;
    feedbackTab?: 'comments' | 'reviews';
  };
  // Seller side (#1273): the user's own shop, its settings (name, currency,
  // shipping zones) and the listing editor (`dTag` = edit that listing).
  MarketMyShop: undefined;
  // Buyer side: every Gamma order I placed, from the encrypted DM store.
  MarketMyOrders: { orderId: string; sellerPubkey: string } | undefined;
  // My shop hub sub-screens (#1534).
  MarketShopCurrencies: undefined;
  MarketShopShipping: undefined;
  MarketShopCollections: undefined;
  MarketShopListings: undefined;
  MarketShopOrders: { orderId?: string; eventId?: string; buyerPubkey: string } | undefined;
  // `digital` presets a new listing's item type (the "It's a digital item"
  // way past the shipping gate).
  MarketListingEditor: { dTag?: string; returnToMyShop?: boolean; digital?: boolean } | undefined;
  // The viewer's liked listings (#1541) — their NIP-25 likes, as a grid.
  MarketLikedItems: undefined;
  Hunt: undefined;
  // `piggyId` opens the wizard in edit mode for an existing HiddenPiggy —
  // reuses the same screen, pre-fills every field, and on save replaces
  // the local record + re-emits the kind 37516 listing under the same
  // `d` tag. Omit to create a new Piggy.
  //
  // `fallbackCache` (optional) is the published ParsedCache as known to
  // the caller — used to hydrate the wizard when the local HiddenPiggy
  // record is missing on this device but the active identity is the
  // event's author (#596 cross-device edit). Plain-JSON shape, safe to
  // serialise through navigation state.
  HuntCreate:
    | {
        piggyId?: string;
        fallbackCache?: HuntCacheFallback;
      }
    | undefined;
  // `coord` (optional) is the kind 37516 cache coord the finder is
  // claiming against. When supplied, recordClaim stores it as piggyId
  // so HuntPiggyDetailScreen can unlock the find-log composer via
  // lastClaimForPiggyId(coord). Omit only on the legacy deep-link
  // entry path where we don't know the coord yet.
  HuntFound: { lnurl: string; coord?: string };
  // `openComposer` (optional) bounces the find-log compose UI open on
  // mount — used by HuntFoundScreen after a successful claim so the
  // finder doesn't have to remember to tap the compose button.
  HuntPiggyDetail: { coord: string; openComposer?: boolean };
  MyPiglets: undefined;
  // Leaderboard data is passed as route params so HuntLeaderboardScreen
  // can render immediately without opening its own relay subscriptions —
  // HuntScreen's useHuntCommunity instance (via HuntCommunitySections)
  // already owns the subscription pair; a second instance would duplicate
  // ~400 relay events through the JS thread (#1028).
  //
  // Staleness trade-off: params are frozen at tap time. That is acceptable
  // for a leaderboard page — the user tapped "View Leaderboard" to inspect
  // the board as it stood, and the board updates at most once per 1.5 s
  // settle window while Hunt is focused, so lag is negligible in practice.
  HuntLeaderboard: {
    hiderLeaderboard: LeaderboardEntry[];
    finderLeaderboard: LeaderboardEntry[];
    loading: boolean;
  };
  Events: undefined;
  EventDetail: { coord: string };
};

// Navigation prop shortcuts
export type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
export type ExploreNavigation = NativeStackNavigationProp<ExploreStackParamList>;
export type AccountDrawerNavigation = DrawerNavigationProp<AccountDrawerParamList>;

// Route prop shortcuts
export type CourseDetailRoute = RouteProp<ExploreStackParamList, 'CourseDetail'>;
export type MarketProductDetailRoute = RouteProp<ExploreStackParamList, 'MarketProductDetail'>;
export type MarketListingEditorRoute = RouteProp<ExploreStackParamList, 'MarketListingEditor'>;
export type MarketRoute = RouteProp<ExploreStackParamList, 'Market'>;
export type MissionDetailRoute = RouteProp<ExploreStackParamList, 'MissionDetail'>;
export type GroupConversationRoute = RouteProp<RootStackParamList, 'GroupConversation'>;
export type HuntLeaderboardRoute = RouteProp<ExploreStackParamList, 'HuntLeaderboard'>;

/** One draft session shared by the Nostr settings list and relay details. */
export type RelaySettingsParamList = {
  RelaySettingsList: undefined;
  RelayDetails: { url: string; kind: 'nip65' | 'inbox' | 'readonly' };
};
