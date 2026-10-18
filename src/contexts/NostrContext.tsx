import { useAppNetworkRelays } from '../hooks/useAppNetworkRelays';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { useActiveNostrAccount } from './useActiveNostrAccount';
import { useFollowHydration } from './useFollowHydration';
import { reconcileCachedContactFollows } from './reconcileContactFollows';
import { buildFollowSet } from '../utils/followPubkeys';
import { readFollowSnapshot } from '../services/contactFollowFreshness';
import { useRelayAuthSigner } from './useRelayAuthSigner';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  startTransition,
} from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as nip19 from 'nostr-tools/nip19';
import * as nostrService from '../services/nostrService';
import {
  rearmBackgroundDmWatchForActiveIdentity,
  stopBackgroundDmWatch,
  syncBackgroundDmWatchFromPreference,
} from '../services/backgroundDmService';
import * as amberService from '../services/amberService';
import * as nostrConnectService from '../services/nostrConnectService';
import type { NostrProfile, NostrContact, RelayConfig, SignerType, Nip46Connection } from '../types/nostr'; // prettier-ignore
import { getUserRelays, setUserRelays } from '../services/nostrRelayStorage';
import { perAccountKey } from '../services/perAccountStorage';
import {
  loadIdentities,
  upsertIdentity,
  removeIdentity as removeIdentityFromStore,
  setActiveIdentity,
  type StoredIdentity,
} from '../services/identitiesStore';
import { migrateToPerAccountStorage } from '../services/migrateToPerAccountStorage';
import { perfLog } from '../utils/perfLog';
import { sanitizeContacts } from '../utils/contacts';
import { useReactionActions, type UseReactionActionsResult } from '../hooks/useReactionActions';
import { NSEC_KEY, PUBKEY_KEY, SIGNER_TYPE_KEY, NIP46_CONNECTION_KEY } from './nostrAuthKeys';
import { persistActiveIdentityKeys } from './persistActiveIdentityKeys';
import { promoteSuccessorIdentity } from './promoteSuccessorIdentity';
import {
  useMessageSend,
  type MessageSendApi,
  type SendResult,
  type SendHooks,
} from './useMessageSend';
import { useContactActions } from './useContactActions';
import { useNip46Login, restoreNip46Session } from './useNip46Login';
import { nip46Sign } from './nip46DmDecrypt';
import { dropIdentityKeyMaterial, useIdentityMemoryReset } from './resetIdentityMemoryState';
import { AMBER_NIP17_ENABLED_KEY_LEGACY } from './nostrDmCache';
import { wipeAccountCaches } from './accountCacheWipe';
import * as invitationKeys from '../services/marmotInvitationKeySignOut';
import { wipeLocalDmStore } from '../services/localDb';
import { useDmInbox } from './useDmInbox';
import { DmInboxContext } from './DmInboxContext';
import { useGroupMessaging, type UseGroupMessagingResult } from './useGroupMessaging';
import { useCacheNotifications } from './useCacheNotifications';
import { useNip65Relays, type AdoptResult } from './useNip65Relays';
import {
  CONTACTS_CACHE_KEY_BASE,
  PROFILES_CACHE_KEY_BASE,
  CONTACTS_TIMESTAMP_KEY_BASE,
  OWN_PROFILE_CACHE_KEY_BASE,
  OWN_PROFILE_TIMESTAMP_KEY_BASE,
  RELAY_LIST_CACHE_KEY_BASE,
  RELAY_LIST_TIMESTAMP_KEY_BASE,
  CACHE_MAX_AGE_MS,
  MISSING_PROFILE_RETRY_MS,
  readCachedWithTtl,
  persistMergedProfileCache,
} from './nostrCacheKeys';
import type { SignedEvent, ConversationMessage } from './nostrContextTypes';
import { useOwnProfile } from './useOwnProfile';
import { useAccountState } from './useAccountState';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';

export { OWN_PROFILE_CACHE_KEY_BASE } from './nostrCacheKeys';
export { notifyGroupMessage, subscribeGroupMessages, subscribeDmMessages } from './nostrEventBus';
export type { RefreshDmInboxOptions, SignedEvent, ConversationMessage } from './nostrContextTypes';
// DM-inbox sibling context (#806) lives in its own module; re-export the
// consumer hook so the public surface stays at `NostrContext` like
// `useNostr` / `useNostrContacts`.
export { useNostrDmInbox } from './DmInboxContext';

// Per-message reaction methods (#205) come straight from `useReactionActions`
// (publish kind-7 / retract kind-5 / fetch reactions / fetch kind-5 deletions);
// extend its result type rather than re-declaring the four signatures here.
interface NostrContextType extends UseReactionActionsResult {
  isLoggedIn: boolean;
  isLoggingIn: boolean;
  /** Logged-in user's hex pubkey, or null when logged out. */
  pubkey: string | null;
  profile: NostrProfile | null;
  relays: RelayConfig[];
  /**
   * Relays the user has explicitly added in-app via the Nostr settings
   * screen (#202). Subset of `relays` — exposed separately so the
   * editor UI can distinguish user-managed rows (removable) from
   * NIP-65 / default rows (read-only here; users edit those via
   * another Nostr client for now).
   */
  userRelays: RelayConfig[];
  /** The user's published NIP-65 (kind-10002) list, as last fetched/published. */
  nip65Relays: RelayConfig[];
  /** Adopt (and cache) a relay list the user just published in-app. */
  applyPublishedRelayList: (
    pk: string,
    list: RelayConfig[],
    createdAt?: number,
  ) => Promise<AdoptResult>;
  /** The user's own NIP-17 DM inbox relays (kind 10050); read for DMs. */
  dmInboxRelays: string[];
  /** Adopt (and cache) DM inbox relays the user just published in-app. */
  applyPublishedDmInbox: (pk: string, list: string[], createdAt?: number) => Promise<AdoptResult>;
  /**
   * Add or update a user-managed relay. Replaces any existing entry
   * with the same URL (so toggling read/write on an existing user
   * relay works through the same call). Persists to AsyncStorage.
   */
  addUserRelay: (config: RelayConfig) => Promise<void>;
  /** Remove a user-managed relay by URL. Persists to AsyncStorage. */
  removeUserRelay: (url: string) => Promise<void>;
  signerType: SignerType | null;
  // Multi-account registry — every signed-in identity on this device.
  // Drives the drawer header switcher and the AccountSwitcherSheet
  // (#288). The active identity is the one whose `pubkey` matches the
  // `pubkey` field above; everything else is "warm in the drawer".
  identities: StoredIdentity[];
  // Flip the active identity to a registered one. No-op if pubkey is
  // already active or unknown to the registry. Tears down in-memory
  // state for the previous identity but keeps its disk caches around
  // so a switch back is instant.
  switchIdentity: (pubkey: string) => Promise<void>;
  // Remove a single identity from the registry. If it's the active
  // one, behaves like `logout` (with a successor switch if available);
  // otherwise wipes that identity's caches + entry, leaves active alone.
  signOutIdentity: (pubkey: string) => Promise<void>;
  loginWithNsec: (nsec: string) => Promise<{ success: boolean; error?: string }>;
  loginWithAmber: () => Promise<{ success: boolean; error?: string }>;
  /** Finalise a NIP-46 ("Nostr Connect" / bunker) pairing; see useNip46Login. */
  loginWithNip46: (connection: Nip46Connection) => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  /**
   * Re-fetch the logged-in user's kind-0.
   *
   * Default (no arg / `force: false`): honours the 24h cache — a no-op
   * when a cached profile is still fresh. Safe to call from
   * `useFocusEffect` on any tab without racking up relay round-trips.
   *
   * `force: true`: bypass the cache and hit relays. Reserved for
   * explicit user-initiated refreshes (pull-to-refresh, manual
   * "reload my profile" actions).
   */
  refreshProfile: (opts?: { force?: boolean }) => Promise<void>;
  // Fetch kind-0 profiles for arbitrary pubkeys (non-followed DM senders) (#664).
  fetchProfilesForPubkeys: (pubkeys: string[]) => Promise<Map<string, NostrProfile>>;
  signZapRequest: (
    recipientPubkey: string,
    amountSats: number,
    comment: string,
    // Optional kind-1/7516/etc event id to scope the zap to a single
    // note. When set, the resulting 9735 receipt carries the same `e`
    // tag — enables per-note aggregation (e.g. zaps-received pill on
    // find-log rows). Omit for plain zap-the-author flows.
    zapEventId?: string,
  ) => Promise<string | null>;
  publishProfile: (profileData: {
    name?: string;
    display_name?: string;
    picture?: string;
    banner?: string;
    about?: string;
    lud16?: string;
    nip05?: string;
  }) => Promise<boolean>;
  sendDirectMessage: (
    recipientPubkey: string,
    plaintext: string,
    hooks?: SendHooks,
  ) => Promise<SendResult>;
  /**
   * Gift-wrap a pre-built NIP-17 rumor of any inner kind (e.g. a kind-1068
   * NIP-88 poll or kind-1018 vote) to one or more recipients, keeping its
   * structured tags on the wire. See #203.
   */
  sendDirectRumor: MessageSendApi['sendDirectRumor'];
  /**
   * Send an encrypted NIP-17 kind-15 file message (e.g. a voice note) to a
   * 1:1 recipient. The blob is already AES-encrypted + uploaded; this
   * gift-wraps the URL + decryption key. See #235.
   */
  sendFileMessage: MessageSendApi['sendFileMessage'];
  /**
   * Share an NWC wallet with a 1:1 recipient (#431). The NWC connection string
   * is a bearer secret, so it is gift-wrapped into an encrypted NIP-17 DM
   * (inner kind `NWC_SHARE_KIND`) — never a public event. The recipient's
   * client renders it as an "Add NWC Wallet" card.
   */
  sendNwcShare: MessageSendApi['sendNwcShare'];
  /**
   * Persist an optimistic local- DM message to the per-conversation
   * cache so it survives navigating away + back before the NIP-17
   * self-wrap echo arrives. The matching merge dedup against the real
   * relay echo lives in `mergeConversationMessages`. Without this,
   * leaving the thread after sending a GIF (or any message) would
   * drop the optimistic bubble until the relay round-trip completes.
   */
  appendLocalDmMessage: (otherPubkey: string, msg: ConversationMessage) => Promise<void>;
  /**
   * Durably persist delivery status (#856) onto cached conversation rows by
   * id, so a sent bubble's tick survives a cold restart even when the relay
   * echo won the cache-write race against the optimistic local- row.
   */
  persistDeliveryStatuses: (
    otherPubkey: string,
    statusById: Record<string, DeliveryStatus>,
  ) => Promise<void>;
  /**
   * Send a NIP-17 group chat message to multiple recipients. Builds one
   * kind-14 rumor with `subject` + `p` tags for every member, then NIP-59
   * seal+wraps it once per recipient (including the sender for cross-device
   * visibility). NSEC-only — Amber group send is a follow-up. See PR #227.
   */
  sendGroupMessage: UseGroupMessagingResult['sendGroupMessage'];
  /**
   * Publish a parameterised-replaceable kind-30200 group-state event for
   * client-side group consensus. Idempotent on (creator, d-tag) — relays
   * keep only the latest per the NIP-33 spec.
   */
  publishGroupState: (input: {
    groupId: string;
    name: string;
    memberPubkeys: string[];
  }) => Promise<{ success: boolean; error?: string }>;
  fetchConversation: (
    otherPubkey: string,
    opts?: { signal?: AbortSignal },
  ) => Promise<ConversationMessage[]>;
  /**
   * Read-through (#868): the instant-paint set for a thread open — the union of
   * the per-conversation cache and the SAME encrypted-store rows the Messages
   * inbox preview is built from. Paint a thread from this on mount BEFORE the
   * slower `fetchConversation` relay round-trip (Arcade's `db_only=true`
   * pattern). Reading the store directly — not just the per-conversation cache
   * blob — is what stops the thread lagging the inbox for a DM an inbox-wide
   * refresh ingested (it writes the store, not the per-conv blob).
   */
  loadInitialConversation: (otherPubkey: string) => Promise<ConversationMessage[]>;
  signEvent: (event: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<SignedEvent | null>;
  // (reaction methods provided via `extends UseReactionActionsResult` above)
}

const NostrContext = createContext<NostrContextType | undefined>(undefined);

/**
 * Sibling context carrying the follow-list (`contacts`) and its mutators
 * (#779). Split out of `NostrContextType` so that `setContacts` — which
 * fires on cold start when ~600 follows load from cache — rebuilds ONLY
 * this value, not the main `contextValue`. Consumers that read only
 * `pubkey`/`relays` (e.g. `ExploreHomeScreen`) no longer re-render when
 * the contact list arrives, killing the measured ~340 ms cascade.
 *
 * NOTE: `contacts` STATE still lives in `NostrProvider` (it feeds
 * `followPubkeys` → `useDmInbox`); only the EXPOSED value moved here.
 */
interface NostrContactsContextType {
  contacts: NostrContact[];
  refreshContacts: () => Promise<void>;
  followContact: (pubkey: string) => Promise<boolean>;
  unfollowContact: (pubkey: string) => Promise<boolean>;
  addContact: (
    npubOrHex: string,
  ) => Promise<
    | { success: true; pubkey: string; alreadyFollowing?: boolean }
    | { success: false; error: string }
  >;
}

const NostrContactsContext = createContext<NostrContactsContextType | undefined>(undefined);

// Module-evaluation perf marker. Fires the first time this file is parsed,
// before any provider mounts. Catches "RN bundle finished loading,
// JS engine started executing our code" — the upstream of every other
// [Perf] line in this file.
perfLog('NostrContext module-eval');

const EMPTY_CONTACTS: NostrContact[] = [];

let __nostrProviderFirstRenderLogged = false;
let __nostrProviderLoggedInLogged = false;
export const NostrProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (!__nostrProviderFirstRenderLogged) {
    __nostrProviderFirstRenderLogged = true;
    perfLog('NostrProvider first render');
  }
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  // App defaults are per-account; personal NIP-65 and device choices keep precedence.
  const {
    nip65Relays,
    dmInboxRelays,
    resetRelayLists,
    applyPublishedDmInbox,
    loadRelaysFromCache,
    loadRelays,
    applyPublishedRelayList,
  } = useNip65Relays();
  const [userRelays, setUserRelaysState] = useState<RelayConfig[]>([]);
  const [pubkey, setPubkey] = useActiveNostrAccount(loadRelays);
  const relays = useAppNetworkRelays(pubkey, nip65Relays, userRelays);
  const [signerType, setSignerType] = useState<SignerType | null>(null);
  const [profile, setProfile, profileSetterFor] = useAccountState<NostrProfile | null>(
    pubkey,
    null,
  );
  const [contacts, setContacts, contactsSetterFor] = useAccountState(pubkey, EMPTY_CONTACTS);
  const [followHydrated, followHydratedSetterFor] = useFollowHydration(pubkey);
  // Multi-account registry (#288). Mirrors the SecureStore `identities_v1`
  // blob so the drawer header and AccountSwitcherSheet can render without
  // each rendering its own SecureStore round-trip. The `pubkey` state above
  // is the single source of truth for "who is the active identity"; this
  // array is the side-table of all signed-in identities for the switcher.
  const [identities, setIdentities] = useState<StoredIdentity[]>([]);

  /**
   * Set of followed pubkeys (lowercase hex). Used to gate who can land a
   * rumor in the inbox — see refreshDmInbox. Rebuilt from `contacts`
   * whenever that state updates.
   */
  const followPubkeys = useMemo(() => {
    return buildFollowSet(contacts.map((c) => c.pubkey));
  }, [contacts]);

  // Hydrate the user-added relay overrides once at mount. Persisted
  // separately from the NIP-65 cache so they survive logout/login and
  // are available before any relay round-trip completes.
  useEffect(() => {
    getUserRelays()
      .then((list) => {
        if (list.length > 0) setUserRelaysState(list);
      })
      .catch((e) => console.warn('[Nostr] failed to load user relays:', e));
  }, []);

  const addUserRelay = useCallback(
    async (config: RelayConfig): Promise<void> => {
      const next: RelayConfig[] = (() => {
        const existing = userRelays.findIndex((r) => r.url === config.url);
        if (existing >= 0) {
          const copy = [...userRelays];
          copy[existing] = config;
          return copy;
        }
        return [...userRelays, config];
      })();
      // Persist before updating React state so a failed write doesn't
      // leave the UI showing a row that will disappear on next reload.
      // The caller surfaces the thrown error to the user.
      await setUserRelays(next);
      setUserRelaysState(next);
    },
    [userRelays],
  );

  const removeUserRelay = useCallback(
    async (url: string): Promise<void> => {
      const next = userRelays.filter((r) => r.url !== url);
      // Persist before updating React state so a failed write doesn't
      // leave the UI looking like the row was removed when it'll be
      // back after a restart.
      await setUserRelays(next);
      setUserRelaysState(next);
    },
    [userRelays],
  );

  useEffect(() => {
    // Publish read relays so zap-receipt queries from WalletContext hit
    // the user's configured relays in addition to the app-level defaults.
    const read = relays.filter((r) => r.read).map((r) => r.url);
    nostrService.setCurrentUserReadRelays(read);
  }, [relays]);

  const getReadRelays = useCallback((): string[] => {
    const readRelays = relays.filter((r) => r.read).map((r) => r.url);
    const base =
      readRelays.length > 0 ? readRelays : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
    // Others deliver NIP-17 DMs to the user's own DM inbox relays — read them too.
    return [...new Set([...base, ...dmInboxRelays])];
  }, [relays, dmInboxRelays]);

  // DM inbox + conversation cluster (#703). State, refs, callbacks, and
  // the live-DM subscription effect for the NIP-04/NIP-17 inbox live in
  // `useDmInbox`. The provider threads in the identity + relay + follow
  // dependencies these paths close over, and re-exposes the returned
  // values through the context value below. `setDmInbox`,
  // `setAmberNip44Permission`, `hydrateDmInboxFromCache`, and
  // `knownWrapIdsRef` are consumed by the login / logout / switch-identity
  // flows that own those lifecycle transitions.
  const {
    dmInbox,
    dmInboxLoading,
    refreshDmInbox,
    fetchConversation,
    loadInitialConversation,
    appendLocalDmMessage,
    persistDeliveryStatuses,
    armLiveDmSub,
    amberNip44Permission,
    hydrateDmInboxFromCache,
    setDmInbox,
    setAmberNip44Permission,
    knownWrapIdsRef,
  } = useDmInbox({ pubkey, isLoggedIn, signerType, followPubkeys, followHydrated, getReadRelays });
  // Identity-transition teardown (switch + add-account logins); see helper.
  const { resetIdentityMemory, activateLoginPubkey } = useIdentityMemoryReset(pubkey, setPubkey, {
    setProfile,
    setContacts,
    setDmInbox,
    setAmberNip44Permission,
    resetRelayLists,
  });

  // Group-messaging cluster (#707). The NIP-17 group send + kind-30200
  // group-state publish callbacks live in `useGroupMessaging`. The provider
  // threads in the identity + relay dependencies these close over and
  // re-exposes the returned callbacks through the context value below.
  const { sendGroupMessage, publishGroupState } = useGroupMessaging({
    pubkey,
    isLoggedIn,
    signerType,
    relays,
  });

  // Cache-activity notifications (#740, #945) — live subs against the
  // viewer's owned cache coords: kind-1111 comments AND kind-7516 found-logs.
  // Fires `fireCacheNotification` per fresh arrival + fans found-logs out on
  // the in-app event bus (`notifyFoundLog`). See useCacheNotifications.
  useCacheNotifications({ pubkey, getReadRelays });

  const { loadProfile, loadProfileFromCache } = useOwnProfile(profileSetterFor);

  // Batch-fetch kind-0 profiles for arbitrary pubkeys (e.g. non-followed DM
  // senders, which `loadContacts`/`fetchProfiles` never fetch). Reads from the
  // user's relays; nostrService.fetchProfiles unions PROFILE_RELAYS for
  // coverage. Returns a pubkey→profile map; the caller owns caching (#664).
  const fetchProfilesForPubkeys = useCallback(
    async (pubkeys: string[]): Promise<Map<string, NostrProfile>> => {
      if (pubkeys.length === 0) return new Map();
      return nostrService.fetchProfiles(pubkeys, getReadRelays());
    },
    [getReadRelays],
  );

  const loadContactsFromCache = useCallback(
    async (pk: string) => {
      const setContacts = contactsSetterFor(pk);
      try {
        const t0 = Date.now();
        perfLog('loadContactsFromCache: start');
        const contactsKey = perAccountKey(CONTACTS_CACHE_KEY_BASE, pk);
        const profilesKey = perAccountKey(PROFILES_CACHE_KEY_BASE, pk);
        const contactsTsKey = perAccountKey(CONTACTS_TIMESTAMP_KEY_BASE, pk);
        const pairs = await AsyncStorage.multiGet([contactsKey, profilesKey, contactsTsKey]);
        perfLog('loadContactsFromCache: multiGet returned');
        let contactsJson: string | null = null;
        let profilesJson: string | null = null;
        let contactsTsStr: string | null = null;
        for (const [k, v] of pairs) {
          if (k === contactsKey) contactsJson = v;
          else if (k === profilesKey) profilesJson = v;
          else if (k === contactsTsKey) contactsTsStr = v;
        }
        perfLog(
          `loadContactsFromCache: blob sizes contacts=${contactsJson?.length ?? 0}B profiles=${profilesJson?.length ?? 0}B`,
        );
        // Previously: any contacts cache older than 24h short-circuited the
        // whole bootstrap, discarding the still-useful profile map and
        // painting an empty Friends tab while `loadContacts` ran the relay
        // fetch (#642). Even a stale follow list is a better first paint
        // than nothing — the relay refresh will overwrite it in seconds via
        // the stale-while-revalidate path in `loadContacts`. Profiles in
        // particular are identity data that change rarely; preserving them
        // means the per-row zap gate hydrates from cache instead of reading
        // `lightningAddress: null` for every contact during the kind-0
        // batch refetch.
        if (contactsTsStr && Date.now() - parseInt(contactsTsStr, 10) > CACHE_MAX_AGE_MS) {
          perfLog(
            'loadContactsFromCache: contacts cache stale, still hydrating from disk (relay refresh will reconcile)',
          );
        }
        const followSnapshot = await readFollowSnapshot(pk);
        if (contactsJson || followSnapshot) {
          const tParse = Date.now();
          // sanitizeContacts drops any junk pubkeys persisted before the
          // ingest-time HEX64 gate landed, so a poisoned cache self-heals on
          // the next read instead of rendering zero-prefixed rows (#855).
          const cached: NostrContact[] =
            followSnapshot?.contacts ?? sanitizeContacts(JSON.parse(contactsJson!));
          perfLog(`loadContactsFromCache: JSON.parse(contacts) ${Date.now() - tParse}ms`);
          if (profilesJson) {
            const tProfilesParse = Date.now();
            const profileMap: Record<string, NostrProfile> = JSON.parse(profilesJson);
            perfLog(`loadContactsFromCache: JSON.parse(profiles) ${Date.now() - tProfilesParse}ms`);
            const tMerge = Date.now();
            const withProfiles = cached.map((c) => ({
              ...c,
              profile: profileMap[c.pubkey] ?? c.profile,
            }));
            perfLog(
              `loadContactsFromCache: merge ${withProfiles.length} contacts ${Date.now() - tMerge}ms`,
            );
            startTransition(() => setContacts(withProfiles));
            perfLog(`loadContactsFromCache: setContacts dispatched (total ${Date.now() - t0}ms)`);
          } else {
            startTransition(() => setContacts(cached));
            perfLog(
              `loadContactsFromCache: setContacts (no profiles) dispatched (total ${Date.now() - t0}ms)`,
            );
          }
          return true;
        }
      } catch (error) {
        console.warn('Failed to load contacts cache:', error);
      }
      return false;
    },
    [contactsSetterFor],
  );

  const loadContacts = useCallback(
    async (
      pk: string,
      relayUrls: string[],
      opts?: { force?: boolean; awaitProfiles?: boolean },
    ) => {
      const setContacts = contactsSetterFor(pk);
      const finishFollowHydration = followHydratedSetterFor(pk);
      const { fetchedContacts, cachedProfileMap, cacheAgeMs } = await reconcileCachedContactFollows(
        pk,
        relayUrls,
        (cs) => startTransition(() => setContacts(cs)),
        (cs) =>
          startTransition(() => {
            setContacts(cs);
            finishFollowHydration();
          }),
      );
      const cacheFresh = cacheAgeMs < CACHE_MAX_AGE_MS;

      if (fetchedContacts.length === 0) return;

      const missingFromCache = fetchedContacts
        .map((c) => c.pubkey)
        .filter((pk) => !cachedProfileMap[pk]);

      // Fast path: cache is fresh *and* covers every current contact. Avatars
      // are already hydrated from cache above, so skip the 30-40s batch.
      // `force` skips this fast path so user-initiated refreshes always
      // re-hit relays.
      if (!opts?.force && cacheFresh && missingFromCache.length === 0) {
        if (__DEV__)
          console.log(
            `[Nostr] fetchProfiles: skipped (cache fresh @ ${Math.round(cacheAgeMs / 1000)}s old, all ${fetchedContacts.length} contacts cached)`,
          );
        return;
      }

      // When the cache is fresh, the "missing" contacts are the ones who had
      // no kind-0 response last time we asked. Re-querying on every cold
      // start costs 3 s for contacts that probably just never published a
      // profile — so we skip — but only for MISSING_PROFILE_RETRY_MS, much
      // shorter than the 24 h fast-path TTL, so a transient relay miss
      // resolves within the hour. `force` bypasses this too.
      const missingRetryFresh = !opts?.force && cacheAgeMs < MISSING_PROFILE_RETRY_MS;
      if (missingRetryFresh) {
        if (__DEV__)
          console.log(
            `[Nostr] fetchProfiles: skipped (cache ${Math.round(cacheAgeMs / 1000)}s old, ${missingFromCache.length} unknown profiles will retry after ${Math.round(MISSING_PROFILE_RETRY_MS / 1000)}s)`,
          );
        return;
      }

      // Cache stale — refresh all contacts' profiles. (When cacheFresh is
      // true we've already returned via one of the two fast paths above, so
      // the dropped "X served from cache" suffix would always be 0.)
      const pubkeysToFetch = fetchedContacts.map((c) => c.pubkey);

      // The kind-0 profile batch is the slow part (~90s cold for a 571-contact
      // list). The contact LIST — everything the follow-gate and DM-inbox
      // refresh depend on — is already resolved and in state by this point.
      // Callers that own a pull-to-refresh spinner (see `refreshContacts`,
      // `awaitProfiles: false`) let this batch run fire-and-forget: its
      // `onBatch` hook streams avatars in progressively, so the spinner can
      // clear the moment contacts are in rather than after every profile
      // lands. All other callers keep the original awaited behaviour. (#852)
      const runProfileFetch = async (): Promise<void> => {
        const t1 = Date.now();
        const profileMap = await nostrService.fetchProfiles(
          pubkeysToFetch,
          relayUrls,
          (partial) => {
            // Update UI incrementally as each batch of profiles arrives
            startTransition(() =>
              setContacts((prev) =>
                prev.map((c) => ({
                  ...c,
                  profile: partial.get(c.pubkey) ?? c.profile,
                })),
              ),
            );
          },
        );
        if (__DEV__)
          console.log(
            `[Nostr] fetchProfiles: ${Date.now() - t1}ms, ${profileMap.size}/${pubkeysToFetch.length} profiles loaded`,
          );
        await persistMergedProfileCache(pk, cachedProfileMap, profileMap);
      };

      if (opts?.awaitProfiles === false) {
        // Fire-and-forget: don't block the caller (spinner) on profiles.
        void runProfileFetch().catch((e) => {
          if (__DEV__) console.warn('[Nostr] fetchProfiles (background) failed:', e);
        });
      } else {
        await runProfileFetch();
      }
    },
    [contactsSetterFor, followHydratedSetterFor],
  );

  // Single-fire perf log when isLoggedIn becomes true — the
  // "login restored from cache" moment. Anchor for the boot path.
  useEffect(() => {
    if (isLoggedIn && !__nostrProviderLoggedInLogged) {
      __nostrProviderLoggedInLogged = true;
      perfLog('NostrProvider isLoggedIn=true');
    }
  }, [isLoggedIn]);

  // Auto-login on startup: load cache immediately, refresh from relays in background
  useEffect(() => {
    perfLog('NostrProvider auto-login effect fires');
    (async () => {
      try {
        // Hydrate the multi-account registry first so the switcher has
        // something to render even before the active identity finishes
        // loading. Empty array on a fresh install — the auto-login below
        // populates it when the legacy single-account keys are migrated.
        const blob = await loadIdentities();
        setIdentities(blob.identities);

        const storedSignerType = await SecureStore.getItemAsync(SIGNER_TYPE_KEY);
        let pk: string | null = null;

        let pendingNsec: string | null = null;
        if (storedSignerType === 'nsec') {
          const storedNsec = await SecureStore.getItemAsync(NSEC_KEY);
          if (storedNsec) {
            pk = nostrService.decodeNsec(storedNsec).pubkey;
            pendingNsec = storedNsec;
          }
        } else if (storedSignerType === 'amber') {
          const storedPubkey = await SecureStore.getItemAsync(PUBKEY_KEY);
          if (storedPubkey) {
            pk = storedPubkey;
          }
        } else if (storedSignerType === 'nip46') {
          // Restore the persisted bunker connection (see useNip46Login).
          pk = await restoreNip46Session();
        }

        if (!pk) return;

        // One-time per-account storage migration (#288). MUST run before
        // `setPubkey(pk)` below because `setPubkey` triggers the effect
        // that calls `setActivePubkeyForWalletStorage(pubkey)` — which
        // unblocks `awaitActivePubkeyHydrated()` in WalletContext. If
        // the migration runs AFTER setPubkey, WalletContext can race
        // ahead and read `wallet_list_${pk}` before the migration has
        // copied legacy `wallet_list` → `wallet_list_${pk}` (#442
        // Copilot review). Self-contained in
        // `migrateToPerAccountStorage`: runs once, copies legacy global
        // values to `${base}_${pk}`, sets a flag, short-circuits
        // afterwards. Adds <50 ms to cold start.
        try {
          const result = await migrateToPerAccountStorage(pk);
          if (__DEV__ && !result.alreadyDone) {
            console.log(
              `[Nostr] per-account storage migration: copied ${result.ranSteps} keys`,
              result.copiedKeys,
            );
          }
        } catch (e) {
          console.warn('[Nostr] per-account storage migration failed:', e);
        }

        // Now safe to publish the pubkey + signer type — WalletContext's
        // gate will unblock and the per-account `wallet_list_${pk}` is
        // already populated (whether by migration just above or by an
        // earlier run that short-circuited).
        setPubkey(pk);
        if (storedSignerType === 'nsec') {
          setSignerType('nsec');
          setIsLoggedIn(true);
          if (!blob.identities.some((i) => i.pubkey === pk) && pendingNsec) {
            const next = await upsertIdentity({
              pubkey: pk,
              signerType: 'nsec',
              nsec: pendingNsec,
              lastUsedAt: Date.now(),
            });
            setIdentities(next.identities);
          }
        } else if (storedSignerType === 'amber') {
          setSignerType('amber');
          setIsLoggedIn(true);
          if (!blob.identities.some((i) => i.pubkey === pk)) {
            const next = await upsertIdentity({
              pubkey: pk,
              signerType: 'amber',
              lastUsedAt: Date.now(),
            });
            setIdentities(next.identities);
          }
        } else if (storedSignerType === 'nip46') {
          // Not in the multi-account registry; connection is live above.
          setSignerType('nip46');
          setIsLoggedIn(true);
        }

        // Eagerly hydrate cached state from disk in parallel — these
        // are all small per-account AsyncStorage reads (<100 ms each)
        // and they wire UI surfaces that would otherwise stay empty
        // until the deferred parallel refresh fires:
        //   - `profile` → drawer header + tab profile avatar
        //   - `relays`  → relay-dependent fan-out (kind-0 publish,
        //                 NIP-17 send, group membership republish)
        //   - `contacts` → friends list + DM partner resolution
        //   - `dmInbox`  → Messages tab paints on first frame
        // Previously only contacts + dmInbox were sync-hydrated; the
        // grace window before the deferred refresh left profile +
        // relays null for ~1.5 s after Home rendered, which made
        // drawer-header avatars and relay-aware code paths see empty
        // state on cold start. (Followup of perf review on PR #495.)
        await Promise.all([
          loadProfileFromCache(pk),
          loadRelaysFromCache(pk),
          loadContactsFromCache(pk),
          hydrateDmInboxFromCache(pk),
        ]);

        // Defer relay fetches until after animations/rendering complete,
        // PLUS a 1500 ms grace window so the user can tap Send / Receive
        // / Transfer in the first ~1.5 s of cold-start without the JS
        // thread being yanked away by parallel kind-3 + kind-0 +
        // kind-10002 fetches. `runAfterInteractions` alone fires on the
        // next tick when nothing is registered, so it doesn't actually
        // give us breathing room here. The setTimeout pulls the bulk
        // refresh out of the cold-start critical path entirely — the
        // "Send sheet feels frozen for the first few seconds" symptom
        // tracked in perf logcats lined up exactly with this batch
        // running back-to-back with the inbox drain on the JS thread.
        //
        // Seed the working relay set from the cached NIP-65 relay list so
        // `loadProfile` / `loadContacts` hit the relays the user actually
        // publishes to — not `DEFAULT_RELAYS`, which might miss their
        // kind-0/kind-3 entirely. Only falls back to DEFAULT_RELAYS on
        // the very first login (before any relay cache exists).
        const COLD_START_GRACE_MS = 1500;
        setTimeout(() => {
          InteractionManager.runAfterInteractions(async () => {
            let workingRelays: string[] = enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
            // Ignore the timestamp here — even a stale cached relay list is
            // better than DEFAULT_RELAYS for reaching user-only relays.
            const { value: cachedRelays } = await readCachedWithTtl<RelayConfig[]>(
              perAccountKey(RELAY_LIST_CACHE_KEY_BASE, pk!),
              perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, pk!),
            );
            if (cachedRelays) {
              const readRelays = cachedRelays.filter((r) => r.read).map((r) => r.url);
              if (readRelays.length > 0) workingRelays = readRelays;
            }

            const t0 = Date.now();
            // [PerfBlock] per-loader timing — `parallel refresh` shows
            // total wall-clock but masks which of the three loaders is
            // the bottleneck. These per-loader markers let us see
            // (a) which finishes last (slowest relay path) and (b)
            // which one's resolution kicks off the heavy setState
            // chain that follows. #554.
            const __tR = Date.now();
            const __tP = Date.now();
            const __tC = Date.now();
            const relayRefresh = loadRelays(pk!);
            Promise.all([
              relayRefresh
                .catch((e) => console.warn('[Nostr] relay refresh failed:', e))
                .finally(() => console.log(`[PerfBlock] loadRelays: ${Date.now() - __tR}ms`)),
              loadProfile(pk!, workingRelays)
                .catch((e) => console.warn('[Nostr] profile refresh failed:', e))
                .finally(() => console.log(`[PerfBlock] loadProfile: ${Date.now() - __tP}ms`)),
              relayRefresh
                .then((latestRelays) => loadContacts(pk!, [...workingRelays, ...latestRelays]))
                .catch((e) => console.warn('[Nostr] contact refresh failed:', e))
                .finally(() => console.log(`[PerfBlock] loadContacts: ${Date.now() - __tC}ms`)),
            ]).then(() => {
              if (__DEV__) console.log(`[Nostr] parallel refresh complete in ${Date.now() - t0}ms`);
            });
          });
        }, COLD_START_GRACE_MS);
      } catch (error) {
        console.warn('Nostr auto-login failed:', error);
      }
    })();
  }, [
    setPubkey,
    loadRelays,
    loadProfile,
    loadContacts,
    loadProfileFromCache,
    loadRelaysFromCache,
    loadContactsFromCache,
    hydrateDmInboxFromCache,
  ]);

  const loginWithNsec = useCallback(
    async (nsec: string): Promise<{ success: boolean; error?: string }> => {
      setIsLoggingIn(true);
      try {
        const trimmed = nsec.trim();
        if (!trimmed.startsWith('nsec1')) {
          return { success: false, error: 'Key must start with nsec1' };
        }

        const { pubkey: pk } = nostrService.decodeNsec(trimmed);
        activateLoginPubkey(pk);

        // Store credentials in the legacy single-active-identity slots via the
        // canonical writer (hardened, device-only keychain) AND register the
        // identity in the multi-account store so the switcher knows it (#288).
        await persistActiveIdentityKeys({ pubkey: pk, signerType: 'nsec', nsec: trimmed });
        const next = await upsertIdentity({
          pubkey: pk,
          signerType: 'nsec',
          nsec: trimmed,
          lastUsedAt: Date.now(),
        });
        setIdentities(next.identities);

        setSignerType('nsec');
        setIsLoggedIn(true);
        setIsLoggingIn(false);

        // Restart the background DM watch if the user has it enabled — a
        // full logout stopped it, and the launch-time sync has already run,
        // so without this the toggle would read ON with nothing watching
        // until the next app relaunch (#279).
        void syncBackgroundDmWatchFromPreference().catch((e) => {
          if (__DEV__) console.warn('[Nostr] post-login watch sync failed:', e);
        });

        // First-launch migration for this identity — idempotent flag
        // means this is a no-op once the user has migrated on any
        // previous login.
        try {
          await migrateToPerAccountStorage(pk);
        } catch (e) {
          if (__DEV__) console.warn('[Nostr] per-account migration on login failed:', e);
        }

        // Load cached contacts immediately, fetch fresh data in background
        await loadContactsFromCache(pk);
        // Eagerly hydrate dmInbox from disk cache so Messages tab paints
        // on first focus instead of staying blank for the relay round-trip.
        await hydrateDmInboxFromCache(pk);
        InteractionManager.runAfterInteractions(async () => {
          try {
            const readRelays = await loadRelays(pk);
            await loadProfile(pk, readRelays);
            loadContacts(pk, readRelays).catch((e) =>
              console.warn('Background contact refresh failed:', e),
            );
          } catch (error) {
            console.warn('Nsec post-login refresh failed:', error);
          }
        });

        return { success: true };
      } catch (error) {
        // Sanitize error messages to never expose nsec
        let message = error instanceof Error ? error.message : 'Failed to login';
        if (message.includes('nsec')) message = 'Invalid private key';
        return { success: false, error: message };
      } finally {
        setIsLoggingIn(false);
      }
    },
    [
      activateLoginPubkey,
      loadRelays,
      loadProfile,
      loadContacts,
      loadContactsFromCache,
      hydrateDmInboxFromCache,
    ],
  );

  const loginWithAmber = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!amberService.isAmberSupported()) {
      return { success: false, error: 'Amber is only supported on Android' };
    }
    setIsLoggingIn(true);
    try {
      // Native module uses startActivityForResult — returns pubkey directly
      const pk = await amberService.requestPublicKey();

      activateLoginPubkey(pk);
      await persistActiveIdentityKeys({ pubkey: pk, signerType: 'amber' });
      const next = await upsertIdentity({
        pubkey: pk,
        signerType: 'amber',
        lastUsedAt: Date.now(),
      });
      setIdentities(next.identities);

      setSignerType('amber');
      setIsLoggedIn(true);
      setIsLoggingIn(false);

      // Mirror the nsec login: restart the watch if enabled — see the
      // comment there (#279). Amber identities get contentless alerts.
      void syncBackgroundDmWatchFromPreference().catch((e) => {
        if (__DEV__) console.warn('[Nostr] post-login watch sync failed:', e);
      });

      try {
        await migrateToPerAccountStorage(pk);
      } catch (e) {
        if (__DEV__) console.warn('[Nostr] per-account migration on login failed:', e);
      }

      // Load cached contacts immediately, fetch fresh data in background
      await loadContactsFromCache(pk);
      // Eagerly hydrate dmInbox from disk cache so Messages tab paints
      // on first focus instead of staying blank for the relay round-trip.
      await hydrateDmInboxFromCache(pk);
      InteractionManager.runAfterInteractions(async () => {
        try {
          const readRelays = await loadRelays(pk);
          await loadProfile(pk, readRelays);
          loadContacts(pk, readRelays).catch((e) =>
            console.warn('Background contact refresh failed:', e),
          );
        } catch (error) {
          console.warn('Amber post-login refresh failed:', error);
        }
      });

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Amber login failed';
      return { success: false, error: message };
    } finally {
      setIsLoggingIn(false);
    }
  }, [
    activateLoginPubkey,
    loadRelays,
    loadProfile,
    loadContacts,
    loadContactsFromCache,
    hydrateDmInboxFromCache,
  ]);

  // NIP-46 login lives in its own hook (#283); see useNip46Login.
  const loginWithNip46 = useNip46Login({
    setIsLoggingIn,
    setPubkey: activateLoginPubkey,
    setSignerType,
    setIsLoggedIn,
    loadRelays,
    loadProfile,
    loadContacts,
    loadContactsFromCache,
    hydrateDmInboxFromCache,
  });

  // Wipe every per-account AsyncStorage entry for `loggedOutPubkey`.
  // Extracted so the multi-account sign-out path can call it without
  // coupling to the active-identity teardown logic (#288).
  const logout = useCallback(async () => {
    // While the signer still works: take our invitation keys off relays (#1204).
    if (pubkey) await invitationKeys.retireInvitationKeys({ owner: pubkey, signerType });
    dropIdentityKeyMaterial();
    setAmberNip44Permission('unknown');
    // Drop the in-memory NIP-17 wrap-id dedup Set — without this, a
    // sign-out then sign-back-in to the SAME pubkey would keep wrap
    // ids from the prior session alive in memory, and any wrap whose
    // on-disk cache entry got wiped by `wipeAccountCaches` below
    // would be permanently skipped by the live-sub early-return
    // (since the in-memory Set would still claim "seen"). Per Copilot
    // review on #508.
    knownWrapIdsRef.current = { pubkey: null, set: new Set() };
    const loggedOutPubkey = pubkey;
    await SecureStore.deleteItemAsync(NSEC_KEY);
    await SecureStore.deleteItemAsync(PUBKEY_KEY);
    await SecureStore.deleteItemAsync(SIGNER_TYPE_KEY);
    await SecureStore.deleteItemAsync(NIP46_CONNECTION_KEY);
    // Tear down the live BunkerSigner so the bunker stops serving the old
    // identity if someone signs back in immediately.
    await nostrConnectService.setActiveConnection(null).catch(() => {});
    // Clear the dead-key-as-of-#404 amber NIP-17 toggle alongside
    // the per-account caches.
    await AsyncStorage.removeItem(AMBER_NIP17_ENABLED_KEY_LEGACY).catch(() => {});

    await wipeAccountCaches(loggedOutPubkey);

    // Remove this identity from the multi-account registry. If other
    // identities exist the switcher will pick a successor; otherwise
    // we drop into the logged-out state below.
    let nextIdentities: StoredIdentity[] = [];
    let nextActive: string | null = null;
    if (loggedOutPubkey) {
      const blob = await removeIdentityFromStore(loggedOutPubkey);
      nextIdentities = blob.identities;
      nextActive = blob.activePubkey;
    }
    setIdentities(nextIdentities);

    if (nextActive && nextIdentities.length > 0) {
      // Switch to the successor without dropping into the logged-out
      // screen — feels seamless to the user (they sign out of Big Piggy
      // and immediately see Middle Piggy's caches).
      const successor = nextIdentities.find((i) => i.pubkey === nextActive);
      if (successor) {
        // Promote the successor (clear stale identity → set successor →
        // hydrate caches → deferred relay refresh). The teardown-before-set
        // ordering is what fixes the #851 F4 stale-drawer bug; see the helper.
        // Drop the signed-out account's relay lists (and in-flight loads) first.
        resetRelayLists();
        await promoteSuccessorIdentity(successor, {
          setProfile,
          setContacts,
          setPubkey,
          setSignerType,
          setIsLoggedIn,
          setDmInbox,
          loadProfileFromCache,
          loadContactsFromCache,
          hydrateDmInboxFromCache,
          loadRelays,
          loadProfile,
        });
        // Same staleness as switchIdentity: the watch is still subscribed
        // for the signed-out pubkey — swap it to the successor (#279).
        void rearmBackgroundDmWatchForActiveIdentity().catch((e) => {
          if (__DEV__) console.warn('[Nostr] post-sign-out watch re-arm failed:', e);
        });
        return;
      }
    }

    // Last identity gone — a still-running watch would keep receiving (and
    // notifying for) DMs to an account the user just signed out of. Stop the
    // service + subscription and dismiss the chip; the preference itself is
    // kept (device-level, like user relay overrides) so the next login's
    // sync re-arms it.
    // Awaited (not fire-and-forget) so the watch is deterministically dead
    // BEFORE the identity state below is cleared — otherwise there's a
    // window where it could still notify for the just-signed-out account.
    await stopBackgroundDmWatch().catch((e) => {
      if (__DEV__) console.warn('[Nostr] post-logout watch stop failed:', e);
    });

    setPubkey(null);
    setProfile(null);
    setContacts([]);
    resetRelayLists();
    // NOTE: deliberately NOT clearing user-added relays on logout —
    // they're an in-app preference, not per-account secret material.
    // The next account login will see the same overrides. To wipe
    // them, users can remove each row from the Nostr settings screen.
    setSignerType(null);
    setIsLoggedIn(false);

    // Last identity gone — delete the encrypted DM DB file AND its keystore
    // key (#690/#848). Per-identity sign-outs above only delete that owner's
    // rows; with no identities left the whole store is wipeable.
    await wipeLocalDmStore().catch(() => {});

    nostrService.cleanup();
  }, [
    setPubkey,
    resetRelayLists,
    pubkey,
    signerType,
    loadContactsFromCache,
    loadProfileFromCache,
    loadRelays,
    loadProfile,
    setContacts,
    setProfile,
    hydrateDmInboxFromCache,
    setDmInbox,
    setAmberNip44Permission,
    knownWrapIdsRef,
  ]);

  // Flip the active identity to `nextPubkey`. Must already be a
  // registered identity (call `loginWithNsec` / `loginWithAmber`
  // first to add a brand-new one). The flip:
  //   1. Persists the new active in `identities_v1` + the legacy
  //      single-identity SecureStore keys (NSEC/PUBKEY/SIGNER_TYPE),
  //      so a hard restart resumes on the new identity.
  //   2. Tears down the old identity's in-memory state (nip04 cache,
  //      memoised secret, profile, contacts, relays). Persistent
  //      caches are NOT touched — they're keyed per-pubkey, so the
  //      old identity's data stays on disk for the next switch back.
  //   3. Eagerly hydrates the new identity from disk caches so
  //      Friends / Messages tabs paint instantly without waiting for
  //      the relay round-trip.
  //
  // No-op if `nextPubkey === pubkey` (already active) or if the
  // pubkey isn't in the registry.
  const switchIdentity = useCallback(
    async (nextPubkey: string): Promise<void> => {
      if (nextPubkey === pubkey) return;
      const blob = await loadIdentities();
      const target = blob.identities.find((i) => i.pubkey === nextPubkey);
      if (!target) {
        if (__DEV__) console.warn(`[Nostr] switchIdentity: ${nextPubkey} not in registry`);
        return;
      }
      // Tear down the previous identity's in-memory state (on-disk caches
      // are per-account namespaced and kept, so a switch back is instant).
      resetIdentityMemory();

      // Promote the target identity to "active" everywhere — write the legacy
      // single-identity SecureStore slots and clear the other signer's stale
      // slot (we changed signer kind).
      await persistActiveIdentityKeys(target, { clearOtherSlot: true });
      const updated = await setActiveIdentity(target.pubkey);
      setIdentities(updated.identities);
      setPubkey(target.pubkey);
      setSignerType(target.signerType);
      setIsLoggedIn(true);

      // Re-arm the background DM watch for the new identity — the running
      // watch was subscribed for the previous pubkey and would keep
      // notifying for it until the next app relaunch (#279).
      void rearmBackgroundDmWatchForActiveIdentity().catch((e) => {
        if (__DEV__) console.warn('[Nostr] post-switch watch re-arm failed:', e);
      });

      // Eagerly hydrate from persisted per-account caches. The next
      // tab focus / pull-to-refresh will fan out to relays.
      await loadContactsFromCache(target.pubkey);
      await hydrateDmInboxFromCache(target.pubkey);
      // Defer the relay refresh — keeps the switch animation smooth.
      InteractionManager.runAfterInteractions(async () => {
        try {
          const readRelays = await loadRelays(target.pubkey);
          await loadProfile(target.pubkey, readRelays);
          loadContacts(target.pubkey, readRelays).catch((e) =>
            console.warn('[Nostr] post-switch contact refresh failed:', e),
          );
        } catch (e) {
          console.warn('[Nostr] post-switch refresh failed:', e);
        }
      });
    },
    [
      setPubkey,
      pubkey,
      resetIdentityMemory,
      loadContactsFromCache,
      hydrateDmInboxFromCache,
      loadRelays,
      loadProfile,
      loadContacts,
    ],
  );

  // Remove a single identity from the multi-account registry. If
  // `targetPubkey` is the active identity, behaves like `logout` (with
  // the post-removal switch to a successor if one exists). Otherwise
  // just wipes that identity's caches + registry entry; the active
  // identity stays put.
  const signOutIdentity = useCallback(
    async (targetPubkey: string): Promise<void> => {
      // Active-identity sign-out reuses the existing logout path so
      // the in-memory teardown stays in one place.
      if (targetPubkey === pubkey) {
        await logout();
        return;
      }
      await invitationKeys.retireStoredInvitationKeys(targetPubkey, identities);
      await wipeAccountCaches(targetPubkey);
      const blob = await removeIdentityFromStore(targetPubkey);
      setIdentities(blob.identities);
    },
    [pubkey, logout, identities],
  );

  const refreshProfile = useCallback(
    async (opts?: { force?: boolean }) => {
      if (!pubkey) return;
      const readRelays = getReadRelays();
      // Default respects the 24h cache so useFocusEffect callers don't
      // thrash the network on every tab switch. `force: true` is for
      // pull-to-refresh and other explicit user actions where we want
      // the latest kind-0 regardless of cache freshness.
      await loadProfile(pubkey, readRelays, { force: opts?.force === true });
    },
    [pubkey, getReadRelays, loadProfile],
  );

  // Follow-list write path (#779) — refresh / follow / unfollow / add and
  // the shared kind-3 publish — lives in useContactActions (file-size cap).
  // `contacts` state stays here (it feeds followPubkeys → the DM inbox); the
  // hook drives it via setContacts and force-refreshes through loadContacts.
  // The non-blocking pull-to-refresh path (#852) lives inside the hook, which
  // calls loadContacts with `awaitProfiles: false`.
  const { refreshContacts, followContact, unfollowContact, addContact } = useContactActions({
    pubkey,
    isLoggedIn,
    signerType,
    relays,
    contacts,
    setContacts,
    getReadRelays,
    loadContacts,
  });

  const publishProfile = useCallback(
    async (profileData: {
      name?: string;
      display_name?: string;
      picture?: string;
      banner?: string;
      about?: string;
      lud16?: string;
      nip05?: string;
    }): Promise<boolean> => {
      if (!pubkey || !isLoggedIn) return false;
      try {
        const event = nostrService.createProfileEvent(profileData);
        const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
        const targetRelays =
          writeRelays.length > 0
            ? writeRelays
            : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);

        if (signerType === 'nsec') {
          const nsec = await SecureStore.getItemAsync(NSEC_KEY);
          if (!nsec) return false;
          const { secretKey } = nostrService.decodeNsec(nsec);
          await nostrService.signAndPublishEvent(event, secretKey, targetRelays);
        } else if (signerType === 'amber') {
          const eventJson = JSON.stringify(event);
          const { event: signedEventJson } = await amberService.requestEventSignature(
            eventJson,
            '',
            pubkey,
          );
          if (!signedEventJson) return false;
          const signed = JSON.parse(signedEventJson);
          await nostrService.publishSignedEvent(signed, targetRelays);
        } else if (signerType === 'nip46') {
          const signedEventJson = await nip46Sign(event, pubkey);
          if (!signedEventJson) return false;
          await nostrService.publishSignedEvent(JSON.parse(signedEventJson), targetRelays);
        }

        // We just signed and published this kind-0, so the client already
        // has the authoritative new profile. Shortcut the relay round-trip
        // by updating local state + the 24h own-profile cache in-place,
        // otherwise the top-right profile icon keeps the pre-publish
        // avatar/name until the next force-refresh (up to 24h — see #148).
        //
        // Apply the same "drop falsy values" rule createProfileEvent uses
        // (service.ts:520-524) so local state matches exactly what was
        // published — a caller passing `name: ""` otherwise leaves the
        // cache with an empty string while the kind-0 on the wire omits
        // the field entirely.
        const nullIfEmpty = (v: string | undefined): string | null => (v ? v : null);
        const updatedProfile: NostrProfile = {
          pubkey,
          npub: nip19.npubEncode(pubkey),
          name: nullIfEmpty(profileData.name),
          displayName: nullIfEmpty(profileData.display_name),
          picture: nullIfEmpty(profileData.picture),
          banner: nullIfEmpty(profileData.banner),
          about: nullIfEmpty(profileData.about),
          lud16: nullIfEmpty(profileData.lud16),
          nip05: nullIfEmpty(profileData.nip05),
        };
        setProfile(updatedProfile);
        InteractionManager.runAfterInteractions(() => {
          AsyncStorage.setItem(
            perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, pubkey),
            JSON.stringify(updatedProfile),
          ).catch(() => {});
          AsyncStorage.setItem(
            perAccountKey(OWN_PROFILE_TIMESTAMP_KEY_BASE, pubkey),
            Date.now().toString(),
          ).catch(() => {});
        });

        return true;
      } catch (error) {
        console.warn('Failed to publish profile:', error);
        return false;
      }
    },
    [setProfile, pubkey, isLoggedIn, signerType, relays],
  );

  /**
   * Send a 1:1 direct message via NIP-17 (kind-14 rumor → kind-13 seal →
   * kind-1059 gift wrap). NIP-04 (kind 4) is no longer produced — see
   * issue #140 and `docs/PROTOCOLS.adoc`. Reads of legacy kind-4 history
   * are unchanged: `fetchConversation` and `refreshDmInbox` still query
   * and decrypt kind 4 alongside kind 1059 so old threads survive.
   *
   * Reuses the same `sendNip17ToManyWith{Nsec,Signer}` plumbing as
   * `sendGroupMessage`, with the recipient list being a single peer.
   * `wrapManyEvents` (nsec) and the sequential signer loop (Amber) both
   * also wrap for the sender, so the message lands in the user's own
   * inbox on other devices — the same multi-device behaviour group
   * messages have today.
   */
  // 1:1 sends — text + encrypted file (voice note, #235) — live in
  // useMessageSend (#703). Group send + group-state live in useGroupMessaging
  // (wired above). We take ONLY the 1:1 sends here so sendGroupMessage /
  // publishGroupState aren't declared twice.
  const { sendDirectMessage, sendDirectRumor, sendFileMessage, sendNwcShare } = useMessageSend({
    pubkey,
    isLoggedIn,
    signerType,
    relays,
  });

  const signEvent = useRelayAuthSigner(pubkey, isLoggedIn, signerType, nip65Relays, dmInboxRelays);

  const signZapRequest = useCallback(
    async (
      recipientPubkey: string,
      amountSats: number,
      comment: string,
      zapEventId?: string,
    ): Promise<string | null> => {
      if (!pubkey || !isLoggedIn) return null;
      const zapEvent = nostrService.createZapRequestEvent(
        pubkey,
        recipientPubkey,
        amountSats * 1000,
        getReadRelays(),
        comment,
        zapEventId,
      );
      const signed = await signEvent(zapEvent);
      return signed ? JSON.stringify(signed) : null;
    },
    [pubkey, isLoggedIn, getReadRelays, signEvent],
  );

  // Per-message reactions (#205) — publish / retract / fetch. Composed from a
  // hook (file-size cap) that wires in the signer + relay state owned here.
  const {
    publishReaction,
    deleteReaction,
    fetchReactionsForMessages,
    fetchReactionDeletionsForReactions,
  } = useReactionActions({
    pubkey,
    isLoggedIn,
    signEvent,
    relays,
    getReadRelays,
  });

  const contextValue = useMemo(
    () => ({
      isLoggedIn,
      isLoggingIn,
      pubkey,
      profile,
      relays,
      userRelays,
      nip65Relays,
      applyPublishedRelayList,
      dmInboxRelays,
      applyPublishedDmInbox,
      addUserRelay,
      removeUserRelay,
      signerType,
      identities,
      switchIdentity,
      signOutIdentity,
      loginWithNsec,
      loginWithAmber,
      loginWithNip46,
      logout,
      refreshProfile,
      fetchProfilesForPubkeys,
      signZapRequest,
      publishProfile,
      sendDirectMessage,
      sendDirectRumor,
      sendFileMessage,
      sendNwcShare,
      sendGroupMessage,
      publishGroupState,
      fetchConversation,
      loadInitialConversation,
      appendLocalDmMessage,
      persistDeliveryStatuses,
      signEvent,
      publishReaction,
      deleteReaction,
      fetchReactionsForMessages,
      fetchReactionDeletionsForReactions,
    }),
    [
      isLoggedIn,
      isLoggingIn,
      pubkey,
      profile,
      relays,
      userRelays,
      nip65Relays,
      applyPublishedRelayList,
      dmInboxRelays,
      applyPublishedDmInbox,
      addUserRelay,
      removeUserRelay,
      signerType,
      identities,
      switchIdentity,
      signOutIdentity,
      loginWithNsec,
      loginWithAmber,
      loginWithNip46,
      logout,
      refreshProfile,
      fetchProfilesForPubkeys,
      signZapRequest,
      publishProfile,
      sendDirectMessage,
      sendDirectRumor,
      sendFileMessage,
      sendNwcShare,
      sendGroupMessage,
      publishGroupState,
      fetchConversation,
      loadInitialConversation,
      appendLocalDmMessage,
      persistDeliveryStatuses,
      signEvent,
      publishReaction,
      deleteReaction,
      fetchReactionsForMessages,
      fetchReactionDeletionsForReactions,
    ],
  );

  // Sibling value carrying contacts + mutators (#779). Memoised separately
  // so `setContacts` rebuilds only this — not `contextValue` above.
  const contactsValue = useMemo(
    () => ({ contacts, refreshContacts, followContact, unfollowContact, addContact }),
    [contacts, refreshContacts, followContact, unfollowContact, addContact],
  );

  // Sibling value carrying the hot DM-inbox slice (#806). Memoised separately
  // so a decrypted message rebuilds only this — not `contextValue` above — and
  // only `useNostrDmInbox()` consumers re-render on inbox churn.
  // `amberNip44Permission` lives here (not in the main value) because it is
  // DM-subsystem state flipped by every Amber inbox drain — in the main value
  // each flip re-rendered all ~40 `useNostr()` consumers for a field only the
  // account screen reads.
  const dmInboxValue = useMemo(
    () => ({ dmInbox, dmInboxLoading, refreshDmInbox, armLiveDmSub, amberNip44Permission }),
    [dmInbox, dmInboxLoading, refreshDmInbox, armLiveDmSub, amberNip44Permission],
  );

  return (
    <NostrContext.Provider value={contextValue}>
      <NostrContactsContext.Provider value={contactsValue}>
        <DmInboxContext.Provider value={dmInboxValue}>{children}</DmInboxContext.Provider>
      </NostrContactsContext.Provider>
    </NostrContext.Provider>
  );
};

export function useNostr() {
  const context = useContext(NostrContext);
  if (!context) {
    throw new Error('useNostr must be used within a NostrProvider');
  }
  return context;
}

/**
 * Access the follow-list (`contacts`) and its mutators (#779). Served
 * from a sibling provider so consumers of this hook re-render on
 * `setContacts` while plain `useNostr()` consumers do not.
 */
export function useNostrContacts() {
  const context = useContext(NostrContactsContext);
  if (!context) {
    throw new Error('useNostrContacts must be used within a NostrProvider');
  }
  return context;
}
