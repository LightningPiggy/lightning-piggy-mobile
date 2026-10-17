import { enabledAppRelays } from '../services/appRelayPrefs';
import { groupDisplay } from '../utils/groupDisplay';
import { useAccountState } from './useAccountState';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Group, GroupActivity, GroupSummary } from '../types/groups';
import {
  createGroupId,
  loadGroupActivity,
  loadGroups,
  saveGroupActivity,
  saveGroups,
} from '../services/groupsStorageService';
import {
  setKnownGroups,
  setSyntheticGroupReconciler,
  type SyntheticRoomInput,
} from '../services/groupRoutingRegistry';
import {
  loadGroupMessages,
  reviveGroupHistoryOwner,
} from '../services/groupMessagesStorageService';
import { useNostr, useNostrContacts, subscribeGroupMessages } from './NostrContext';
import {
  DEFAULT_RELAYS,
  GROUP_STATE_KIND,
  subscribeGroupStateForViewer,
} from '../services/nostrService';
import { perAccountKey } from '../services/perAccountStorage';
import { useTrustGraph } from './TrustGraphContext';
import {
  saveWotSettings,
  WOT_STORAGE_KEY_BASE,
  type WotTier,
} from '../services/wotSettingsService';
import { loadSecretMode, saveSecretMode } from '../services/secretModeService';
import {
  ensureSafetySettingsMigrated,
  SECRET_MODE_KEY_BASE,
} from '../services/safetySettingsMigration';
import { deriveInitialWotTier } from '../utils/wotMigration';
import { activityFromMessages } from '../utils/groupActivity';
import { isMarmotGroupId } from '../services/marmotSession';
import { isNip171GroupId } from '../utils/nip171';
import { useNip171Groups } from './useNip171Groups';
import { useMarmotGroups } from './useMarmotGroups';

const FOLLOWING_ONLY_KEY_BASE = 'groups_following_only';
// One-shot migration marker keyed off the legacy followingOnly → wotTier
// derivation (#547). The migration only runs once per device — after the
// first successful derive we set this flag so re-mounts of GroupsProvider
// (account switches, hot reload) never re-stomp a wotTier the user has
// since edited via the WoT bottom sheet.
const WOT_MIGRATION_DONE_KEY = '@lp:wot-migration:v1-from-followingOnly';

interface GroupsContextType {
  groups: Group[];
  /**
   * Groups filtered by the friend-graph "Following only" rule plus the
   * (dev-mode-only) user toggle. This is what GroupsScreen renders by
   * default — see `followingOnly` / `setFollowingOnly`.
   */
  visibleGroups: Group[];
  /**
   * @deprecated Since #547 the messages + groups filter is driven by the
   * three-tier `wotTier` in TrustGraphContext, not this boolean. Kept
   * exposed for the migration window so any external consumer doesn't
   * crash — derived from `effectiveWotTier !== 'all'`. New code should
   * read `effectiveWotTier` (or `useTrustGraph().wotTier`) directly.
   */
  followingOnly: boolean;
  /**
   * @deprecated See `followingOnly`. Setting this maps onto `setWotTier`:
   * true → 'friends', false → 'all'. Since #640 removed the secret-mode
   * clamp this is simply a pass-through to the global WoT picker — kept
   * for any out-of-tree consumer that still flips the boolean.
   */
  setFollowingOnly: (next: boolean) => void;
  // Effective WoT tier. Used to differ from `wotTier` via a secret-mode
  // clamp (#547); since #640 removed that clamp the two values are
  // identical. The field is retained so in-tree readers don't all need
  // changing in one go — new code should prefer `useTrustGraph().wotTier`
  // directly.
  effectiveWotTier: WotTier;
  /** Mirrors AsyncStorage `secret_mode`. Controls whether the chip is interactive. */
  secretMode: boolean;
  /**
   * Persist + broadcast a new secret-mode value. Writes to AsyncStorage
   * AND updates the context state so every consumer (AboutScreen,
   * Messages, Groups, Hunt's WoT picker) sees the change immediately.
   * Without this setter the triple-tap on About would only update
   * AboutScreen's local state, leaving consumers stuck on the value
   * read at GroupsProvider mount — the cause of the "WoT chip stays
   * disabled even though I just enabled secret mode" bug.
   */
  setSecretMode: (next: boolean) => void;
  loading: boolean;
  createGroup: (name: string, memberPubkeys: string[], protocol?: 'marmot') => Promise<Group>;
  renameGroup: (groupId: string, newName: string) => Promise<boolean>;
  /** Append unique pubkeys to the group's member list. Returns the
   * updated group, or null if the group doesn't exist. Re-publishes
   * the kind-30200 group-state event so other members pick up the
   * new roster (best-effort; failures are non-fatal). */
  addMembersToGroup: (groupId: string, pubkeys: string[]) => Promise<Group | null>;
  /** Remove a single pubkey from the group's member list. Returns
   * the updated group, or null if the group doesn't exist or the
   * pubkey wasn't a member. Re-publishes group state on success. */
  removeMemberFromGroup: (groupId: string, pubkey: string) => Promise<Group | null>;
  /** Marmot only: change the group's admin set — `update` maps the current set
   * to the new one at commit time (an MLS commit; rejects for NIP-17 groups,
   * which have no admins). */
  setGroupAdmins: (groupId: string, update: (current: string[]) => string[]) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  getGroup: (groupId: string) => Group | undefined;
  /**
   * Reconcile a kind-30200 group-state event into local state. Returns
   * true if a change was applied. Caller is responsible for filtering by
   * sender (we trust whatever the subscriber feeds in).
   */
  reconcileFromGroupStateEvent: (input: {
    senderPubkey: string;
    groupId: string;
    name: string;
    memberPubkeys: string[];
    createdAt: number;
  }) => Promise<boolean>;
  /**
   * `visibleGroups` joined with their per-group activity (last message,
   * recent senders), sorted newest-first. This is what the Messages tab
   * renders so groups appear inline with 1:1 DMs.
   */
  groupSummaries: GroupSummary[];
}

const GroupsContext = createContext<GroupsContextType | undefined>(undefined);

const EMPTY_GROUPS: Group[] = [];
const EMPTY_ACTIVITY: Record<string, GroupActivity> = {};

export const GroupsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // NIP-17 groups (AsyncStorage-persisted). Marmot groups are merged in below.
  const { publishGroupState, pubkey, relays, isLoggedIn, sendDirectMessage } = useNostr();
  // Re-activating a signed-out account lifts its group-history write guard
  // (#1240). Layout effect: before any child effect can write its history.
  useLayoutEffect(() => reviveGroupHistoryOwner(pubkey), [pubkey]);
  const { contacts } = useNostrContacts();
  const [storedGroups, setGroups] = useAccountState(pubkey, EMPTY_GROUPS);
  const activeOwner = useRef(pubkey);
  activeOwner.current = pubkey;
  const [loading, setLoading] = useState(true);
  // Per account (shared family phone): owner-tagged so a switch never shows
  // the previous account's Secret Mode for even one render.
  const [secretMode, setSecretModeState] = useAccountState(pubkey, false);
  // Tier source-of-truth lives in TrustGraphContext (#547). We read it here
  // so visibleGroups can apply the same trust filter the Map / Hunt / Events
  // surfaces use — keeping the three-tier model unified across the app.
  // `isTrustedAtTier` (not `isTrusted`) so the `visibleGroups` filter
  // evaluates against `effectiveWotTier`. Otherwise a persisted 'all'
  // would short-circuit `isTrusted` even when the hard-lock clamps to
  // 'friends' (secretMode off), letting hidden groups leak past the
  // parental-control gate (#547 follow-up).
  const { wotTier, setWotTier, isTrustedAtTier } = useTrustGraph();
  // Per-group activity rollup (last message + recent senders). Populated
  // on mount from AsyncStorage and kept fresh by the inbound-message
  // listener below + a local hook from GroupConversationScreen sends.
  const [activityByGroup, setActivityByGroup] = useAccountState(pubkey, EMPTY_ACTIVITY);
  const contactName = useCallback(
    (pk: string) => {
      const c = contacts.find((x) => x.pubkey === pk);
      return c?.petname || c?.profile?.displayName || c?.profile?.name || pk.slice(0, 8);
    },
    [contacts],
  );
  const marmot = useMarmotGroups(pubkey, contactName);
  const nip171 = useNip171Groups(isLoggedIn ? pubkey : null);
  const groups = useMemo(
    () => [...storedGroups, ...marmot.groups, ...nip171.groups].map(groupDisplay),
    [storedGroups, marmot.groups, nip171.groups],
  );
  // Track the latest reconciler in a ref so the subscription effect can
  // call it without re-subscribing on every group state change.
  const reconcilerRef = useRef<
    | ((input: {
        senderPubkey: string;
        groupId: string;
        name: string;
        memberPubkeys: string[];
        createdAt: number;
      }) => Promise<boolean>)
    | null
  >(null);

  // Re-load groups whenever the active identity flips. Without keying
  // off pubkey, switching from Big Piggy to Middle Piggy would still
  // show Big's groups until a hard reload — the whole point of the
  // multi-account refactor (#288) is the seamless switch.
  useEffect(() => {
    if (!pubkey) {
      // Logged out: clear so a fresh login (or restart) doesn't render
      // the previous identity's group cache for a frame.
      setGroups([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    loadGroups(pubkey)
      .then((loaded) => {
        if (!cancelled) setGroups(loaded);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [pubkey, setGroups]);

  // Load the ACTIVE account's persisted secret-mode flag. The old device-wide
  // `secret_mode` (and pre-rename `dev_mode`) value is copied into every
  // account's namespace by `safetySettingsMigration`.
  useEffect(() => {
    let cancelled = false;
    loadSecretMode(pubkey).then((v) => {
      if (!cancelled) setSecretModeState(v);
    });
    return () => {
      cancelled = true;
    };
  }, [pubkey, setSecretModeState]);

  // One-shot legacy → tier migration (#547). The pre-#547 Messages /
  // Groups filter persisted a boolean `followingOnly` per account; the
  // unified WoT tier lives in a per-account key (`@lp:wot-settings:v1_<pubkey>`).
  // On first run after the upgrade we derive a starting tier from the
  // legacy boolean (+ secretMode) so the user's intent survives intact:
  //   followingOnly=true                       → 'friends'
  //   followingOnly=false && secretMode=true   → 'all' (legacy dev escape hatch)
  //   anything else                            → 'friends' (safe default)
  // Guarded by `WOT_MIGRATION_DONE_KEY` so it never re-runs; also skipped
  // entirely if the user has already saved a wotTier explicitly (so a
  // Map-side preference isn't stomped). Mirrors the dev_mode → secret_mode
  // migration pattern just above.
  useEffect(() => {
    // The migration reads a *per-account-scoped* key
    // (`perAccountKey(FOLLOWING_ONLY_KEY_BASE, pubkey)`). When the
    // provider mounts before identity hydration `pubkey` is still
    // null/undefined and `perAccountKey` would fall back to the un-
    // namespaced base key, potentially missing the real legacy value
    // and persisting `WOT_MIGRATION_DONE_KEY=true` before the actual
    // per-account legacy slot is reachable — permanently locking the
    // user into the safe default. Wait for hydration first; the effect
    // re-runs when `pubkey` lands.
    if (!pubkey) return;
    (async () => {
      const done = await AsyncStorage.getItem(WOT_MIGRATION_DONE_KEY);
      if (done === 'true') return;
      try {
        // Make sure the device-wide → per-account copy has landed first, so
        // the "already saved" probe below sees the real per-account value.
        await ensureSafetySettingsMigrated(pubkey);
        // Skip if the user has already saved an explicit wotTier — the
        // loadWotSettings call inside TrustGraphContext returns defaults
        // for a missing key, so we have to probe the raw storage slot.
        const existing = await AsyncStorage.getItem(perAccountKey(WOT_STORAGE_KEY_BASE, pubkey));
        if (existing !== null) {
          await AsyncStorage.setItem(WOT_MIGRATION_DONE_KEY, 'true');
          return;
        }
        // followingOnly was per-account; we migrate using whichever
        // account is currently active. Defaults to true (ON) if the
        // legacy key was never written.
        const raw = await AsyncStorage.getItem(perAccountKey(FOLLOWING_ONLY_KEY_BASE, pubkey));
        const followingOnlyLegacy: boolean | null = raw === null ? null : raw !== 'false';
        const secretRaw = await AsyncStorage.getItem(perAccountKey(SECRET_MODE_KEY_BASE, pubkey));
        const secret = secretRaw === 'true';
        const next = deriveInitialWotTier({
          followingOnly: followingOnlyLegacy,
          secretMode: secret,
        });
        // Persist directly via the service (cheaper than going through
        // TrustGraphContext's setter, which would also schedule a render)
        // and then notify the in-memory state so the UI picks it up on
        // the next render without waiting for loadWotSettings to re-run.
        await saveWotSettings({ wotTier: next }, pubkey);
        setWotTier(next);
        await AsyncStorage.setItem(WOT_MIGRATION_DONE_KEY, 'true');
      } catch {
        // Best-effort; failures leave the marker unset so a later mount
        // can retry. The user sees the safe default ('friends') in the
        // meantime, which is the conservative outcome.
      }
    })();
  }, [pubkey, setWotTier]);

  // Persist + broadcast a secret-mode toggle. Used by AboutScreen's
  // triple-tap unlock — keeping the writer in the context means every
  // subscriber (the WoT picker, Messages, Groups) sees the change in
  // the same render tick. Before this lived in the context, AboutScreen
  // had its own local useState which didn't reach the rest of the app,
  // so e.g. the "All" WoT tier stayed greyed out until a full app
  // restart re-read AsyncStorage from inside GroupsProvider.
  const setSecretMode = useCallback(
    (next: boolean) => {
      setSecretModeState(next);
      saveSecretMode(next, pubkey).catch(() => {});
    },
    [pubkey, setSecretModeState],
  );

  // `effectiveWotTier` previously clamped 'all' → 'friends' when secret
  // mode was off (#547 parental-control hard-lock). That clamp has been
  // removed (#640): the WoT picker is now the single source of truth
  // and what the user sees in the bottom sheet is what every surface —
  // including Messages — actually applies. Secret mode still controls
  // its other UI-affordance reveals (delete-group, dev build hash, etc.)
  // but no longer over-rides the tier. The field is retained on the
  // context so the wide audience of `useGroups().effectiveWotTier`
  // readers (Messages, Groups, the dev-only TestID hooks, plus the
  // deprecated `followingOnly` derivation below) don't all need
  // changing this turn; it now simply mirrors `wotTier`.
  const effectiveWotTier: WotTier = wotTier;

  // Deprecated boolean view of the tier — see the interface docstring.
  // Kept for any out-of-tree consumer; in-tree consumers should read
  // `effectiveWotTier` directly. `true` = filter-on (friends or fof),
  // `false` = filter-off ('all'). FoF is treated as "filter on" because
  // it still applies a trust gate, just a wider one.
  const followingOnly = effectiveWotTier !== 'all';

  const setFollowingOnly = useCallback(
    (next: boolean) => {
      // Map the legacy boolean back onto the tier: true → 'friends',
      // false → 'all'. The hard-lock guard in the predicate above means
      // a non-secret-mode user who flips this to false still sees the
      // 'friends' behaviour at the visibility layer.
      setWotTier(next ? 'friends' : 'all');
    },
    [setWotTier],
  );

  // Keep the module-level routing registry in lock-step with React state
  // so NostrContext's NIP-17 decrypt loop can resolve which group an
  // inbound rumor belongs to without going through context.
  useEffect(() => {
    setKnownGroups(storedGroups, pubkey); // NIP-17 routing only — never match a Marmot group
  }, [storedGroups, pubkey]);

  // Eagerly hydrate `activityByGroup` from the disk cache as soon as the
  // user identity is known. Without this, the Messages tab renders group
  // rows with placeholder activity (createdAt-based timestamp, empty
  // preview) until the per-group `loadGroupMessages` loop below resolves.
  // Mirrors the dmInbox eager-hydration pattern from PR #253. A single
  // AsyncStorage round-trip vs N per-group reads to first useful paint.
  //
  // The cache is keyed off `groups`, not `visibleGroups` — so it can
  // include entries for groups whose follow gate failed at write time.
  // The visible-list filter at `visibleGroups` re-applies downstream,
  // so unfollowed entries never reach the rendered list. Schema is
  // validated at load time by `loadGroupActivity` (entries with bad
  // shapes are dropped rather than crashing first paint via
  // `formatConversationTimestamp(NaN)`). Cleared on logout via
  // NostrContext.logout's per-pubkey cleanup.
  useEffect(() => {
    if (!isLoggedIn || !pubkey) return;
    let cancelled = false;
    loadGroupActivity(pubkey).then((cached) => {
      if (cancelled) return;
      if (Object.keys(cached).length === 0) return;
      // Merge under any in-memory entries that may have arrived first
      // (e.g. live subscribeGroupMessages updates) — those win.
      setActivityByGroup((prev) => ({ ...cached, ...prev }));
    });
    return () => {
      cancelled = true;
    };
  }, [isLoggedIn, pubkey, setActivityByGroup]);

  // Persist `activityByGroup` after every change so the next cold start
  // can hydrate from this cache. Debounced via setTimeout to coalesce
  // bursts (e.g. live message arrivals). Per-pubkey namespace mirrors
  // the dmInbox cache key pattern.
  useEffect(() => {
    if (!isLoggedIn || !pubkey) return;
    if (Object.keys(activityByGroup).length === 0) return;
    const handle = setTimeout(() => {
      saveGroupActivity(pubkey, activityByGroup).catch((e) => {
        if (__DEV__) console.warn('[Groups] saveGroupActivity failed:', e);
      });
    }, 500);
    return () => clearTimeout(handle);
  }, [activityByGroup, isLoggedIn, pubkey]);

  // Populate activity for any group we don't yet have a rollup for. Runs
  // after the initial loadGroups() resolves and again whenever a new
  // group is created/reconciled. We only load groups whose key isn't in
  // the map yet, so this stays cheap on subsequent renders.
  useEffect(() => {
    let cancelled = false;
    const missing = groups.filter((g) => !activityByGroup[g.id]);
    if (missing.length === 0) return;
    (async () => {
      const updates: Record<string, GroupActivity> = {};
      for (const g of missing) {
        const msgs = await loadGroupMessages(pubkey, g.id);
        updates[g.id] = activityFromMessages(g, msgs, pubkey);
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        setActivityByGroup((prev) => ({ ...prev, ...updates }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groups, activityByGroup, pubkey, setActivityByGroup]);

  // Inbound group messages are persisted by NostrContext's NIP-17 routing
  // loop; we just need to refresh the activity rollup for the affected
  // group so the Messages tab re-sorts. The listener fires after the
  // append, so a fresh load reflects the new tail.
  useEffect(() => {
    // A read that resolves after `groups` changes (e.g. an account switch
    // reset) must not merge the old account's activity into the new state.
    let active = true;
    const unsub = subscribeGroupMessages((groupId) => {
      const g = groups.find((x) => x.id === groupId);
      if (!g) return;
      loadGroupMessages(pubkey, groupId).then((msgs) => {
        if (!active) return;
        setActivityByGroup((prev) => ({
          ...prev,
          [groupId]: activityFromMessages(g, msgs, pubkey),
        }));
      });
    });
    return () => {
      active = false;
      unsub();
    };
  }, [groups, pubkey, setActivityByGroup]);

  // Anti-spam: a group is visible only if at least one OTHER member is
  // in the viewer's trust set at the current tier (#547). For 'friends'
  // the trust set is L1 follows + seeds + viewer; for 'fof' it adds L2
  // follows-of-follows; for 'all' the filter is disabled. Same defence-
  // in-depth rule the 1:1 DM gate uses inside MessagesScreen.
  const visibleGroups = useMemo(() => {
    if (effectiveWotTier === 'all') return groups;
    return groups.filter((g) =>
      g.memberPubkeys.some((pk) => isTrustedAtTier(effectiveWotTier, pk)),
    );
  }, [groups, effectiveWotTier, isTrustedAtTier]);

  // Synchronous mirror of the `groups` state used as the read source
  // for `persist` so concurrent mutators serialise correctly without
  // depending on React's setState batching/timing.
  //
  // Why this exists: the earlier "compute inside setGroups callback"
  // pattern still raced because the `await saveGroups(after)` line
  // could resolve before React processed the queued setter (in
  // unbatched async paths the setter runs synchronously, but in
  // batched paths it runs at flush time — so `after` could still hold
  // its initial `[]` when the AsyncStorage write started). Reading +
  // writing this ref synchronously inside `persist` guarantees that
  // (a) the next concurrent caller sees the latest committed mutation
  // immediately, and (b) `saveGroups` always serialises the post-
  // mutation array.
  const groupsRef = useRef<Group[]>([]);
  groupsRef.current = storedGroups;

  const persist = useCallback(
    async (mutate: (curr: Group[]) => Group[]): Promise<Group[]> => {
      if (activeOwner.current !== pubkey) return [];
      const after = mutate(groupsRef.current);
      // Update the ref BEFORE setGroups so a concurrent caller scheduled
      // immediately after this one reads the fresh array — otherwise
      // both callers' mutates would run against the same `curr` and the
      // second's write would clobber the first's.
      groupsRef.current = after;
      setGroups(after);
      await saveGroups(pubkey, after);
      return after;
    },
    [pubkey, setGroups],
  );

  // Synthetic-room reconciler: invoked from NostrContext's group routing
  // path when a kind-14 arrives from a foreign client (Amethyst / Quartz,
  // 0xchat) with no matching kind-30200. The id is a deterministic
  // SHA-256 of the participant set, so subsequent kind-14s from the
  // same room route to the same local thread. Subject is latest-wins
  // per NIP-17 spec ("the newest subject in the chat room is the
  // subject of the conversation").
  //
  // Stored as a regular Group entry (no kind-30200 publish, no member-
  // list mutation API) — synthetic rooms are read-only mirrors of
  // foreign-client conversations on LP. Sending into them re-uses the
  // normal sendGroupMessage path: the room's pubkey-set is reconstructed
  // from memberPubkeys + viewer, so the kind-14 lands at the same
  // participants and round-trips cleanly.
  //
  // Held behind a ref so the registry handler stays stable across
  // re-renders. The effect re-binds the ref body whenever `persist`
  // changes (today: never, since persist is `useCallback([])`), which
  // also means the registry pointer effectively installs once.
  const reconcileSyntheticRef = useRef<
    ((input: SyntheticRoomInput) => Promise<Group | null>) | null
  >(null);
  useEffect(() => {
    reconcileSyntheticRef.current = async (input) => {
      let resolved: Group | null = null;
      // createdAt on the rumor is in seconds; local state uses ms.
      const evMs = input.createdAtSec * 1000;
      await persist((curr) => {
        const idx = curr.findIndex((g) => g.id === input.groupId);
        if (idx === -1) {
          const group: Group = {
            id: input.groupId,
            name: input.name,
            // memberPubkeys excludes the viewer by LP convention; the
            // caller already filtered the viewer out.
            memberPubkeys: [...new Set(input.memberPubkeys)],
            createdAt: evMs,
            updatedAt: evMs,
          };
          resolved = group;
          return [group, ...curr];
        }
        const existing = curr[idx];
        const isNewer = evMs > existing.updatedAt;
        if (isNewer) {
          // Always bump updatedAt on a newer rumor — even if the
          // subject is unchanged. Otherwise an older rename whose
          // created_at sits between the stale updatedAt and this
          // rumor could later "win" the latest-wins comparison.
          const nameChanged = !!(input.name && input.name !== existing.name);
          const updated: Group = {
            ...existing,
            ...(nameChanged && input.name ? { name: input.name } : {}),
            updatedAt: evMs,
          };
          const next = [...curr];
          next[idx] = updated;
          resolved = updated;
          return next;
        }
        resolved = existing;
        return curr;
      });
      return resolved;
    };
    setSyntheticGroupReconciler(
      (input) =>
        reconcileSyntheticRef.current
          ? reconcileSyntheticRef.current(input)
          : Promise.resolve(null),
      pubkey,
    );
    return () => {
      // Drop the registry pointer on unmount so a stale closure can't
      // mutate state after the provider tears down (e.g. logout race).
      setSyntheticGroupReconciler(null);
      reconcileSyntheticRef.current = null;
    };
  }, [persist, pubkey]);

  const createGroup = useCallback(
    async (name: string, memberPubkeys: string[], protocol?: 'marmot'): Promise<Group> => {
      if (protocol === 'marmot') return marmot.create(name, memberPubkeys);
      const now = Date.now();
      const group: Group = {
        id: createGroupId(),
        name: name.trim(),
        memberPubkeys: [...new Set(memberPubkeys)],
        createdAt: now,
        updatedAt: now,
      };
      await persist((curr) => [group, ...curr]);
      // Best-effort: publish the kind-30200 group-state event so other
      // members can pick the group up. Failures are non-fatal — local
      // state is the source of truth, and we'll re-publish on rename.
      publishGroupState({
        groupId: group.id,
        name: group.name,
        memberPubkeys: group.memberPubkeys,
      }).catch((e) => {
        if (__DEV__) console.warn('[Groups] publishGroupState (create) failed:', e);
      });
      return group;
    },
    [persist, publishGroupState, marmot],
  );

  const renameGroup = useCallback(
    async (groupId: string, newName: string): Promise<boolean> => {
      if (isMarmotGroupId(groupId)) return marmot.rename(groupId, newName);
      // NIP-171: only the group's owner (holder of its recovery words) can.
      if (isNip171GroupId(groupId)) return false;
      const trimmed = newName.trim();
      if (!trimmed) return false;
      let updated: Group | null = null;
      await persist((curr) => {
        const idx = curr.findIndex((g) => g.id === groupId);
        if (idx === -1) return curr;
        updated = { ...curr[idx], name: trimmed, updatedAt: Date.now() };
        const next = [...curr];
        next[idx] = updated;
        return next;
      });
      if (!updated) return false;
      const finalUpdated: Group = updated;
      publishGroupState({
        groupId: finalUpdated.id,
        name: finalUpdated.name,
        memberPubkeys: finalUpdated.memberPubkeys,
      }).catch((e) => {
        if (__DEV__) console.warn('[Groups] publishGroupState (rename) failed:', e);
      });
      return true;
    },
    [persist, publishGroupState, marmot],
  );

  // ---------------------------------------------------------------------------
  // SPEC DIVERGENCE — tracked under the same interop work as `subject`-tag
  // alignment (issue #271). NIP-17 says the room key is the (sender + p tags)
  // pubkey set, so changing the membership creates a NEW room with EMPTY
  // history (because the room key itself changed). LP currently mutates
  // `memberPubkeys` in place and KEEPS the stored message log — different
  // semantics. This is intentional for now: the "mutable group" UX is
  // friendlier than the spec's "you got dropped from a room, here's a new
  // empty one" flow. The follow-up question for the maintainer is whether
  // to keep this divergent UX or migrate to spec-strict (clean history on
  // every member add/remove). Synthetic groups (id prefix `s_`, see
  // syntheticGroupId.ts) MUST follow the spec — they have no kind-30200
  // backing and no add/remove API today (read-only mirrors of foreign-
  // client rooms).
  // ---------------------------------------------------------------------------
  const addMembersToGroup = useCallback(
    async (groupId: string, pubkeys: string[]): Promise<Group | null> => {
      if (isMarmotGroupId(groupId)) return marmot.addMembers(groupId, pubkeys);
      if (isNip171GroupId(groupId)) return null;
      let updated: Group | null = null;
      let didChange = false;
      await persist((curr) => {
        const idx = curr.findIndex((g) => g.id === groupId);
        if (idx === -1) return curr;
        const existing = new Set(curr[idx].memberPubkeys);
        // Dedupe input — a caller that asks for [pkA, pkA] should add
        // pkA exactly once. Bare `pubkeys.filter` would let both through
        // because the filter is against the pre-mutation `existing` set.
        const toAdd = [...new Set(pubkeys)].filter((pk) => !existing.has(pk));
        if (toAdd.length === 0) {
          updated = curr[idx];
          return curr;
        }
        didChange = true;
        updated = {
          ...curr[idx],
          memberPubkeys: [...curr[idx].memberPubkeys, ...toAdd],
          updatedAt: Date.now(),
        };
        const next = [...curr];
        next[idx] = updated;
        return next;
      });
      if (!updated) return null;
      // Only republish kind-30200 when membership actually changed.
      // No-op adds (every input pubkey already a member) shouldn't spam
      // the relays with an unchanged member list.
      if (didChange) {
        const finalUpdated: Group = updated;
        publishGroupState({
          groupId: finalUpdated.id,
          name: finalUpdated.name,
          memberPubkeys: finalUpdated.memberPubkeys,
        }).catch((e) => {
          if (__DEV__) console.warn('[Groups] publishGroupState (add) failed:', e);
        });
      }
      return updated;
    },
    [persist, publishGroupState, marmot],
  );

  const removeMemberFromGroup = useCallback(
    async (groupId: string, pubkey: string): Promise<Group | null> => {
      if (isMarmotGroupId(groupId)) return marmot.removeMember(groupId, pubkey);
      if (isNip171GroupId(groupId)) return null;
      let updated: Group | null = null;
      await persist((curr) => {
        const idx = curr.findIndex((g) => g.id === groupId);
        if (idx === -1) return curr;
        if (!curr[idx].memberPubkeys.includes(pubkey)) {
          updated = null;
          return curr;
        }
        updated = {
          ...curr[idx],
          memberPubkeys: curr[idx].memberPubkeys.filter((pk) => pk !== pubkey),
          updatedAt: Date.now(),
        };
        const next = [...curr];
        next[idx] = updated;
        return next;
      });
      if (!updated) return null;
      const finalUpdated: Group = updated;
      publishGroupState({
        groupId: finalUpdated.id,
        name: finalUpdated.name,
        memberPubkeys: finalUpdated.memberPubkeys,
      }).catch((e) => {
        if (__DEV__) console.warn('[Groups] publishGroupState (remove) failed:', e);
      });
      return finalUpdated;
    },
    [persist, publishGroupState, marmot],
  );

  const setGroupAdmins = useCallback(
    async (groupId: string, update: (current: string[]) => string[]): Promise<void> => {
      if (!isMarmotGroupId(groupId)) throw new Error('Only Marmot groups have admins');
      await marmot.setAdmins(groupId, update);
    },
    [marmot],
  );

  const deleteGroup = useCallback(
    async (groupId: string): Promise<void> => {
      // A Marmot group is left (an MLS self-remove), not just forgotten.
      if (isMarmotGroupId(groupId)) return marmot.leave(groupId);
      // NIP-171: ask the owner to remove us (a NIP-17 "-" to the group), then
      // forget its keys.
      if (isNip171GroupId(groupId)) {
        return nip171.leave(groupId, async (groupPubkey) => {
          await sendDirectMessage(groupPubkey, '-', { protocol: 'nip17' });
        });
      }
      await persist((curr) => curr.filter((g) => g.id !== groupId));
    },
    [persist, marmot, nip171, sendDirectMessage],
  );

  const getGroup = useCallback(
    (groupId: string): Group | undefined => groups.find((g) => g.id === groupId),
    [groups],
  );

  const reconcileFromGroupStateEvent = useCallback(
    async (input: {
      senderPubkey: string;
      groupId: string;
      name: string;
      memberPubkeys: string[];
      createdAt: number;
    }): Promise<boolean> => {
      // Look up by id; if missing, create from the event. createdAt on
      // the event is in seconds (nostr convention); local state uses ms.
      const evMs = input.createdAt * 1000;
      const senderLc = input.senderPubkey.toLowerCase();
      // Read+write inside the persist mutation so we always see the
      // committed state (avoids racing concurrent createGroup/reconcile).
      let applied = false;
      await persist((curr) => {
        const idx = curr.findIndex((g) => g.id === input.groupId);
        if (idx === -1) {
          // New group: persist regardless of friend-graph here. Anti-spam
          // is enforced at *render time* by the `visibleGroups` filter
          // (which requires at least one OTHER member to be followed).
          // Doing the check at render time means we don't have to race
          // the contact-list refresh — kind:30200 events frequently land
          // BEFORE the kind:3 fetch that populates `followPubkeys`, so a
          // strict drop here loses real groups to a transient empty
          // follow set. Storage cost is bounded by the relay subscription
          // (`#p`-tagged at the viewer) so a spammer can only inflate
          // disk if they specifically address the viewer.
          const group: Group = {
            id: input.groupId,
            name: input.name,
            memberPubkeys: [...new Set(input.memberPubkeys)],
            createdAt: evMs,
            updatedAt: evMs,
          };
          applied = true;
          return [group, ...curr];
        }
        // Conflict-resolution: only apply if the incoming event is
        // newer than what we have locally.
        const existing = curr[idx];
        if (evMs <= existing.updatedAt) return curr;
        // Creator-trust gate for updates: only accept renames/membership
        // changes from publishers already in the local member set OR from
        // the viewer themselves (cross-device sync — viewer.pubkey is
        // intentionally absent from `existing.memberPubkeys` because the
        // member-list excludes self by convention). Prevents a non-member
        // from hijacking a group's name on the viewer's device.
        const trustedPublishers = new Set(existing.memberPubkeys.map((pk) => pk.toLowerCase()));
        if (pubkey) trustedPublishers.add(pubkey.toLowerCase());
        if (!trustedPublishers.has(senderLc)) {
          if (__DEV__) {
            console.log(
              `[Groups] dropping update to ${input.groupId} from non-member ${senderLc.slice(0, 8)}...`,
            );
          }
          return curr;
        }
        const updated: Group = {
          ...existing,
          name: input.name,
          memberPubkeys: [...new Set(input.memberPubkeys)],
          updatedAt: evMs,
        };
        const next = [...curr];
        next[idx] = updated;
        applied = true;
        return next;
      });
      return applied;
    },
    [persist, pubkey],
  );

  // Keep the reconciler ref pointing at the latest closure.
  useEffect(() => {
    reconcilerRef.current = reconcileFromGroupStateEvent;
  }, [reconcileFromGroupStateEvent]);

  // Subscribe to inbound kind-30200 events that p-tag the current viewer
  // so that groups created by other members appear automatically. Filters
  // by `event.kind === GROUP_STATE_KIND` defensively even though the
  // filter already constrains it.
  useEffect(() => {
    if (!isLoggedIn || !pubkey) return;
    const readRelays = relays.filter((r) => r.read).map((r) => r.url);
    const targetRelays = Array.from(
      new Set([...readRelays, ...enabledAppRelays('default', DEFAULT_RELAYS)]),
    );
    let active = true;
    const unsubscribe = subscribeGroupStateForViewer({
      viewerPubkey: pubkey,
      relays: targetRelays,
      onEvent: (ev) => {
        if (!active || ev.kind !== GROUP_STATE_KIND) return;
        const dTag = ev.tags.find((t) => t[0] === 'd')?.[1];
        const nameTag = ev.tags.find((t) => t[0] === 'name')?.[1];
        if (!dTag || !nameTag) return;
        // Validate every p-tag value as a 64-hex pubkey before
        // reconciling — a malformed/malicious 30200 (e.g. relays
        // returning corrupted tags, or a spammer publishing junk)
        // could otherwise persist invalid strings into local member
        // lists and break NIP-17 wrap construction on subsequent
        // sends. The sender is also validated by the same regex —
        // ev.pubkey from a verified event is always 64-hex, but be
        // defensive in case the verifier ever changes.
        const HEX64 = /^[0-9a-f]{64}$/i;
        const memberPubkeys = ev.tags
          .filter((t): t is [string, string] => t[0] === 'p' && typeof t[1] === 'string')
          .map((t) => t[1].toLowerCase())
          .filter((pk) => HEX64.test(pk));
        // Include the sender (creator) plus all p-tagged members. The
        // creator is implicit per the spec — they sign the event.
        const senderLc = ev.pubkey.toLowerCase();
        if (!HEX64.test(senderLc)) return;
        const allMembers = Array.from(new Set([senderLc, ...memberPubkeys])).filter(
          (pk) => pk !== pubkey.toLowerCase(),
        );
        reconcilerRef
          .current?.({
            senderPubkey: ev.pubkey.toLowerCase(),
            groupId: dTag,
            name: nameTag,
            memberPubkeys: allMembers,
            createdAt: ev.created_at,
          })
          .catch((e) => {
            if (__DEV__) console.warn('[Groups] reconcile from event failed:', e);
          });
      },
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [isLoggedIn, pubkey, relays]);

  // Join visibleGroups × activity. Groups that haven't loaded yet get a
  // placeholder activity (createdAt-based) so they still render without
  // shifting position once the load resolves.
  const groupSummaries = useMemo<GroupSummary[]>(() => {
    const list = visibleGroups.map((g) => ({
      group: g,
      activity:
        activityByGroup[g.id] ??
        ({
          lastActivityAt: Math.floor(g.createdAt / 1000),
          lastText: '',
          lastSenderPubkey: null,
          recentSenderPubkeys: [],
        } satisfies GroupActivity),
    }));
    return list.sort((a, b) => b.activity.lastActivityAt - a.activity.lastActivityAt);
  }, [visibleGroups, activityByGroup]);

  // Stable context value — see WalletContext for the same pattern + #243
  // for the symptom catalogue (dropped keystrokes, cursor jumps, lag)
  // that an unstable Provider value caused via cascading re-renders.
  const contextValue = useMemo(
    () => ({
      groups,
      visibleGroups,
      followingOnly,
      setFollowingOnly,
      effectiveWotTier,
      secretMode,
      setSecretMode,
      loading,
      createGroup,
      renameGroup,
      addMembersToGroup,
      removeMemberFromGroup,
      setGroupAdmins,
      deleteGroup,
      getGroup,
      reconcileFromGroupStateEvent,
      groupSummaries,
    }),
    [
      groups,
      visibleGroups,
      followingOnly,
      setFollowingOnly,
      effectiveWotTier,
      secretMode,
      setSecretMode,
      loading,
      createGroup,
      renameGroup,
      addMembersToGroup,
      removeMemberFromGroup,
      setGroupAdmins,
      deleteGroup,
      getGroup,
      reconcileFromGroupStateEvent,
      groupSummaries,
    ],
  );

  return <GroupsContext.Provider value={contextValue}>{children}</GroupsContext.Provider>;
};

export function useGroups(): GroupsContextType {
  const ctx = useContext(GroupsContext);
  if (!ctx) throw new Error('useGroups must be used within a GroupsProvider');
  return ctx;
}
