import React, {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useNostr, useNostrContacts } from './NostrContext';
import { useAccountState } from './useAccountState';
import {
  DEFAULT_SEED_PUBKEYS,
  computeTrustSet,
  isPubkeyTrusted,
} from '../services/trustGraphService';
import { LEGACY_FOF_CACHE_KEY } from '../services/friendsOfFriendsService';
import { useTrustGraphL2, type TrustGraphL2Status } from './useTrustGraphL2';
import {
  loadWotSettings,
  peekWotSettings,
  saveWotSettings,
  type WotSettings,
  type WotTier,
  notificationTierFor,
} from '../services/wotSettingsService';
import {
  publishNotificationAudience,
  unpublishNotificationAudience,
} from '../services/notificationAudience';

// Pre-#565 uncapped L2 blob (~2 MB, the CursorWindow freeze). Deleted on
// launch; the capped set now lives under friendsOfFriendsService's keys.
const LEGACY_L2_CACHE_KEY_PREFIX = '@lp:trust-graph-l2:';

// Re-export the tier type so consumers (chip + sheet) can type their props
// without reaching into the service layer.
export type { WotTier } from '../services/wotSettingsService';

interface TrustGraphContextType {
  // Lowercase-hex union of every pubkey that passes the *currently
  // persisted* tier. Consumers that care about UI-effective tier (e.g.
  // the parental-control hard-lock that clamps a persisted 'all' back
  // to 'friends' when secretMode is off) should call
  // `trustSetForTier(effectiveTier)` instead — otherwise a stale
  // persisted 'all' can leak past the gate (#547 follow-up).
  trustSet: ReadonlySet<string>;
  // Tier-aware membership predicate (#535).
  //   'friends' — kind-3 follow list + user + seeds
  //   'fof'     — friends + cached friends-of-follows
  //   'all'     — always returns true (filter disabled)
  // Uses the *persisted* tier — see `isTrustedAtTier` for the variant
  // that lets callers evaluate against a specific (e.g. effective) tier.
  isTrusted: (pubkey: string) => boolean;
  // Tier-parameterised version of `trustSet` — returns the set that
  // *would* apply if the requested tier were active, regardless of
  // what's persisted. Used by call sites that enforce against the
  // UI-effective tier (e.g. MessagesScreen) so the defensive trust
  // filter matches the hard-lock and a stale persisted 'all' can't
  // leak.
  trustSetForTier: (tier: WotTier) => ReadonlySet<string>;
  // Tier-parameterised membership predicate — same role as
  // `trustSetForTier` but for callers that prefer the predicate form
  // (e.g. GroupsContext's `visibleGroups` filter).
  isTrustedAtTier: (tier: WotTier, pubkey: string) => boolean;
  // Active tier (#535). Replaces the legacy `filterEnabled` boolean.
  // While the active account's saved tier is still unknown this reports
  // the narrowest tier ('friends') — see `wotTierReady`.
  wotTier: WotTier;
  // False while the active account's saved tier is still loading (cold
  // start, or a switch to an account added this session). Every consumer is
  // already gated during that window because `wotTier` reads 'friends'.
  wotTierReady: boolean;
  // Persist + apply a new tier. Choosing 'fof' doesn't switch at once: it
  // starts the friends-of-friends build (progress + Cancel via
  // `useTrustGraphL2Status`) and the tier only becomes 'fof' once the set is
  // ready (#565). Choosing another tier cancels a build in flight.
  // A pick is recorded as EXPLICIT (it then also widens notifications — see
  // `notificationTierFor`); the legacy migration passes `explicit: false`.
  setWotTier: (next: WotTier, opts?: { explicit?: boolean }) => void;
  // True while the friends-of-friends set is being built (foreground pick
  // or a background refresh of a stale persisted set).
  l2Loading: boolean;
  // Number of pubkeys in the L2 (friends-of-follows) set.
  l2Size: number;
  // Rebuild the L2 set now (bypasses the cache; keeps the current tier).
  refreshL2: () => Promise<void>;
}

// Build progress lives in its own context: it changes once per follow-list
// batch, and only the Web of Trust sheet needs it — the heavy trust-filter
// consumers (MessagesScreen, Map, Hunt) must not re-render per batch.
interface TrustGraphL2StatusContextType {
  status: TrustGraphL2Status;
  // Abort the running build; nothing is persisted and the tier is unchanged.
  cancelL2: () => void;
}

const TrustGraphL2StatusContext = createContext<TrustGraphL2StatusContextType | null>(null);

const TrustGraphContext = createContext<TrustGraphContextType | null>(null);

interface ProviderProps {
  children: ReactNode;
}

// Shown while the active account's saved tier is unknown. Narrowest tier, so
// a family member set to Friends never sees strangers' conversations, caches
// or events for even one frame on a shared phone (#1224 review).
const HYDRATING_TIER: WotTier = 'friends';

export const TrustGraphProvider: React.FC<ProviderProps> = ({ children }) => {
  const { pubkey, relays } = useNostr();
  const { contacts } = useNostrContacts();
  const readRelays = useMemo(
    () => (relays ?? []).filter((r) => r.read).map((r) => r.url),
    [relays],
  );

  // Direct follows (L1) — derived from NostrContext's contacts state.
  const l1Follows = useMemo(() => {
    const s = new Set<string>();
    for (const c of contacts) s.add(c.pubkey.toLowerCase());
    return s;
  }, [contacts]);

  // Cleanup of the legacy L2 caches. The first implementation wrote a single
  // ~2 MB blob keyed by `${LEGACY_L2_CACHE_KEY_PREFIX}${pubkey}`; leaving it
  // around (a) wastes storage for every existing install and (b) keeps the
  // SQLiteBlobTooBigException primed to fire if any code path still tries to
  // read it. The pre-#565 FoF cache was one device-wide key shared by every
  // account and cap, so it goes too. Only key NAMES are listed — no values
  // are read. Iterating getAllKeys is O(n) over total
  // AsyncStorage keys, which for this app is ~50, so the cost is trivial.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const keys = await AsyncStorage.getAllKeys();
        if (cancelled) return;
        const stale = keys.filter(
          (k) => k.startsWith(LEGACY_L2_CACHE_KEY_PREFIX) || k === LEGACY_FOF_CACHE_KEY,
        );
        if (stale.length > 0) await AsyncStorage.multiRemove(stale);
      } catch {
        // Best-effort cleanup; failure is non-fatal and re-tries next launch.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persisted tier, PER ACCOUNT (shared family phone). Resolution order:
  //   1. the value loaded for THIS account (owner-tagged via
  //      `useAccountState`, so a switch never renders the previous
  //      account's tier);
  //   2. the session mirror (`peekWotSettings`) — prewarmed at startup for
  //      every registered account, so switching between known accounts is
  //      instant and exact;
  //   3. unknown → HYDRATING_TIER ('friends') until the load resolves.
  //
  // Trade-off vs. #627 (which initialised to 'all' so brand-new users don't
  // see an empty rail): a user on 'all' now sees at most one AsyncStorage
  // round trip (~50-200 ms) of narrower content at cold start before it
  // widens. Narrow→wide is the safe direction; wide→narrow leaked
  // strangers' messages on account switch.
  //
  // Legacy boolean payloads are migrated inside `loadWotSettings`.
  const [loadedSettings, setLoadedSettings] = useAccountState<WotSettings | null>(pubkey, null);
  // Bumped by setWotTier so a load that started before the user picked a
  // tier can't roll the picker back when it resolves.
  const changeVersion = useRef(0);
  useEffect(() => {
    let cancelled = false;
    const version = changeVersion.current;
    loadWotSettings(pubkey).then((loaded) => {
      if (!cancelled && version === changeVersion.current) setLoadedSettings(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, setLoadedSettings]);

  const knownSettings = loadedSettings ?? peekWotSettings(pubkey);
  const wotTierReady = knownSettings !== null;
  const wotTier: WotTier = knownSettings?.wotTier ?? HYDRATING_TIER;
  const notifyTier: WotTier = knownSettings ? notificationTierFor(knownSettings) : HYDRATING_TIER;

  const persistTier = useCallback(
    (next: WotTier, explicit = true) => {
      changeVersion.current += 1;
      const settings: WotSettings = explicit ? { wotTier: next, explicit } : { wotTier: next };
      setLoadedSettings(settings);
      saveWotSettings(settings, pubkey).catch(() => {});
    },
    [pubkey, setLoadedSettings],
  );

  // L2 (friends-of-friends): nothing is read or fetched unless the tier is
  // 'fof' — see useTrustGraphL2.
  const {
    l2Follows,
    status: l2Status,
    enableFof,
    cancelL2,
    refreshL2,
  } = useTrustGraphL2({
    pubkey,
    friends: l1Follows,
    readRelays,
    wotTier,
    wotTierReady,
    persistTier,
  });
  // Message notifications follow the CHOSEN tier (notificationAudience): an
  // unchosen one notifies like Friends. The live DM gate reads it per
  // message, so a change applies without a restart. Unknown tier
  // (hydrating) publishes nothing — follows only.
  useEffect(() => {
    if (!pubkey || !wotTierReady) return;
    publishNotificationAudience(pubkey, {
      tier: notifyTier,
      fof: notifyTier === 'fof' && l2Follows.size > 0 ? l2Follows : null,
    });
    return () => unpublishNotificationAudience(pubkey);
  }, [pubkey, notifyTier, wotTierReady, l2Follows]);
  const l2Loading = l2Status.building;
  const l2Empty = l2Follows.size === 0;

  // Read through a ref so `setWotTier` keeps one identity across builds
  // (GroupsContext re-exports it in its own memoised value).
  const l2Failed = l2Status.failed;
  const tierStateRef = useRef({ wotTier, l2Empty, l2Loading, l2Failed });
  tierStateRef.current = { wotTier, l2Empty, l2Loading, l2Failed };
  const setWotTier = useCallback(
    (next: WotTier, opts?: { explicit?: boolean }) => {
      if (next === 'fof') {
        const current = tierStateRef.current;
        // A build is already running (from any surface — sheet or Settings):
        // re-picking FoF must not abort and restart it.
        if (current.l2Loading) return;
        // Already on FoF: only rebuild a set that never arrived or whose last
        // build failed (the tap is the retry) — never re-fetch on an
        // accidental re-tap of a healthy set.
        if (current.wotTier !== 'fof') {
          enableFof();
          return;
        }
        // Re-picking it still records the choice (no build): a tier saved
        // before the explicit marker existed must be confirmable (#1764).
        persistTier('fof', opts?.explicit ?? true);
        if (current.l2Empty || current.l2Failed) void refreshL2();
        return;
      }
      cancelL2();
      persistTier(next, opts?.explicit ?? true);
    },
    [enableFof, refreshL2, cancelL2, persistTier],
  );

  // For 'friends' tier the trust set is L1 + user + seeds.
  // For 'fof' tier it adds L2 (cached friends-of-follows).
  // For 'all' tier we still compute a trust set (so the UI can show
  // "n hidden" counts symmetrically) but `isTrusted` short-circuits to
  // true below.
  //
  // ALL tiers are memoised up front (not just the persisted one). The
  // previous `trustSetForTier` only fast-pathed `tier === wotTier` and ran
  // `computeTrustSet` per call otherwise — minting a fresh Set identity on
  // every render of every caller. MessagesScreen evaluates the UI-effective
  // tier (persisted 'all' clamps to 'friends' when secretMode is off — the
  // DEFAULT configuration) and keys two O(inbox) memos on the returned set,
  // so its whole memo chain re-ran every render. Building both sets here is
  // O(follows) — cheap — and only on contacts/identity change.
  const tierSets = useMemo(() => {
    const friends = computeTrustSet(pubkey, l1Follows, new Set<string>(), true);
    const widened = computeTrustSet(pubkey, l1Follows, l2Follows, true);
    return { friends, fof: widened, all: widened } satisfies Record<WotTier, ReadonlySet<string>>;
  }, [pubkey, l1Follows, l2Follows]);

  const trustSet = tierSets[wotTier];

  // Tier-parameterised version of `trustSet`. Returns the set that
  // *would* apply if the requested tier were active, regardless of
  // what's persisted. Referentially stable per (pubkey, contacts) — see
  // `tierSets` above.
  const trustSetForTier = useCallback(
    (tier: WotTier): ReadonlySet<string> => tierSets[tier],
    [tierSets],
  );

  const isTrusted = useCallback(
    (pk: string) => {
      // 'all' tier disables the filter entirely. Consumers still call
      // `isTrusted` (so the call sites don't have to branch on tier);
      // we just return true unconditionally.
      if (wotTier === 'all') return true;
      return isPubkeyTrusted(pk, trustSet);
    },
    [trustSet, wotTier],
  );

  // Tier-parameterised membership predicate. Same `'all'`
  // short-circuit, but evaluates against the *requested* tier rather
  // than the persisted one — see `trustSetForTier` for the rationale.
  const isTrustedAtTier = useCallback(
    (tier: WotTier, pk: string) => {
      if (tier === 'all') return true;
      return isPubkeyTrusted(pk, trustSetForTier(tier));
    },
    [trustSetForTier],
  );

  const value = useMemo<TrustGraphContextType>(
    () => ({
      trustSet,
      isTrusted,
      trustSetForTier,
      isTrustedAtTier,
      wotTier,
      wotTierReady,
      setWotTier,
      l2Loading,
      l2Size: l2Follows.size,
      refreshL2,
    }),
    [
      trustSet,
      isTrusted,
      trustSetForTier,
      isTrustedAtTier,
      wotTier,
      wotTierReady,
      setWotTier,
      l2Loading,
      l2Follows,
      refreshL2,
    ],
  );

  const statusValue = useMemo<TrustGraphL2StatusContextType>(
    () => ({ status: l2Status, cancelL2 }),
    [l2Status, cancelL2],
  );

  return (
    <TrustGraphContext.Provider value={value}>
      <TrustGraphL2StatusContext.Provider value={statusValue}>
        {children}
      </TrustGraphL2StatusContext.Provider>
    </TrustGraphContext.Provider>
  );
};

export const useTrustGraph = (): TrustGraphContextType => {
  const ctx = useContext(TrustGraphContext);
  if (!ctx) throw new Error('useTrustGraph must be used inside <TrustGraphProvider>');
  return ctx;
};

/** Friends-of-friends build progress + Cancel (Web of Trust sheet only). */
export const useTrustGraphL2Status = (): TrustGraphL2StatusContextType => {
  const ctx = useContext(TrustGraphL2StatusContext);
  if (!ctx) throw new Error('useTrustGraphL2Status must be used inside <TrustGraphProvider>');
  return ctx;
};

export type { TrustGraphL2Status, FofBuildProgress } from './useTrustGraphL2';
export { WOT_FOF_MAX } from './useTrustGraphL2';

// Re-export so consumers can reference the seed list (e.g. "follow these
// recommended accounts" UI) without depending on the service module.
export { DEFAULT_SEED_PUBKEYS };
