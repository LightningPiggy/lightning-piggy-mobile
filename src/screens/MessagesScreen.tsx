import { MarmotInvitations } from '../components/MarmotInvitations';
import { Nip171Invitations } from '../components/Nip171Invitations';
import { preferredDmProtocol } from '../services/preferredDmProtocol';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import { useLocale } from '../contexts/LocaleContext';
import { useLiveMessageIndicator } from '../hooks/useLiveMessageIndicator';
import NewMessagesPill from '../components/NewMessagesPill';
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import DmProtocolPickerSheet from '../components/DmProtocolPickerSheet';
import { DEFAULT_DM_PROTOCOL, dmMessageThreadId, type DmProtocol } from '../utils/dmProtocol';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  InteractionManager,
  AppState,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import BrandPatternBackground from '../components/BrandPatternBackground';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import Svg, { Path } from 'react-native-svg';
import { Clock, Search, X, Zap } from 'lucide-react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNavigation, CompositeNavigationProp, useFocusEffect } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useNostr, useNostrContacts, useNostrDmInbox } from '../contexts/NostrContext';
import { useWallet } from '../contexts/WalletContext';
import { useGroups } from '../contexts/GroupsContext';
import { useTrustGraph } from '../contexts/TrustGraphContext';
import WebOfTrustChip from '../components/WebOfTrustChip';
import WebOfTrustBottomSheet from '../components/WebOfTrustBottomSheet';
import ConversationRow from '../components/ConversationRow';
import GroupRow from '../components/GroupRow';
import { useMentionedGroupIds } from '../hooks/useMentionedGroupIds';
import FriendPickerSheet, { type PickedFriend } from '../components/FriendPickerSheet';
import ContactProfileSheet from '../components/ContactProfileSheet';
import type { ContactProfileBodyData } from '../components/ContactProfileBody';
import CreateGroupSheet from '../components/CreateGroupSheet';
import type { GroupSummary } from '../types/groups';
import { MessageCircle } from 'lucide-react-native';
import TabHeader from '../components/TabHeader';
import AmberPermissionBanner from '../components/AmberPermissionBanner';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import {
  buildConversationSummaries,
  buildDmSummaries,
  conversationPreview,
  mergeSummaries,
  type ConversationSummary,
} from '../utils/conversationSummaries';
import { useStableRowIdentity } from '../utils/stableRowIdentity';
import { useNonFollowProfiles } from '../hooks/useNonFollowProfiles';
import { useAccountDeferredValue } from '../contexts/useAccountState';
import { EMPTY_DM_INBOX } from '../contexts/dmInboxScope';
import { useFailedMarmotInvites } from '../hooks/useFailedMarmotInvites';
import { withMarmotInviteRows } from '../utils/marmotInviteRows';
import type { NostrContact } from '../types/nostr';
// __DEV__-only marketplace-order fixture seeding. The helper is a no-op outside
// __DEV__ and is only invoked behind a __DEV__-gated button, so it never runs at
// runtime in a release build (the module may still be present in the bundle).
import { seedDevOrderConversation } from '../utils/devSeedOrders';
import { createMessagesScreenStyles } from '../styles/MessagesScreen.styles';
import type { MainTabParamList, RootStackParamList } from '../navigation/types';

type MessagesNavigation = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Messages'>,
  NativeStackNavigationProp<RootStackParamList>
>;

const NO_CONTACTS: NostrContact[] = [];
const EMPTY_LIST_INPUTS = { dmInbox: EMPTY_DM_INBOX, contacts: NO_CONTACTS };

const MessagesScreen: React.FC = () => {
  const { formatLocale } = useLocale();
  const colors = useThemeColors();
  const t = useTranslation();
  // First-render marker: fires once per mount when the first commit lands. Distinct from refreshDmInbox completion (which fires later, after relay round-trip). Used by scripts/perf-startup.sh to measure tap-to-render latency for tab-messages.
  const messagesRenderLoggedRef = useRef(false);
  useEffect(() => {
    if (messagesRenderLoggedRef.current) return;
    messagesRenderLoggedRef.current = true;
    console.log(`[Perf] MessagesScreen first render`);
  }, []);
  const styles = useMemo(() => createMessagesScreenStyles(colors), [colors]);
  const navigation = useNavigation<MessagesNavigation>();
  const { isLoggedIn, refreshProfile, fetchProfilesForPubkeys, pubkey } = useNostr();
  const { dmInbox, refreshDmInbox, armLiveDmSub } = useNostrDmInbox();
  const { contacts, refreshContacts } = useNostrContacts();
  const { wallets } = useWallet();
  const { groupSummaries, effectiveWotTier } = useGroups();
  // `trustSetForTier` rather than the raw `trustSet` so the screen's
  // defensive trust filter is computed against `effectiveWotTier`. The
  // persisted `wotTier` can be 'all' while the hard-lock clamps the
  // effective tier back to 'friends' (secretMode off) — if we evaluated
  // against the persisted set, the L2 entries would still be included
  // and the filter would no-op past the parental-control gate (#547
  // follow-up).
  const { trustSetForTier } = useTrustGraph();
  // WoT bottom-sheet visibility — opened from the chip in the filter row.
  // Mirrors MapScreen's setWotSheetVisible pattern (#547).
  const [wotSheetVisible, setWotSheetVisible] = useState(false);
  // Production hard-lock (#547): the data + UI layers still apply the
  // trust filter unless the effective tier is 'all'. effectiveWotTier
  // already collapses 'all' → 'friends' for non-secret-mode users, so a
  // stale persisted 'all' can't leak past the parental-control gate.
  const enforceFollowingOnly = effectiveWotTier !== 'all';
  // Tracks the `enforceFollowingOnly` value the LAST refresh actually
  // applied, so a genuine later toggle triggers a data-layer re-fetch
  // (not just a UI re-filter). Seeded to `null` (= "no refresh has run
  // yet") rather than a hardcoded boolean: the WoT tier hydrates async
  // from AsyncStorage, so on first render `enforceFollowingOnly` reflects
  // the transient default ('all' → false), not the persisted value. A
  // hardcoded seed of `true` made the first settle read as a flip, which
  // fired a SECOND `refreshDmInbox` whose `newRefreshSignal()` aborted the
  // focus-effect's cold refresh mid-decrypt — stamping the freshness
  // cursor so the retry no longer counted as a cold start and #788's
  // macro-task yield never ran (a double-fetch that no-op'd the
  // optimisation). With `null`, the enforce-flip effect stays dormant
  // until a refresh has actually recorded which filter it used; the cold
  // focus refresh is then the SINGLE fetch and carries the correct filter.
  // (#788)
  const lastAppliedEnforceRef = useRef<boolean | null>(null);
  const [search, setSearch] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pickedFriend, setPickedFriend] = useState<PickedFriend | null>(null);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [createGroupVisible, setCreateGroupVisible] = useState(false);
  const [sheetContact, setSheetContact] = useState<ContactProfileBodyData | null>(null);
  const [profileSheetVisible, setProfileSheetVisible] = useState(false);
  const [windowDays, setWindowDays] = useState<30 | 90>(30);
  // Default OFF so the inbox starts as DMs-only (#147). When ON, the
  // memo below re-merges zap-counterparty rows into the conversation
  // list so users who primarily zap (vs. DM) still get a one-tap path
  // back to the legacy mixed view.
  const [showZapCounterparties, setShowZapCounterparties] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem('messages_window_days')
      .then((v) => {
        if (v === '90') setWindowDays(90);
      })
      .catch(() => {});
    AsyncStorage.getItem('messages_show_zap_counterparties')
      .then((v) => {
        if (v === '1') setShowZapCounterparties(true);
      })
      .catch(() => {});
  }, []);

  const cycleWindowDays = useCallback(() => {
    setWindowDays((prev) => {
      const next: 30 | 90 = prev === 30 ? 90 : 30;
      AsyncStorage.setItem('messages_window_days', String(next)).catch(() => {});
      return next;
    });
  }, []);

  // Side-effect (AsyncStorage.setItem) lives OUTSIDE the functional updater. React can call updaters multiple times during a render in StrictMode/concurrent rendering, which would double-fire the setItem with the wrong value. Persist via a downstream useEffect on the state, with a ref-gate to skip the initial-mount write that would otherwise clobber the just-loaded persisted value with the default.
  const toggleShowZapCounterparties = useCallback(() => {
    setShowZapCounterparties((prev) => !prev);
  }, []);
  const showZapCounterpartiesHydrated = useRef(false);
  useEffect(() => {
    if (!showZapCounterpartiesHydrated.current) {
      showZapCounterpartiesHydrated.current = true;
      return;
    }
    AsyncStorage.setItem(
      'messages_show_zap_counterparties',
      showZapCounterparties ? '1' : '0',
    ).catch(() => {});
  }, [showZapCounterparties]);

  // Also pre-warms the friend-picker avatar bitmaps. Histograms from
  // perf-suite showed the FAB → FriendPicker open path spends most
  // of its modern-jank budget on cold avatar decode. Prefetching the
  // avatars the picker will actually display (filtered + sorted to
  // match FriendPickerSheet's friends memo, capped at 50) pushes the
  // decode cost OUT of the FAB-tap-to-content window. By the time the
  // user taps (+), `expo-image`'s disk cache is warm and the avatars
  // render without a fresh decode. See plan in #245.
  //
  // TTL gate (30 s) so the prefetch doesn't re-fire on every
  // contacts-array change — `loadContacts` updates contacts
  // incrementally as kind-0 profile batches arrive, which would
  // otherwise schedule the same 50-avatar prefetch on every drip.
  // Mirrors the same pattern used by `dmInboxLastRefreshAt`.
  const lastAvatarPrefetchAt = useRef<number>(0);
  // TTL gate for the focus-driven inbox refresh. Without it, every focus
  // (including the back-from-group transition) triggered a full
  // refreshDmInbox cached-loop on the JS thread for ~3 s on a chunky
  // inbox — perceived as MessagesScreen freezing right after the back
  // animation lands (#286 / #300). 30 s mirrors the avatar-prefetch TTL
  // below; the live `subscribeGroupMessages` channel covers delivery
  // for any wraps that arrive while the user was inside a group.
  // Tagged with the account it ran for: a switch must not inherit the
  // previous account's TTL (its inbox would never refresh until pull-down).
  const dmInboxLastRefreshAt = useRef<{ pubkey: string | null; at: number }>({
    pubkey: null,
    at: 0,
  });
  const DM_INBOX_REFRESH_TTL_MS = 30_000;
  // Short TTL written on abort (#731 Fix 1 — "chaining trap").
  // The full 30 s TTL is only written when the refresh RESOLVES. If the
  // user blurs before it finishes the TTL was previously left unset,
  // so the very next focus would immediately start another full refresh
  // (tab-hop faster than the refresh → full refresh every time,
  // indefinitely). Writing a shorter marker on abort tells the next
  // focus "a refresh already started and was interrupted; wait a bit
  // before trying again" — 10 s is long enough to suppress spurious
  // re-chains without delaying a genuine user intent to view new DMs.
  const DM_INBOX_ABORT_TTL_MS = 10_000;
  // Aborts the in-flight refreshDmInbox when the user leaves Messages, so the NIP-17 unwrap loop releases the JS thread quickly instead of grinding through hundreds of cached wraps after blur. See #412 for the perceived "tabs feel locked during refresh" symptom.
  const refreshAbortRef = useRef<AbortController | null>(null);
  // Tracks the post-interaction delay timer so it can be cancelled on blur before it fires (#731 Fix 1).
  const refreshDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const newRefreshSignal = useCallback((): AbortSignal => {
    refreshAbortRef.current?.abort();
    const ctrl = new AbortController();
    refreshAbortRef.current = ctrl;
    return ctrl.signal;
  }, []);
  // Read `enforceFollowingOnly` via a ref inside the DM-refresh focus effect so the callback's deps don't include it (and don't invalidate when, in future, this might depend on contact changes too). The focus cleanup must only run on actual blur, not on every dep change, otherwise an in-flight unwrap loop would be aborted prematurely. (#413 review)
  const enforceFollowingOnlyRef = useRef(enforceFollowingOnly);
  useEffect(() => {
    enforceFollowingOnlyRef.current = enforceFollowingOnly;
  }, [enforceFollowingOnly]);

  // Force-refresh the inbox whenever the effective enforcement GENUINELY
  // flips (a real WoT-tier toggle), so all data-layer paths re-apply the
  // new filter. Dormant until the cold focus refresh below has recorded
  // which filter it applied (`lastAppliedEnforceRef.current !== null`):
  // on first render the WoT tier is still hydrating, so firing here would
  // abort the cold refresh and defeat #788's macro-task yield. Once a
  // refresh has run, a later toggle that differs from the applied value
  // re-fetches with `force: true` so newly-(un)trusted senders surface.
  useEffect(() => {
    if (!isLoggedIn) return;
    if (lastAppliedEnforceRef.current === null) return;
    if (lastAppliedEnforceRef.current === enforceFollowingOnly) return;
    lastAppliedEnforceRef.current = enforceFollowingOnly;
    refreshDmInbox({
      force: true,
      includeNonFollows: !enforceFollowingOnly,
      signal: newRefreshSignal(),
    });
  }, [enforceFollowingOnly, isLoggedIn, refreshDmInbox, newRefreshSignal]);

  useFocusEffect(
    useCallback(() => {
      if (!isLoggedIn) return;
      // Tell NostrContext to open the live NIP-17 sub — idempotent;
      // cold-boot left it disarmed so Home stays responsive. First
      // Messages-tab focus pays the wrap-drain cost here, where a
      // brief loading state is the expected UX.
      armLiveDmSub();
      // Two-stage defer (#731 Fix 1 — keep decrypt off the tab-animation hot path):
      //
      // 1. InteractionManager.runAfterInteractions waits for the tab-bar
      //    slide animation to complete its "interaction" frame budget.
      // 2. Inside that callback a 120 ms safety margin lets the first JS
      //    paint of MessagesScreen (FlashList measure + item layout +
      //    avatar decode) finish before the decrypt loop begins. Without
      //    this delay those two phases competed for the JS thread on every
      //    cold Messages focus — visible as list-renders jank right after
      //    the tab-bar animation completes.
      //
      // Both the interactionHandle and refreshDelayRef are cancelled in
      // cleanup so a blur before the delay fires is a complete no-op —
      // no decrypt work starts at all (optimal outcome for a fast tab-hop).
      const interactionHandle = InteractionManager.runAfterInteractions(() => {
        const last = dmInboxLastRefreshAt.current;
        if (last.pubkey === pubkey && Date.now() - last.at < DM_INBOX_REFRESH_TTL_MS) return;
        refreshDelayRef.current = setTimeout(() => {
          refreshDelayRef.current = null;
          const startedAt = Date.now();
          // Capture the signal: refreshDmInbox RESOLVES (never rejects) on
          // abort — it early-returns internally on `signal.aborted` — so
          // `.then` runs in BOTH the completed and aborted cases and `.catch`
          // is effectively dead for aborts. We therefore branch on the signal
          // (not the catch) to choose the TTL marker.
          const signal = newRefreshSignal();
          // Record the filter this (cold) refresh applies so the
          // enforce-flip effect above stops being dormant and only
          // re-fires on a GENUINE later toggle away from this value.
          // Reading `enforceFollowingOnlyRef.current` here (vs. a stale
          // closure) means the WoT tier has had until now — past
          // InteractionManager + the 120 ms margin, comfortably longer
          // than the AsyncStorage hydrate — to settle, so this single
          // fetch carries the correct, settled filter. (#788)
          lastAppliedEnforceRef.current = enforceFollowingOnlyRef.current;
          refreshDmInbox({
            includeNonFollows: !enforceFollowingOnlyRef.current,
            signal,
          })
            .then(() => {
              // Aborted mid-refresh (e.g. a fast tab-hop): write a shorter
              // 10 s marker (#731 Fix 1 — "chaining trap") so the next focus
              // doesn't immediately re-chain a full refresh, while still
              // refreshing sooner than a clean 30 s TTL would. A clean
              // completion gets the full 30 s TTL.
              dmInboxLastRefreshAt.current = {
                pubkey,
                at: signal.aborted
                  ? Date.now() - (DM_INBOX_REFRESH_TTL_MS - DM_INBOX_ABORT_TTL_MS)
                  : startedAt,
              };
            })
            .catch(() => {
              // refreshDmInbox rarely rejects, but if it does, treat it like an
              // abort: short marker so we retry soon rather than waiting 30 s.
              dmInboxLastRefreshAt.current = {
                pubkey,
                at: Date.now() - (DM_INBOX_REFRESH_TTL_MS - DM_INBOX_ABORT_TTL_MS),
              };
            });
        }, 120);
      });
      return () => {
        interactionHandle.cancel();
        // Cancel any pending delay that was scheduled inside the interaction
        // callback but hadn't fired yet (e.g. blur during the 120 ms window).
        if (refreshDelayRef.current !== null) {
          clearTimeout(refreshDelayRef.current);
          refreshDelayRef.current = null;
        }
        // Abort an in-flight unwrap loop on tab blur so the JS thread isn't busy decrypting wraps the user no longer needs to see right now. The next focus will re-trigger refresh subject to the TTL gate (30 s resolved, 10 s aborted).
        refreshAbortRef.current?.abort();
        refreshAbortRef.current = null;
      };
    }, [isLoggedIn, pubkey, refreshDmInbox, newRefreshSignal, armLiveDmSub]),
  );

  // Avatar prefetch is split into its own focus effect so it can depend on `contacts` (the content it iterates) without invalidating the DM-refresh callback above. (#413 review)
  useFocusEffect(
    useCallback(() => {
      if (!isLoggedIn) return;
      const handle = InteractionManager.runAfterInteractions(() => {
        const PREFETCH_TTL_MS = 30_000;
        if (Date.now() - lastAvatarPrefetchAt.current < PREFETCH_TTL_MS) return;

        // Match FriendPickerSheet's `friends` memo: drop entries with no resolved name (the picker hides them), sort by first Latin letter then by lower-case name, then take the first 50. That's the set the user will see in the initial sheet viewport — prefetching them is the relevant warm-up.
        //
        // firstAlpha mirrors FriendPickerSheet's local helper: NFKD-normalise + uppercase, return first [A-Z] char or '#'.
        const firstAlpha = (n: string): string => {
          const m = n.normalize('NFKD').toUpperCase().match(/[A-Z]/);
          return m ? m[0] : '#';
        };
        const named: { picture: string; fa: string; lc: string }[] = [];
        for (const c of contacts) {
          const name = (c.profile?.displayName || c.profile?.name || c.petname || '').trim();
          const picture = c.profile?.picture;
          if (!name || !picture) continue;
          named.push({ picture, fa: firstAlpha(name), lc: name.toLowerCase() });
        }
        named.sort((a, b) => {
          if (a.fa !== b.fa) return a.fa.localeCompare(b.fa);
          return a.lc.localeCompare(b.lc);
        });
        const avatarUrls = named.slice(0, 50).map((x) => x.picture);

        if (avatarUrls.length === 0) return;

        lastAvatarPrefetchAt.current = Date.now();
        ExpoImage.prefetch(avatarUrls, 'memory-disk').catch(() => {
          // Prefetch failures are silent — falls back to on-demand decode at sheet open time, the un-fixed behaviour. No user-visible regression.
        });
      });
      return () => handle.cancel();
    }, [isLoggedIn, contacts]),
  );

  // Abort any in-flight decrypt loop when the app goes to background
  // (#739 Fix 2). RAF callbacks suspend when Android pauses Choreographer
  // (user hits Home or switches apps), so an in-flight loop hangs until
  // the app resumes and appears frozen on return. Mirror the pattern from
  // WalletContext.tsx:735. The listener must outlive focus/blur so we use
  // a plain useEffect scoped to the screen mount, not useFocusEffect.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        refreshAbortRef.current?.abort();
      }
    });
    return () => sub.remove();
  }, []);

  // Trust gate (#547). For 'friends' tier this is L1 follows + viewer + seeds;
  // for 'fof' it adds L2 follows-of-follows; for 'all' it's still computed
  // but the enforceFollowingOnly switch above disables the gate entirely.
  // Kept named `followPubkeys` so the downstream call-sites stay diff-clean
  // — the *semantics* widened from "raw follow list" to "tier-aware trust
  // set" but every existing predicate (Set.has) still applies unchanged.
  const followPubkeys = trustSetForTier(effectiveWotTier);

  // Single pubkey → ContactInfo lookup for the screen, shared by every
  // row + handler (#245), with non-followed DM senders' kind-0s fetched on
  // demand and layered in (#664). Scoped to the active account — see hook.
  const { nonFollowProfiles, contactInfoMap } = useNonFollowProfiles({
    pubkey,
    dmInbox,
    contacts,
    fetchProfilesForPubkeys,
  });

  // useDeferredValue lets React deprioritise the (O(n)) summary rebuild when an urgent update — e.g. a tab-bar tap, scroll gesture — comes in during a relay-burst flush. The user's tap renders against the previous dmInbox; the new summary lands on the next idle frame. Keeps the bottom nav snappy when 25 wraps batch-flush via the live-sub queue (queueInboxEntry / flushPendingInbox).
  // The deferred snapshot is tagged with its account: the render right after a
  // switch would otherwise still show the previous account's (deferred) rows.
  const listInputs = useMemo(() => ({ dmInbox, contacts }), [dmInbox, contacts]);
  const { dmInbox: deferredDmInbox, contacts: deferredContacts } = useAccountDeferredValue(
    pubkey,
    listInputs,
    EMPTY_LIST_INPUTS,
  );
  // Build the DM summaries first — this is always part of the inbox
  // regardless of the zap-counterparties toggle. Pass the tier-aware
  // trust set (#547) as a defence-in-depth filter. NostrContext's
  // refreshDmInbox already drops non-trusted senders at the data layer,
  // but applying it again here guards against stale dmInbox state from
  // before a follow was revoked or a tier was widened. The trust rule
  // is load-bearing — keep it enforced everywhere a summary is built.
  // Skip the gate only when effectiveWotTier === 'all' (which itself is
  // already secret-mode-gated by GroupsContext's hard-lock).
  // Marmot invites (#1269): joined / pending ones are hidden (the chat shows
  // on its own); ones that couldn't be opened get an explanatory row.
  const failedInvites = useFailedMarmotInvites(pubkey);
  const failedInvitePreview = `🔒 ${t('messageBubble.marmotInviteFailedPreview')}`;
  const dmSummaries = useMemo(() => {
    return buildDmSummaries(
      withMarmotInviteRows(deferredDmInbox, failedInvites, failedInvitePreview),
      deferredContacts,
      enforceFollowingOnly ? followPubkeys : undefined,
      nonFollowProfiles,
    );
  }, [
    deferredDmInbox,
    failedInvites,
    failedInvitePreview,
    deferredContacts,
    enforceFollowingOnly,
    followPubkeys,
    nonFollowProfiles,
  ]);
  // Build the zap-counterparties memo separately so that toggling
  // `showZapCounterparties` off doesn't make every wallet update churn
  // the merged summary list — when the toggle is off this memo is built
  // once but never consumed (cheap O(wallets) that beats the alternative
  // of unioning on every render).
  const zapSummaries = useMemo(() => {
    if (!showZapCounterparties) return null;
    return buildConversationSummaries(wallets, deferredContacts);
  }, [wallets, deferredContacts, showZapCounterparties]);
  const mergedSummaries = useMemo(() => {
    // #147: by default the inbox shows DMs only — zap-only counterparties (rows derived purely from wallet zap history with no decoded NIP-04/NIP-17 message) are hidden. The "Show zap counterparties" chip re-unions them when the user opts in.
    if (!zapSummaries) return dmSummaries;
    return mergeSummaries(zapSummaries, dmSummaries);
  }, [dmSummaries, zapSummaries]);
  // Identity-stabilise the rows across contact/profile churn (#854): while a
  // cold-start fetchProfiles stream is landing, every profile batch rebuilds
  // the summaries with all-new object references, defeating ConversationRow's
  // React.memo for every visible row on every batch — the list-wide re-render
  // thrash behind the blank-cells-while-scrolling symptom. Value-identical
  // rows keep their previous reference so memo'd rows bail out.
  const conversationSummaries = useStableRowIdentity(mergedSummaries);

  // The trust gate is on by default (parental-control requirement);
  // enforcement lives inside buildDmSummaries + refreshDmInbox. This memo
  // applies the user-selectable time window + search, plus a defensive
  // trust check for pubkey'd zap rows so untrusted zap counterparties
  // don't slip in. Groups go through their own trust gate inside
  // GroupsContext.visibleGroups, so we just merge the result here.
  type InboxRow =
    | { kind: 'dm'; summary: ConversationSummary; sortKey: number }
    | { kind: 'group'; summary: GroupSummary; sortKey: number };

  const filteredRows = useMemo<InboxRow[]>(() => {
    const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400;
    const lower = search.trim().toLowerCase();

    const dmRows: InboxRow[] = conversationSummaries
      .filter((s) => {
        if (s.lastActivityAt < cutoff) return false;
        // Defence-in-depth trust gate (#547): apply the tier-aware trust set
        // unless the effective tier is 'all'. effectiveWotTier already
        // collapses 'all' → 'friends' for non-secret-mode users, so the
        // parental-control hard-lock holds even with a stale persisted 'all'.
        if (enforceFollowingOnly && s.pubkey && !followPubkeys.has(s.pubkey.toLowerCase()))
          return false;
        if (!lower) return true;
        return (
          s.name.toLowerCase().includes(lower) ||
          conversationPreview(s, formatLocale, t('groupConversationScreen.you'))
            .toLowerCase()
            .includes(lower)
        );
      })
      .map((s) => ({ kind: 'dm', summary: s, sortKey: s.lastActivityAt }));

    const groupRows: InboxRow[] = groupSummaries
      .filter((g) => {
        if (g.activity.lastActivityAt < cutoff) return false;
        if (!lower) return true;
        return (
          g.group.name.toLowerCase().includes(lower) ||
          g.activity.lastText.toLowerCase().includes(lower)
        );
      })
      .map((g) => ({ kind: 'group', summary: g, sortKey: g.activity.lastActivityAt }));

    return [...dmRows, ...groupRows].sort((a, b) => b.sortKey - a.sortKey);
  }, [
    conversationSummaries,
    groupSummaries,
    search,
    followPubkeys,
    enforceFollowingOnly,
    windowDays,
    formatLocale,
    t,
  ]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    // Pull-to-refresh is explicit user intent — force-bypass the 24h
    // own-profile cache so renames published elsewhere surface now,
    // and also bypass the 30s DM-inbox TTL so the relay query actually
    // runs (the TTL's default path is for useFocusEffect tab bounces).
    //
    // Important: `refreshContacts` must complete BEFORE
    // `refreshDmInbox`. The DM refresh filters by the logged-in user's
    // current follow set, and if we run them in parallel the DM query
    // captures the stale closure before the new contacts state lands,
    // so any new-since-last-refresh followers' messages get dropped
    // by the follow gate. Profile refresh is independent and can run
    // in parallel.
    //
    // try/finally so a relay timeout / decrypt throw doesn't leave the
    // UI stuck in the "refreshing" spinner state.
    try {
      await Promise.all([refreshContacts(), refreshProfile({ force: true })]);
      // Pull-to-refresh deliberately does NOT call newRefreshSignal() here. If a focus refresh is already in flight, refreshDmInbox's single-flight guard returns the existing promise; aborting that promise via newRefreshSignal() then awaiting it would resolve to AbortError and never start a fresh refresh — making pull-to-refresh a no-op whenever a focus refresh was running. We let the in-flight one finish (its result is what the user wants anyway) and only kick off a new refresh if none is running. The focus-effect signal still aborts on blur, which covers the original snappiness goal. (#413 review)
      // Record the filter this refresh applies, same as the cold focus
      // refresh: if pull-to-refresh is the first refresh of the session
      // it must take the enforce-flip effect out of its dormant (`null`)
      // state so a later genuine WoT-tier toggle still re-fetches. (#788)
      lastAppliedEnforceRef.current = enforceFollowingOnly;
      await refreshDmInbox({
        force: true,
        includeNonFollows: !enforceFollowingOnly,
      });
    } catch (err) {
      // AbortError is expected when the user navigates away mid-refresh (the focus-effect signal fires) — swallow silently and let the next focus re-trigger as needed. Other errors bubble through; the finally block still resets the spinner.
      if ((err as Error)?.name !== 'AbortError') throw err;
    } finally {
      setRefreshing(false);
    }
  }, [refreshContacts, refreshDmInbox, refreshProfile, enforceFollowingOnly]);

  const handleConversationPress = useCallback(
    (summary: ConversationSummary) => {
      const info = summary.pubkey ? contactInfoMap.get(summary.pubkey.toLowerCase()) : undefined;
      const picture = summary.picture ?? info?.picture ?? null;
      const lightningAddress = summary.lightningAddress ?? info?.lightningAddress ?? null;
      if (summary.pubkey) {
        // A row is a specific thread: keep its protocol. Zap-only rows have
        // none, and zaps are listed in the NIP-17 thread.
        navigation.navigate('Conversation', {
          protocol: summary.protocol ?? DEFAULT_DM_PROTOCOL,
          pubkey: summary.pubkey,
          name: summary.name,
          picture,
          lightningAddress,
        });
        return;
      }
      // Anonymous zap: no pubkey to thread against. Surface what we have via
      // the bottom-sheet peek instead of straight to the full profile — the
      // sheet's "View full profile" link drills in if the user wants the
      // wider view; staying as a peek matches every other contact-tap entry
      // point in the app.
      setSheetContact({
        pubkey: null,
        name: summary.name,
        picture,
        banner: null,
        nip05: summary.nip05,
        lightningAddress,
        source: 'nostr',
      });
      setProfileSheetVisible(true);
    },
    [contactInfoMap, navigation],
  );

  const handleStartConversation = useCallback(() => {
    setPickerVisible(true);
  }, []);

  // __DEV__-only: seed a marketplace payment-request + receipt conversation and
  // open it, so Maestro / manual QA can exercise the order-card Pay / QR
  // affordance without a live market relay. This branch is __DEV__-gated and the
  // helper is a no-op outside __DEV__, so it never runs in a release build.
  const handleSeedDevOrder = useCallback(async () => {
    if (!__DEV__ || !pubkey) return;
    const seeded = await seedDevOrderConversation(pubkey);
    if (!seeded) return;
    navigation.navigate('Conversation', {
      pubkey: seeded.pubkey,
      name: seeded.name,
      picture: null,
      lightningAddress: null,
      protocol: 'nip17', // the seeded order rows are NIP-17 (kind 16/17)
    });
  }, [navigation, pubkey]);

  const handleSeedDevFiles = useCallback(async () => {
    if (!__DEV__ || !pubkey) return;
    const { seedDevMarmotFiles } = await import('../utils/devSeedMarmotFiles');
    const seeded = await seedDevMarmotFiles(pubkey);
    if (seeded)
      navigation.navigate('Conversation', {
        pubkey: seeded.pubkey,
        name: t('messageBubble.devFiles'),
        picture: null,
        lightningAddress: null,
        protocol: 'marmot',
      });
  }, [navigation, pubkey, t]);

  const handleSeedDevDmFiles = useCallback(
    async (protocol: 'nip17' | 'nip04') => {
      if (!__DEV__ || !pubkey) return;
      const { seedDevDmFiles } = await import('../utils/devSeedDmFiles');
      const seeded = await seedDevDmFiles(pubkey);
      if (seeded)
        navigation.navigate('Conversation', {
          pubkey: seeded.pubkey,
          name: t('messageBubble.devFiles'),
          picture: null,
          lightningAddress: null,
          protocol,
        });
    },
    [navigation, pubkey, t],
  );

  const [preferredProtocol, setPreferredProtocol] = useState<DmProtocol>(DEFAULT_DM_PROTOCOL);
  const handlePickerSelect = useCallback(
    async (friend: PickedFriend) => {
      setPickerVisible(false);
      setPreferredProtocol(await preferredDmProtocol(pubkey, friend.pubkey));
      setPickedFriend(friend);
    },
    [pubkey],
  );
  const closeProtocolPicker = useCallback(() => setPickedFriend(null), []);
  const selectProtocol = useCallback(
    (protocol: DmProtocol) => {
      if (!pickedFriend) return;
      navigation.navigate('Conversation', { ...pickedFriend, protocol });
      setPickedFriend(null);
    },
    [navigation, pickedFriend],
  );

  // Groups with an unread @mention of the viewer get an `@` badge (#1295).
  const mentionedGroupIds = useMentionedGroupIds(groupSummaries, pubkey);

  const handleGroupPress = useCallback(
    (g: GroupSummary) => {
      navigation.navigate('GroupConversation', { groupId: g.group.id });
    },
    [navigation],
  );

  const renderItem = useCallback(
    ({ item }: { item: InboxRow }) => {
      // Pass the parent handler reference directly (stable across renders)
      // and let ConversationRow / GroupRow bind the row's summary into the
      // press callback at the leaf. Previously we passed an inline arrow
      // (`() => handleX(item.summary)`) which was a fresh reference per
      // render and defeated the row's React.memo. (#300 follow-up.)
      if (item.kind === 'dm') {
        return <ConversationRow summary={item.summary} onPress={handleConversationPress} />;
      }
      return (
        <GroupRow
          summary={item.summary}
          onPress={handleGroupPress}
          contactInfoMap={contactInfoMap}
          mentioned={mentionedGroupIds.has(item.summary.group.id)}
        />
      );
    },
    [handleConversationPress, handleGroupPress, contactInfoMap, mentionedGroupIds],
  );

  // Follow live arrivals near the top; otherwise offer a jump without moving history.
  const listRef = useRef<FlashListRef<InboxRow>>(null);
  const liveEntries = useMemo(() => {
    // DM rows are one thread per person per protocol (`pubkey:protocol`), so
    // match each message by its thread, not its bare partner pubkey.
    const visibleThreads = new Set(
      filteredRows.flatMap((row) => (row.kind === 'dm' ? [row.summary.id.toLowerCase()] : [])),
    );
    const dmEntries = deferredDmInbox
      .filter((message) => visibleThreads.has(dmMessageThreadId(message)))
      .map((message) => ({ id: `dm:${message.id}`, createdAt: message.createdAt }));
    const rowEntries = filteredRows.map((row) => ({
      id:
        row.kind === 'dm'
          ? `activity:${row.summary.id}:${row.sortKey}:${row.summary.lastComment}`
          : `group:${row.summary.group.id}:${row.summary.activity.lastMessageId ?? `${row.sortKey}:${row.summary.activity.lastText}`}`,
      createdAt: row.sortKey,
    }));
    return [...dmEntries, ...rowEntries];
  }, [filteredRows, deferredDmInbox]);
  const live = useLiveMessageIndicator({
    scope: `${pubkey}:${search}:${windowDays}:${effectiveWotTier}:${showZapCounterparties}`,
    entries: liveEntries,
    scrollToLatest: (animated) => listRef.current?.scrollToOffset({ offset: 0, animated }),
  });

  return (
    <View style={styles.container}>
      <BrandPatternBackground variant="messages-weave" />
      <TabHeader
        title={t('messagesScreen.title')}
        icon={<MessageCircle size={20} color={colors.brandPink} />}
      />
      <AmberPermissionBanner />
      <View style={styles.headerExtras}>
        <View style={styles.chipRow}>
          {searchExpanded ? (
            <View style={styles.searchRow}>
              <Search size={16} color="rgba(255,255,255,0.7)" strokeWidth={2} />
              <TextInput
                ref={searchInputRef}
                style={styles.searchInput}
                placeholder={t('messagesScreen.searchPlaceholder')}
                placeholderTextColor="rgba(255,255,255,0.5)"
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t('messagesScreen.searchConversations')}
                testID="messages-search-input"
              />
              <TouchableOpacity
                onPress={() => {
                  setSearch('');
                  setSearchExpanded(false);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('messagesScreen.closeSearch')}
                testID="messages-close-search"
              >
                <X size={16} color="rgba(255,255,255,0.8)" strokeWidth={2.5} />
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View style={{ flex: 1 }} />
              <TouchableOpacity
                style={styles.searchToggle}
                onPress={() => {
                  setSearchExpanded(true);
                  setTimeout(() => searchInputRef.current?.focus(), 100);
                }}
                accessibilityLabel={t('messagesScreen.searchConversations')}
                testID="messages-search-toggle"
              >
                <Search size={18} color="rgba(255,255,255,0.8)" strokeWidth={2} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </View>

      <View style={styles.content}>
        {isLoggedIn && (
          <View style={styles.filterChipRow}>
            <WebOfTrustChip
              currentTier={effectiveWotTier}
              onPress={() => setWotSheetVisible(true)}
              testID="messages-wot-chip"
            />
            {/* Hidden marker for Maestro so flows can assert the active tier without parsing the chip label. Mirrors messages-zaps-toggle-on/off below. */}
            <View testID={`messages-wot-tier-${effectiveWotTier}`} accessibilityElementsHidden />

            <TouchableOpacity
              style={styles.filterChipInteractive}
              onPress={cycleWindowDays}
              accessibilityLabel={t('messagesScreen.windowToggleA11y', { days: windowDays })}
              accessibilityRole="button"
              testID="messages-window-toggle"
            >
              <Clock size={14} color={colors.brandPink} />
              <Text style={styles.filterChipText}>
                {t('messagesScreen.lastDays', { days: windowDays })}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={
                showZapCounterparties
                  ? styles.filterChipInteractiveOn
                  : styles.filterChipInteractive
              }
              onPress={toggleShowZapCounterparties}
              accessibilityLabel={
                showZapCounterparties
                  ? t('messagesScreen.hideZapCounterparties')
                  : t('messagesScreen.showZapCounterparties')
              }
              accessibilityRole="button"
              accessibilityState={{ selected: showZapCounterparties }}
              testID="messages-zaps-toggle"
            >
              <Zap size={14} color={colors.brandPink} />
              <Text style={styles.filterChipText}>{t('messagesScreen.zaps')}</Text>
            </TouchableOpacity>
            {/* Hidden marker so Maestro can assert WHICH state the toggle is in (chip is always visible regardless), without relying on accessibilityState which RN exposes inconsistently across Android versions. */}
            <View
              testID={`messages-zaps-toggle-${showZapCounterparties ? 'on' : 'off'}`}
              accessibilityElementsHidden
            />
            {__DEV__ && (
              <TouchableOpacity
                style={styles.filterChipInteractive}
                onPress={handleSeedDevFiles}
                accessibilityLabel={t('messageBubble.devFilesA11y')}
                accessibilityRole="button"
                testID="messages-dev-seed-files"
              >
                <Text style={styles.filterChipText}>{t('messageBubble.devFiles')}</Text>
              </TouchableOpacity>
            )}
            {__DEV__ &&
              (['nip17', 'nip04'] as const).map((protocol) => (
                <TouchableOpacity
                  key={protocol}
                  style={styles.filterChipInteractive}
                  onPress={() => void handleSeedDevDmFiles(protocol)}
                  accessibilityLabel={`${t('messageBubble.devFiles')} ${protocol}`}
                  accessibilityRole="button"
                  testID={`messages-dev-seed-files-${protocol}`}
                >
                  <Text style={styles.filterChipText}>{protocol}</Text>
                </TouchableOpacity>
              ))}
            {__DEV__ && (
              // Dev-only fixture launcher for the marketplace order cards. Never
              // present in release builds (see handleSeedDevOrder).
              <TouchableOpacity
                style={styles.filterChipInteractive}
                onPress={handleSeedDevOrder}
                accessibilityLabel="Seed a dev marketplace order conversation"
                accessibilityRole="button"
                testID="messages-dev-seed-order"
              >
                <Zap size={14} color={colors.brandPink} />
                <Text style={styles.filterChipText}>Dev order</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
        {isLoggedIn && <MarmotInvitations />}
        {isLoggedIn && <Nip171Invitations />}
        {!isLoggedIn ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>{t('messagesScreen.connectNostr')}</Text>
            <Text style={styles.emptySubtitle}>{t('messagesScreen.connectNostrSubtitle')}</Text>
            <TouchableOpacity
              style={styles.connectButton}
              onPress={() => navigation.getParent()?.dispatch({ type: 'OPEN_DRAWER' })}
            >
              <Text style={styles.connectButtonText}>{t('messagesScreen.goToAccount')}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlashList
            ref={listRef}
            data={filteredRows}
            keyExtractor={(item) =>
              item.kind === 'dm' ? `dm:${item.summary.id}` : `group:${item.summary.group.id}`
            }
            renderItem={renderItem}
            extraData={mentionedGroupIds}
            onScroll={live.onScroll}
            scrollEventThrottle={16}
            refreshControl={
              <BrandedRefreshControl refreshing={refreshing} onRefresh={handleRefresh} />
            }
            ListEmptyComponent={
              <View style={styles.emptyState}>
                <Text style={styles.emptyTitle}>
                  {search ? t('messagesScreen.noMatches') : t('messagesScreen.noConversationsYet')}
                </Text>
                <Text style={styles.emptySubtitle}>
                  {search
                    ? t('messagesScreen.tryDifferentSearch')
                    : t('messagesScreen.noConversationsSubtitle')}
                </Text>
              </View>
            }
            contentContainerStyle={styles.listContent}
          />
        )}

        {live.hasNewMessages && (
          <NewMessagesPill onPress={live.jumpToLatest} testID="messages-new-messages" />
        )}
        {isLoggedIn && (
          <TouchableOpacity
            style={styles.fab}
            onPress={handleStartConversation}
            accessibilityLabel={t('messagesScreen.startNewConversation')}
            testID="start-conversation-button"
            activeOpacity={0.85}
          >
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
              <Path d="M12 5v14M5 12h14" stroke="#FFFFFF" strokeWidth={2.5} strokeLinecap="round" />
            </Svg>
          </TouchableOpacity>
        )}
      </View>

      <DmProtocolPickerSheet
        visible={pickedFriend !== null}
        selected={preferredProtocol}
        onSelect={selectProtocol}
        onClose={closeProtocolPicker}
      />
      <FriendPickerSheet
        visible={pickerVisible}
        onClose={() => setPickerVisible(false)}
        onSelect={handlePickerSelect}
        title={t('messagesScreen.startConversationTitle')}
        onNewGroup={() => {
          setPickerVisible(false);
          setCreateGroupVisible(true);
        }}
      />

      <CreateGroupSheet
        visible={createGroupVisible}
        onClose={() => setCreateGroupVisible(false)}
        onCreated={(group) => {
          setCreateGroupVisible(false);
          navigation.navigate('GroupConversation', { groupId: group.id });
        }}
      />

      <ContactProfileSheet
        visible={profileSheetVisible}
        onClose={() => setProfileSheetVisible(false)}
        contact={sheetContact}
        onViewFullProfile={() => {
          if (!sheetContact) return;
          setProfileSheetVisible(false);
          navigation.navigate('ContactProfile', { contact: sheetContact });
        }}
      />

      <WebOfTrustBottomSheet visible={wotSheetVisible} onClose={() => setWotSheetVisible(false)} />
    </View>
  );
};

export default MessagesScreen;
