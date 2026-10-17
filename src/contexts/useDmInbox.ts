import { reviveAccountWrites } from '../services/accountWriteGuards';
import { useLiveFollowGate } from './useLiveFollowGate';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Kind4RetryStore } from './kind4RetryStore';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import { decryptKind4WithSigner } from './kind4SignerDecrypt';
import { ingestInboxNip17ForSigner } from './inboxNip17Ingest';
import type { SignerType } from '../types/nostr';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { localSendInboxEntryForApp as localSendInboxEntry } from '../utils/localSendInboxEntry';
import {
  selectKnownEventIds,
  upsertDmMessages,
  updateDmDeliveryStatuses,
  hasStoredWraps,
  getConversationMessages,
  type DmMessageRow,
} from '../services/dmDb';
import { loadInboxEntries } from '../services/dmInbox';
import { nip04PlaintextCache } from './nostrSecretKeyCache';
import { decryptInboxKind4, persistInboxKind4 } from './inboxNip04Ingest';
import {
  COLD_INITIAL_WRAP_LIMIT,
  DM_INBOX_REFRESH_TTL_MS,
  DM_INBOX_CAP,
  DM_CONV_CAP,
  inboxLastSeenKey,
  loadLastSeen,
  mergeInboxEntries,
} from './nostrDmCache';
import { ensureDmStoreMigrated } from './dmStoreMigrationRunner';
import type { RefreshDmInboxOptions, ConversationMessage } from './nostrContextTypes';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';
import {
  isColdStartRefresh,
  shouldSkipForFreshness,
  shouldStampCursor,
  bypassesFreshnessTtl,
  shouldBypassSkipSet,
  shouldDropK4Since,
} from './dmRefreshGate';
import { startLiveDmSubscription } from './nostrLiveDmSub';
import { fetchConversationFor } from './nostrFetchConversation';
import { loadInitialConversation as loadInitialConversationFor } from './conversationReadThrough';
import { scheduleColdStartBackfill } from './dmColdStartBackfill';
import { bindDmDeliveryStorePersistence } from './dmDeliveryStorePersistence';
import type { DmProtocol } from '../utils/dmProtocol';
import { useMarmotDmInbound } from './useMarmotDmInbound';
import {
  applyScopedDmInboxUpdate,
  INITIAL_SCOPED_DM_INBOX,
  linkAbortSignals,
  selectScopedDmInbox,
  type ScopedDmInbox,
} from './dmInboxScope';

import { useDmRefreshCoordinator, canJoinDmRefresh } from './dmRefreshCoordinator';

type DmInboxSetter = React.Dispatch<React.SetStateAction<DmInboxEntry[]>>;

/**
 * Options the provider threads into the DM-inbox + conversation hook.
 * These are the provider-owned slices `refreshDmInbox` / `fetchConversation`
 * / the live-DM-sub effect close over: the active identity (`pubkey`,
 * `isLoggedIn`, `signerType`), the follow gate (`followPubkeys`), and the
 * relay resolver (`getReadRelays`). Threading them in keeps the extracted
 * logic byte-for-byte equivalent to the inline provider version.
 */
export interface UseDmInboxOptions {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: SignerType | null;
  followPubkeys: Set<string>;
  followHydrated?: boolean;
  getReadRelays: () => string[];
}

/**
 * Everything the provider must surface (context value + session/logout/
 * switch flow hooks). The first block is exposed directly through the
 * NostrContext value; the trailing `hydrateDmInboxFromCache`,
 * `setDmInbox`, `setAmberNip44Permission`, and `knownWrapIdsRef` are used
 * by the provider's login / logout / switch-identity flows that own those
 * lifecycle transitions but mutate DM state.
 */
export interface UseDmInboxResult {
  dmInbox: DmInboxEntry[];
  dmInboxLoading: boolean;
  refreshDmInbox: (opts?: RefreshDmInboxOptions) => Promise<void>;
  fetchConversation: (
    otherPubkey: string,
    opts?: { signal?: AbortSignal; protocol?: 'nip04' | 'nip17' },
  ) => Promise<ConversationMessage[]>;
  // Read-through (#868, single-sourced in #850): the instant-paint set for a
  // thread open — the SAME encrypted-store rows the inbox preview is built
  // from (the plaintext per-conversation blob is retired). Guarantees the
  // thread is never behind the preview.
  loadInitialConversation: (
    otherPubkey: string,
    protocol?: DmProtocol,
  ) => Promise<ConversationMessage[]>;
  appendLocalDmMessage: (otherPubkey: string, msg: ConversationMessage) => Promise<void>;
  persistDeliveryStatuses: (
    otherPubkey: string,
    statusById: Record<string, DeliveryStatus>,
  ) => Promise<void>;
  armLiveDmSub: () => void;
  amberNip44Permission: 'unknown' | 'granted' | 'denied';
  hydrateDmInboxFromCache: (pk: string) => Promise<void>;
  setDmInbox: React.Dispatch<React.SetStateAction<DmInboxEntry[]>>;
  setAmberNip44Permission: React.Dispatch<React.SetStateAction<'unknown' | 'granted' | 'denied'>>;
  knownWrapIdsRef: React.MutableRefObject<{ pubkey: string | null; set: Set<string> }>;
}

export function useDmInbox(options: UseDmInboxOptions): UseDmInboxResult {
  const {
    pubkey,
    isLoggedIn,
    signerType,
    followPubkeys,
    followHydrated = false,
    getReadRelays,
  } = options;

  useEffect(() => {
    if (isLoggedIn && pubkey) reviveAccountWrites(pubkey);
  }, [isLoggedIn, pubkey]);

  // The inbox is tagged with the account that owns it (see dmInboxScope):
  // only the active account's entries are ever exposed, and writes computed
  // for a previous account (an in-flight refresh, a live-sub / Marmot
  // teardown flush) are dropped instead of painting under the new one.
  const [scopedInbox, setScopedInbox] = useState<ScopedDmInbox>(INITIAL_SCOPED_DM_INBOX);
  const dmInbox = selectScopedDmInbox(scopedInbox, pubkey);
  // The account inbox writes are accepted for. Mirrors the `pubkey` prop,
  // assigned in render so it is current before any effect cleanup flushes.
  const activeOwnerRef = useRef<string | null>(pubkey);
  activeOwnerRef.current = pubkey;
  // Aborts the previous account's in-flight refresh on a switch, so it stops
  // decrypting / group-routing (whose side effects aren't owner-scoped) for
  // an account that is no longer active.
  const accountAbortRef = useRef<{ owner: string; ctrl: AbortController } | null>(null);
  const accountSignalFor = useCallback((owner: string): AbortSignal => {
    const cur = accountAbortRef.current;
    if (cur && cur.owner === owner) return cur.ctrl.signal;
    cur?.ctrl.abort();
    const next = { owner, ctrl: new AbortController() };
    accountAbortRef.current = next;
    return next.ctrl.signal;
  }, []);
  useEffect(
    () => () => {
      const cur = accountAbortRef.current;
      if (cur && cur.owner === pubkey) {
        cur.ctrl.abort();
        accountAbortRef.current = null;
      }
    },
    [pubkey],
  );
  /** A setState-compatible writer bound to `owner`'s inbox. */
  const inboxSetterFor = useCallback(
    (owner: string | null): DmInboxSetter =>
      (action) => {
        setScopedInbox((prev) =>
          applyScopedDmInboxUpdate(prev, owner, activeOwnerRef.current, action),
        );
      },
    [],
  );
  // Writer for whichever account is active at call time — used by the
  // provider's login / logout / switch teardown (`setDmInbox([])`).
  const setDmInbox = useCallback<DmInboxSetter>(
    (action) => inboxSetterFor(activeOwnerRef.current)(action),
    [inboxSetterFor],
  );
  const setDmInboxForPubkey = useMemo(() => inboxSetterFor(pubkey), [inboxSetterFor, pubkey]);
  // Marmot 1:1 chats land in the same store + list (protocol 'marmot').
  useMarmotDmInbound(isLoggedIn ? pubkey : null, setDmInboxForPubkey, followPubkeys);
  const [dmInboxLoading, setDmInboxLoading] = useState(false);
  // Welcomes and DMs must arrive before first Messages focus (#1399).
  // The provider remains the sole owner; the pool reserves inbox capacity.
  const [liveSubArmed, setLiveSubArmed] = useState(true);
  const [amberNip44Permission, setAmberNip44Permission] = useState<
    'unknown' | 'granted' | 'denied'
  >('unknown');

  // Hydrate + persist the eventId-keyed delivery store (#857) for the active
  // account, so settled ticks survive a cold restart. Re-binds on account
  // switch; the teardown flushes any pending write and detaches the hook.
  useEffect(() => {
    if (!pubkey) return;
    let teardown: (() => void) | null = null;
    // AbortController crosses the async boundary (#866): aborting on cleanup
    // tells an in-flight bind whose getItem hasn't resolved yet to no-op before
    // it hydrates / installs its persist hook. Without this, a stale bind from
    // the previous account could resolve late and clobber the new account's
    // in-memory delivery statuses or detach its persist hook.
    const controller = new AbortController();
    void bindDmDeliveryStorePersistence(pubkey, { signal: controller.signal }).then((fn) => {
      // If we were torn down while the bind was resolving, run its (inert or
      // real) teardown immediately rather than retaining it.
      if (controller.signal.aborted) fn();
      else teardown = fn;
    });
    return () => {
      controller.abort();
      teardown?.();
    };
  }, [pubkey]);

  const {
    flights: dmInboxInFlight,
    schedule: scheduleReconciliation,
    cancel: cancelReconciliation,
  } = useDmRefreshCoordinator(pubkey);
  /** `performance.now()` of the last COMPLETED `refreshDmInbox` (`0` before
   * any) and the account it ran for. Drives the cold-start + freshness-TTL
   * gates — see dmRefreshGate. A different account reads as `0`, so its first
   * refresh after a switch is a cold start and isn't TTL-skipped. */
  const dmInboxLastRefresh = useRef<{
    pubkey: string | null;
    at: number;
    includeNonFollows: boolean;
  }>({
    pubkey: null,
    at: 0,
    includeNonFollows: false,
  });

  /** Eagerly hydrate `dmInbox` so the Messages tab paints conversations on
   * cold start instead of staying blank for the relay-fetch + decrypt loop
   * (~3-5 s). Single source (#850): the encrypted DM store's indexed
   * latest-per-conversation read — the plaintext inbox-summary blob is
   * retired. The one-time migration runs first (memoised; a Map lookup once
   * done) so a just-updated install hydrates the pre-#848 kind-4-only
   * threads its blobs held. Called from session-restore + post-login flows. */
  const pendingHydrateRef = useRef<{ owner: string; entries: DmInboxEntry[] } | null>(null);
  const hydrateDmInboxFromCache = useCallback(
    async (pk: string) => {
      await ensureDmStoreMigrated(pk);
      const dbLatest = await loadInboxEntries(pk).catch(() => [] as DmInboxEntry[]);
      if (dbLatest.length === 0) return;
      // Callers hydrate right after setPubkey(pk). If this hook hasn't
      // rendered pk yet, park the entries until it does (effect below) rather
      // than claiming ownership early — a late hydrate for an account the user
      // has already switched away from then simply never applies.
      if (activeOwnerRef.current === pk) inboxSetterFor(pk)(dbLatest);
      else pendingHydrateRef.current = { owner: pk, entries: dbLatest };
    },
    [inboxSetterFor],
  );
  useEffect(() => {
    const pending = pendingHydrateRef.current;
    pendingHydrateRef.current = null;
    if (pubkey && pending?.owner === pubkey) inboxSetterFor(pubkey)(pending.entries);
  }, [pubkey, inboxSetterFor]);

  // Inbox decrypt preserves errors for retry classification; conversation
  // callers retain the null-on-failure contract below.
  const decryptNip04ForInbox = useCallback(
    (peer: string, ciphertext: string) =>
      decryptKind4WithSigner(pubkey, signerType, peer, ciphertext),
    [pubkey, signerType],
  );
  const decryptNip04ViaSigner = useCallback(
    async (peer: string, ciphertext: string) => {
      try {
        return await decryptNip04ForInbox(peer, ciphertext);
      } catch {
        return null;
      }
    },
    [decryptNip04ForInbox],
  );

  /**
   * Silent Amber NIP-44 decrypt wrapped as the callback shape expected by
   * unwrapWrapViaNip44. Throws on PERMISSION_NOT_GRANTED so the caller
   * can flip the permission flag and stop iterating rather than falling
   * back to the Intent dialog (which would flood one dialog per wrap).
   */
  const amberNip44DecryptSilent = useCallback(
    async (ciphertext: string, counterpartyPubkey: string): Promise<string> => {
      if (!pubkey) throw new Error('Not logged in');
      return amberService.requestNip44DecryptSilent(ciphertext, counterpartyPubkey, pubkey);
    },
    [pubkey],
  );

  // Persist the optimistic local- send row into the ENCRYPTED store (#850 —
  // formerly a plaintext AsyncStorage blob write). The row carries the
  // delivery tick (#856) + rumorId (#857); when the relay echo lands,
  // upsertDmMessages retires the local- row and carries both onto the echo.
  // Atomic by (owner, event_id), so the pre-#850 read-modify-write clobber
  // hazard (Copilot review #509) no longer needs a serialization chain.
  const appendLocalDmMessage = useCallback(
    async (otherPubkey: string, msg: ConversationMessage): Promise<void> => {
      if (!pubkey) return;
      const normalized = otherPubkey.trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(normalized)) return;
      // Outgoing NIP-04 sends have no self-echo to surface them in the list.
      const entry = localSendInboxEntry(normalized, msg);
      if (entry) {
        setDmInboxForPubkey((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)]);
      }
      try {
        await upsertDmMessages([
          {
            owner: pubkey,
            eventId: msg.id,
            conversation: normalized,
            createdAt: msg.createdAt,
            sender: msg.fromMe ? pubkey : normalized,
            content: msg.text,
            fromMe: msg.fromMe,
            wireKind: msg.wireKind ?? 14,
            deliveryStatus: msg.deliveryStatus,
            rumorId: msg.rumorId,
            protocol: msg.protocol,
          },
        ]);
      } catch (e) {
        // Swallow — the in-memory setMessages already painted the bubble; a
        // write failure is unfortunate but not destructive (the next relay
        // echo repopulates the store).
        if (__DEV__) console.warn('[DmStore] optimistic append failed:', e);
      }
    },
    [pubkey, setDmInboxForPubkey],
  );

  // Durably attach delivery status (#856) to stored rows, keyed by row id —
  // now a fill-only UPDATE on the encrypted store (#850). The optimistic
  // `local-` row's tick is otherwise lost across a cold restart when the
  // relay echo replaces it before the tick settled; after the in-memory
  // reconcile re-attaches it to the real-id row, this writes it back so the
  // next cold start reads it.
  const persistDeliveryStatuses = useCallback(
    async (_otherPubkey: string, statusById: Record<string, DeliveryStatus>): Promise<void> => {
      if (!pubkey) return;
      if (Object.keys(statusById).length === 0) return;
      try {
        await updateDmDeliveryStatuses(pubkey, statusById);
      } catch (e) {
        // Non-fatal — the in-memory tick already shows; worst case the next
        // send/echo cycle re-persists it.
        if (__DEV__) console.warn('[DmStore] delivery-status persist failed:', e);
      }
    },
    [pubkey],
  );

  // Thread-open data fetch lives in `nostrFetchConversation` (#703). The
  // hook threads in the identity + relay + NIP-04 decrypt dependencies it
  // closes over; the body is unchanged.
  const fetchConversation = useCallback(
    (
      otherPubkey: string,
      opts?: { signal?: AbortSignal; protocol?: 'nip04' | 'nip17' },
    ): Promise<ConversationMessage[]> =>
      fetchConversationFor({
        pubkey,
        isLoggedIn,
        signerType,
        getReadRelays,
        decryptNip04ViaSigner,
        otherPubkey,
        isFollowed: (pk) => followPubkeys.has(pk),
        signal: opts?.signal,
        protocol: opts?.protocol,
      }),
    [pubkey, isLoggedIn, signerType, getReadRelays, decryptNip04ViaSigner, followPubkeys],
  );

  // Read-through (#868, single-sourced in #850): paint the thread from the
  // encrypted store BEFORE the relay fetch resolves, so a DM the inbox
  // already ingested shows immediately and the thread is never behind the
  // preview. Reads the SAME rows the inbox list is built from (getInboxLatest
  // / getConversationMessages both read dm_messages), so they can't disagree
  // — and the rows now carry the optimistic local- sends + delivery ticks the
  // retired plaintext blob used to.
  const loadInitialConversation = useCallback(
    (otherPubkey: string, protocol?: DmProtocol): Promise<ConversationMessage[]> =>
      loadInitialConversationFor(otherPubkey, {
        getStoredRows: (peer) => {
          if (!pubkey) return Promise.resolve([] as DmMessageRow[]);
          const normalized = peer.trim().toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(normalized)) return Promise.resolve([] as DmMessageRow[]);
          return getConversationMessages(pubkey, normalized, { limit: DM_CONV_CAP, protocol });
        },
      }),
    [pubkey],
  );

  // Self-reference for backfill and retry scheduling.
  const refreshDmInboxRef = useRef<((opts?: RefreshDmInboxOptions) => Promise<void>) | null>(null);
  const kind4Failures = useMemo(() => (pubkey ? new Kind4RetryStore(pubkey) : undefined), [pubkey]);
  const refreshDmInbox = useCallback(
    async (opts?: RefreshDmInboxOptions): Promise<void> => {
      if (!pubkey || !isLoggedIn) {
        setDmInbox([]);
        return;
      }
      // [PerfBlock] measures the full relay/decrypt refresh cost (#554).
      const __perfBlockStart = performance.now();
      const signal = opts?.signal;
      // Capture the dev follow-gate bypass for decrypt and cache hydration.
      const includeNonFollows = opts?.includeNonFollows === true;
      // First completed refresh ends cold-start pacing, including under force.
      const lastRefreshAt =
        dmInboxLastRefresh.current.pubkey === pubkey ? dmInboxLastRefresh.current.at : 0;
      const isColdStart = isColdStartRefresh(lastRefreshAt);
      // dmRefreshGate keeps the cold backfill's TTL bypass independent of
      // user-intent cache bypasses, avoiding decrypt sweeps on restart (#846).
      const bypassSkipSet = shouldBypassSkipSet(opts);
      // Resolve setup before comparing effective cancellation and refresh strength.
      // A refresh in flight for a previous account is ignored here — its
      // writes are dropped by the owner scope, so there's nothing to wait for.
      await kind4Failures?.load();
      if (activeOwnerRef.current !== pubkey) return;
      const inFlight = dmInboxInFlight.current.get(pubkey);
      if (inFlight) {
        await inFlight.setup;
        if (canJoinDmRefresh(inFlight, opts)) {
          if (!opts?.force && !opts?.backfill) {
            const account = accountSignalFor(pubkey);
            inFlight.reconcile ??= () => {
              if (!account.aborted) void refreshDmInboxRef.current?.({ ...opts, signal: account });
            };
          }
          return inFlight.promise;
        }
        await inFlight.promise;
        if (activeOwnerRef.current !== pubkey) return;
        return refreshDmInboxRef.current?.(opts);
      }

      const retryAt = kind4Failures?.nextRetryAt();
      // Widening backfills kind-4 messages previously excluded by the follow gate.
      const widensView = includeNonFollows && !dmInboxLastRefresh.current.includeNonFollows;
      if (
        shouldSkipForFreshness(
          lastRefreshAt,
          bypassesFreshnessTtl(opts) ||
            widensView ||
            (retryAt !== undefined && retryAt <= Date.now()),
          performance.now(),
        )
      ) {
        // A bounded live subscription can miss older wraps. Reconcile once
        // at expiry without dropping the cursor or negative-result cache.
        scheduleReconciliation(
          Math.min(
            lastRefreshAt + DM_INBOX_REFRESH_TTL_MS - performance.now(),
            retryAt === undefined ? Infinity : retryAt - Date.now(),
          ),
          accountSignalFor(pubkey),
          () => {
            void refreshDmInboxRef.current?.({ ...opts, signal: accountSignalFor(pubkey) });
          },
        );
        return;
      }
      cancelReconciliation();

      // Capture local references once so the closure isn't affected by
      // mid-flight signer / identity changes. If we detect pubkey/signerType
      // has changed by the time we're about to commit, we bail without
      // mutating state to avoid leaking entries into the wrong session.
      const refreshForPubkey = pubkey;
      const setInboxForRefresh = inboxSetterFor(refreshForPubkey);
      const isStillActive = (): boolean => activeOwnerRef.current === refreshForPubkey;
      // Local helper: encapsulates the follow gate so all seven sites in
      // the cache hydrate + NIP-04 + NIP-17 decrypt loops + final merge
      // reuse the same predicate. When includeNonFollows is true the
      // gate is a no-op (every pubkey passes), so callers can opt out
      // of the parental-control filter from a single switch.
      const refreshForSigner = signerType;
      const refreshFollows = followPubkeys;
      const passesFollowGate = (pk: string): boolean => includeNonFollows || refreshFollows.has(pk);

      if (!isStillActive()) return;
      const accountSignal = accountSignalFor(refreshForPubkey);
      let refreshCompleted = false; // set after commit; gates the stamp (#788 — see helper)
      let disposeSignal: () => void = () => {};

      let resolveSetup!: () => void;
      const setup = new Promise<void>((resolve) => {
        resolveSetup = resolve;
      });
      const task = (async () => {
        setDmInboxLoading(true);
        try {
          // One-time plaintext→encrypted store migration (#848). Memoised +
          // single-flighted per account; after the first call it costs one
          // Map lookup, so firing it on every refresh is safe.
          await ensureDmStoreMigrated(refreshForPubkey);

          // Cold REBUILD detection (F1, #849). A post-login / post-wipe inbox
          // has an empty store: this sweep is the ONLY thing that will populate
          // the 1:1 inbox. Honoring a tab-hop abort here (as #412 does for warm
          // refreshes) stranded the user on an empty inbox for minutes — the
          // decrypted sweep was discarded and only an unrelated later refocus
          // committed one. So a genuine rebuild (first refresh of the session
          // AND no NIP-17 rows yet for this owner) runs to completion: we swap
          // the abort signal for `undefined` on the decrypt+commit path. A WARM
          // refresh (store already populated) keeps the real signal, so #412's
          // fast tab-hopper abort is fully intact.
          const mustCompleteRebuild = isColdStart && !(await hasStoredWraps(refreshForPubkey));
          // A cold rebuild ignores the caller's (tab-hop) abort, but every
          // refresh stops when its account is switched away from.
          const linked = linkAbortSignals(mustCompleteRebuild ? undefined : signal, accountSignal);
          disposeSignal = linked.dispose;
          const effectiveSignal = linked.signal;
          const flight = dmInboxInFlight.current.get(refreshForPubkey);
          if (flight) flight.signal = effectiveSignal;
          resolveSetup();
          if (effectiveSignal.aborted) return;
          if (__DEV__ && mustCompleteRebuild) {
            console.log('[Perf] refreshDmInbox: cold rebuild — running to completion (F1)');
          }

          const readRelays = getReadRelays();
          const kind4Pass = kind4Failures?.beginPass();
          const refreshStart = performance.now();
          let nip04CacheHits = 0;
          // kind-4 events skipped because their decrypts are already rows in
          // the encrypted DB (#848) — the persistent decrypt-once gate the
          // RAM-only nip04PlaintextCache couldn't provide across launches.
          let nip04DbHits = 0;
          let nip04FreshDecrypts = 0;
          // NIP-17 store counters — emitted in the `[Perf] nip17-store`
          // line. `nip17Hits` = wraps short-circuited by the encrypted DB's
          // decrypt-once gate; `nip17Misses` = fresh decrypt attempts;
          // `nip17Stored` = rows persisted this refresh.
          let nip17Hits = 0;
          let nip17Misses = 0;
          let nip17Stored = 0;
          // Wraps short-circuited by the negative-result skip-set (#743).
          // Counted separately from store hits so we can see how much
          // decrypt work the skip-set is saving per refresh.
          let nip17SkipHits = 0;
          // Pacing yields the ingest performed this refresh (#532/#788).
          let nip17YieldCount = 0;

          // Load the store's inbox + the last-seen cursor so we can (a) paint
          // stored entries before the relay round-trip finishes and (b) only
          // fetch events newer than the last one we saw. Single source
          // (#850): the encrypted store's indexed latest-per-conversation
          // read — the plaintext inbox blob is retired (the migration above
          // already folded any legacy blob into the store).
          const [storedInbox, lastSeen] = await Promise.all([
            loadInboxEntries(refreshForPubkey).catch(() => [] as DmInboxEntry[]),
            loadLastSeen(inboxLastSeenKey(refreshForPubkey)),
          ]);
          // Render the stored entries immediately so the Messages tab
          // isn't blank while the relay fetches the delta. The followers
          // set may have changed since the rows were written; re-apply
          // the filter here so unfollowed senders don't resurrect.
          if (storedInbox.length > 0) {
            const filteredCache = storedInbox.filter((e) => passesFollowGate(e.partnerPubkey));
            setInboxForRefresh(filteredCache);
          }

          // Widening and explicit warm user refreshes backfill kind-4.
          // Wraps remain bounded without since (randomised NIP-59 timestamps).
          const { kind4, kind1059 } = await nostrService.fetchInboxDmEvents(
            refreshForPubkey,
            readRelays,
            {
              // kind-4 `since` floor policy → dmRefreshGate.shouldDropK4Since (#751/#846). Wraps ignore `since` internally regardless (random NIP-59 ts).
              ...(widensView || shouldDropK4Since(opts, isColdStart)
                ? {}
                : { since: kind4Failures?.committedCursor(lastSeen ?? 0) ?? lastSeen }),
              signal: effectiveSignal,
              ...(isColdStart ? { limit: COLD_INITIAL_WRAP_LIMIT } : {}),
            },
          );
          if (effectiveSignal?.aborted) return;
          kind4Pass?.configureFetch(readRelays, kind4.length);
          const entries: DmInboxEntry[] = [];

          // NIP-04 — partner pubkey is in the envelope, so we can apply
          // the follow filter BEFORE decrypting. A non-followed sender
          // never gets a round-trip through Amber, let alone land in
          // state. Same cache/parallel pattern as fetchConversation:
          // pull cached plaintext synchronously, decrypt misses in
          // DECRYPT_YIELD_EVERY-sized parallel batches.
          const k4Targets: {
            ev: (typeof kind4)[0];
            fromMe: boolean;
            partnerPubkey: string;
          }[] = [];
          for (const ev of kind4) {
            const fromMe = ev.pubkey.toLowerCase() === refreshForPubkey;
            const partnerPubkey = (
              fromMe ? (ev.tags.find((t) => t[0] === 'p')?.[1] ?? '') : ev.pubkey
            ).toLowerCase();
            if (!/^[0-9a-f]{64}$/.test(partnerPubkey)) continue;
            if (!passesFollowGate(partnerPubkey)) continue;
            k4Targets.push({ ev, fromMe, partnerPubkey });
          }
          // Fast pass — cache lookup only.
          const k4Misses: typeof k4Targets = [];
          for (const t of k4Targets) {
            const hit = nip04PlaintextCache.get(t.ev.id);
            if (hit !== undefined) {
              nip04CacheHits++;
              kind4Pass?.succeeded(t.ev.id);
              entries.push({
                id: t.ev.id,
                partnerPubkey: t.partnerPubkey,
                fromMe: t.fromMe,
                createdAt: t.ev.created_at,
                text: hit,
                wireKind: 4,
              });
            } else {
              k4Misses.push(t);
            }
          }
          // Persistent decrypt-once gate (#848): RAM-cache misses whose
          // decrypts are already rows in the encrypted DB don't need a
          // signer round-trip — the DB-latest merge below keeps their
          // conversations in the inbox. One chunked indexed query.
          const k4Known =
            k4Misses.length > 0
              ? await selectKnownEventIds(
                  refreshForPubkey,
                  k4Misses.map((t) => t.ev.id),
                ).catch(() => new Set<string>())
              : new Set<string>();
          nip04DbHits = k4Known.size;
          for (const id of k4Known) kind4Pass?.succeeded(id);
          const k4ToDecrypt = k4Misses.filter((t) => !k4Known.has(t.ev.id));
          const k4Result = await decryptInboxKind4({
            owner: refreshForPubkey,
            targets: k4ToDecrypt,
            failures: kind4Pass,
            bypassFailures: bypassSkipSet,
            decrypt: decryptNip04ForInbox,
            signal: effectiveSignal,
            isColdStart,
          });
          entries.push(...k4Result.entries);
          const k4Rows = k4Result.rows;
          nip04FreshDecrypts = k4Result.attempts;
          // Persist fresh NIP-04 decrypts BEFORE honoring any abort (F1, #849):
          // a decrypted kind-4 row is idempotent + `(owner, event_id)`-keyed,
          // so a sweep cut short by a tab blur must not throw away the decrypts
          // it already paid for — otherwise the next sweep re-decrypts them and
          // the inbox stays empty. The RAM LRU dies with the session, so the DB
          // is the only durable decrypt-once memo. Even a genuine backlog
          // refetch (user pull-to-refresh drops the `since` floor, #743) is
          // decrypt-once from now on.
          await persistInboxKind4(k4Rows);

          // NIP-17 — partner pubkey is INSIDE the encrypted rumor, so we
          // have to decrypt to know who sent it. For the nsec signer this
          // is cheap pure-JS, so iterate freely and drop non-follows after
          // decrypt. For Amber, guard behind the opt-in toggle + silent-only
          // decrypt path: if Amber hasn't pre-approved nip44_decrypt, we
          // flip amberNip44Permission='denied' so Account can prompt the
          // user for a one-time grant, and stop iterating instead of
          // flooding dialogs.
          const onSkip = (reason: string, wrapId: string) => {
            if (__DEV__) console.warn(`[Nostr] NIP-17 inbox unwrap skip (${wrapId}): ${reason}`);
          };

          // Per-signer NIP-17 decrypt-once ingest lives in inboxNip17Ingest
          // (#283) so this hook stays under the file-size cap. All three
          // signers feed the same engine; the dispatcher returns null when
          // there's nothing to do (no wraps / nsec key unavailable), leaving
          // the counters untouched exactly as the old inline chain did.
          const nip17 =
            refreshForSigner === 'nsec' ||
            refreshForSigner === 'amber' ||
            refreshForSigner === 'nip46'
              ? await ingestInboxNip17ForSigner({
                  signerType: refreshForSigner,
                  ownerPubkey: refreshForPubkey,
                  wraps: kind1059,
                  passesFollowGate,
                  isFollowed: (pk) => refreshFollows.has(pk),
                  bypassSkipSet,
                  isColdStart,
                  signal: effectiveSignal,
                  onSkip,
                  amberNip44DecryptSilent,
                })
              : null;
          if (nip17) {
            // No early return on abort: entries is [] when aborted, but
            // nip17Stored counts rows persisted before the abort (F1, #849)
            // and drives the productive-abort commit below.
            entries.push(...nip17.entries);
            nip17Hits = nip17.alreadyKnown;
            nip17SkipHits = nip17.skipHits;
            nip17Misses = nip17.misses;
            nip17Stored = nip17.stored;
            nip17YieldCount = nip17.yields;
            if (nip17.amberPermission && isStillActive()) {
              setAmberNip44Permission(nip17.amberPermission);
            }
          }

          // Identity-change guard: if the user logged out or switched signer
          // while we were mid-flight, don't leak these entries into a
          // different session's state. This is a HARD return — never paint
          // one session's plaintext into another. Reads the live owner ref:
          // the closure's own `pubkey` always equals `refreshForPubkey`.
          if (!isStillActive() || refreshForSigner !== signerType) return;

          // Abort handling (F1, #849). For a cold REBUILD, effectiveSignal only
          // aborts on an account switch (returned above), so we always
          // commit — the rebuild paints the freshly-decrypted inbox.
          // For a WARM refresh, effectiveSignal IS the real signal: a tab-hop
          // that aborted before decrypting anything fresh skips the commit,
          // exactly as #412 intends (no merge / persist cost, next focus
          // retries). A warm abort that DID persist fresh rows (k4 or NIP-17)
          // still falls through so those idempotent rows paint via
          // loadInboxEntries below instead of being stranded until a refocus.
          const persistedFreshRows = nip17Stored > 0 || k4Rows.length > 0;
          if (effectiveSignal?.aborted && !persistedFreshRows) return;

          // Merge sources for the inbox (#848/#850): the encrypted store's
          // indexed latest-per-conversation read (re-read AFTER the ingest so
          // it includes this refresh's persisted rows; DB-known wraps /
          // kind-4 no longer re-emit per-event entries) plus this refresh's
          // fresh decrypts (which carry rumorId etc. the projection lacks).
          // The plaintext summary blob is gone — the store is the only
          // at-rest source. Keep at most DM_INBOX_CAP entries (newest-first).
          const dbLatest = await loadInboxEntries(refreshForPubkey).catch(
            () => [] as DmInboxEntry[],
          );
          const merged = mergeInboxEntries(dbLatest, entries, DM_INBOX_CAP);
          const filteredFinal = merged.filter((e) => passesFollowGate(e.partnerPubkey));

          // Perf summary: one line per refresh, grep with `\[Perf\] refreshDmInbox`.
          // The `nip17-store` segment shows the encrypted store doing its
          // decrypt-once job: a healthy steady state is known >> misses
          // with stored ≈ misses (every fresh decrypt persisted).
          console.log(
            `[Perf] refreshDmInbox: ` +
              `${(performance.now() - refreshStart).toFixed(0)}ms, ` +
              `k4=${kind4.length} (hits=${nip04CacheHits}, dbKnown=${nip04DbHits}, fresh=${nip04FreshDecrypts}), ` +
              `k1059=${kind1059.length}, ` +
              `since=${lastSeen ?? 0}, ` +
              `fresh=${entries.length}, ` +
              `merged=${merged.length}, ` +
              `rendered=${filteredFinal.length}`,
          );
          console.log(
            `[Perf] nip17-store: ` +
              `known=${nip17Hits}, ` +
              `skipHits=${nip17SkipHits}, ` +
              `misses=${nip17Misses}, ` +
              `stored=${nip17Stored}, ` +
              `dbInbox=${dbLatest.length}, ` +
              `yields=${nip17YieldCount}`,
          );

          setInboxForRefresh(filteredFinal);

          // Advance only after all targets were processed and rows persisted.
          // Pending failures protect the floor independently of refresh completion.
          // Randomised wrap timestamps never contribute.
          const newest = Math.max(lastSeen ?? 0, ...kind4.map((e) => e.created_at));
          const kind4Complete = k4Result.processed === k4ToDecrypt.length;
          if (!effectiveSignal.aborted && kind4Complete) {
            if (kind4Failures && kind4Pass) await kind4Failures.commitPass(kind4Pass, newest);
          }
          // Completion drives TTL and full wrap backfill independently of the
          // history floor. A productive abort still needs another pass.
          refreshCompleted = !effectiveSignal.aborted && kind4Complete;
        } catch (error) {
          if (__DEV__) console.warn('[Nostr] refreshDmInbox failed:', error);
        } finally {
          resolveSetup();
          disposeSignal();
          if (isStillActive()) setDmInboxLoading(false);
        }
      })();

      dmInboxInFlight.current.set(refreshForPubkey, {
        promise: task,
        setup,
        force: opts?.force === true,
        backfill: opts?.backfill === true,
        includeNonFollows,
        signal: accountSignal,
      });
      try {
        await task;
        // Stamp only for a refresh that COMPLETED its work — gate on
        // `refreshCompleted`, not `signal.aborted` (see the helper). #788.
        if (shouldStampCursor(!refreshCompleted)) {
          dmInboxLastRefresh.current = {
            pubkey: refreshForPubkey,
            at: performance.now(),
            includeNonFollows,
          };
        }
      } finally {
        // Only clear our own marker — a newer account's refresh may own it.
        const flight = dmInboxInFlight.current.get(refreshForPubkey);
        if (flight?.promise === task) {
          dmInboxInFlight.current.delete(refreshForPubkey);
          flight.reconcile?.();
        }
        const __perfBlockMs = Math.round(performance.now() - __perfBlockStart);
        // Only surface costly refreshes — sub-200 ms ones aren't
        // contributors to the multi-second freezes we're hunting.
        if (__perfBlockMs > 200) {
          console.log(`[PerfBlock] refreshDmInbox: ${__perfBlockMs}ms`);
        }
      }

      const nextRetry = kind4Failures?.retryDelay();
      if (nextRetry !== undefined && activeOwnerRef.current === pubkey) {
        scheduleReconciliation(nextRetry, accountSignalFor(pubkey), () => {
          void refreshDmInboxRef.current?.({ includeNonFollows, signal: accountSignalFor(pubkey) });
        });
      }
      // Cold-start backfill (#751) — recent slice painted fast above; top up to
      // the full backlog in the background (deferred + abortable). See module.
      scheduleColdStartBackfill({
        isColdStart: isColdStart && refreshCompleted,
        signal,
        includeNonFollows,
        refreshRef: refreshDmInboxRef,
      });
    },
    [
      pubkey,
      isLoggedIn,
      signerType,
      getReadRelays,
      followPubkeys,
      decryptNip04ForInbox,
      amberNip44DecryptSilent,
      inboxSetterFor,
      setDmInbox,
      accountSignalFor,
      dmInboxInFlight,
      kind4Failures,
      scheduleReconciliation,
      cancelReconciliation,
    ],
  );
  // Keep the self-ref pointed at the latest refreshDmInbox closure.
  refreshDmInboxRef.current = refreshDmInbox;

  useEffect(() => {
    if (!isLoggedIn) setDmInbox([]);
  }, [isLoggedIn, setDmInbox]);

  const { followPubkeysRef, followHydratedRef, followGateBufferRef, setDeferredReplay } =
    useLiveFollowGate(followPubkeys, followHydrated, pubkey);

  // Idempotent — any DM-surface (Messages tab, ConversationScreen)
  // calls this on focus. The inbox is already armed at login (#1399);
  // calls are no-ops (React bails on identical setState).
  const armLiveDmSub = useCallback(() => {
    setLiveSubArmed(true);
  }, []);

  // In-memory dedup Set that survives live-DM-sub re-opens. The sub
  // useEffect below re-runs when getReadRelays changes — e.g. when the
  // relay-list refresh adds a new relay 9 s into cold start. Without
  // this ref, the new effect instance creates a fresh Set and re-seeds
  // it from AsyncStorage's wrap cache. That snapshot is stale by the
  // deferred-write window, so all wraps the prior sub already
  // decrypted re-stream from the relays (same `since` cursor) and get
  // re-routed/re-decrypted. Carrying the Set forward keeps the
  // early-return in handleInboxEvent honest across the re-open.
  // Reset only when the viewer changes (sign out / account switch).
  const knownWrapIdsRef = useRef<{ pubkey: string | null; set: Set<string> }>({
    pubkey: null,
    set: new Set(),
  });

  // Long-lived kind-1059 (NIP-17 gift wrap) subscription for the
  // current viewer (#349). Without this, new incoming wraps only
  // surface via pull-to-refresh or the 30 s-TTL useFocusEffect on
  // MessagesScreen — which means the user sits on the Messages tab
  // for up to half a minute after a friend sends a DM with nothing
  // happening on screen.
  //
  // Per-event handler:
  //  1. Dedupe against (a) a session-scoped `seen` set so the same
  //     wrap delivered by multiple relays is processed once, and
  //     (b) the encrypted DM store's wrap-id index (#848) so wraps
  //     previously decrypted by `refreshDmInbox` short-circuit.
  //  2. Decrypt with the active signer's NIP-17 helper — same code
  //     path used by `refreshDmInbox` (`unwrapWrapNsec` for nsec,
  //     `unwrapWrapViaNip44` + Amber silent-decrypt for Amber).
  //  3. Try `tryRouteGroupRumor` first. Multi-recipient kind-14
  //     rumors land in group storage and fire the existing
  //     `notifyGroupMessage` listener — open GroupConversationScreen
  //     re-loads automatically.
  //  4. 1:1 rumors that pass the follow gate are upserted into the
  //     encrypted DM store (so the next inbox / thread open can
  //     short-circuit, #848), appended to `dmInbox` state, and
  //     broadcast to `dmMessageListeners` so an open
  //     ConversationScreen for that peer re-fetches.
  //
  // Non-followed free text retains the follow gate. Bounded NIP-17 order
  // rumors persist for Orders regardless of Messages policy; their inbox
  // entries and alerts use the latest include-non-follows view setting.
  // Store writes run through the subscription's serial queue.
  useEffect(() => {
    if (!isLoggedIn || !pubkey || !signerType) return;
    // Keep the gift-wrap inbox armed throughout the signed-in session.
    if (!liveSubArmed) return;
    // The subscription body lives in `nostrLiveDmSub` (#703). It closes
    // over the effect-instance snapshots (`viewerPubkey` / `activeSigner`)
    // plus the live current props for the mid-flight identity guards, and
    // returns the teardown function used as this effect's cleanup.
    return startLiveDmSubscription({
      viewerPubkey: pubkey,
      activeSigner: signerType,
      isCurrentOwner: () => activeOwnerRef.current === pubkey,
      pubkey,
      signerType,
      readRelays: getReadRelays(),
      knownWrapIdsRef,
      followPubkeysRef,
      followHydratedRef,
      // Bound to this sub's viewer so its teardown flush can't land in the
      // next account's inbox.
      setDmInbox: inboxSetterFor(pubkey),
      setAmberNip44Permission,
      followGateBuffer: followGateBufferRef.current,
      includeNonFollowOrders: () =>
        dmInboxLastRefresh.current.pubkey === pubkey &&
        dmInboxLastRefresh.current.includeNonFollows,
      setDeferredReplay,
      // Close the reconnect blind window (#1035): after a JS-sub socket-drop
      // or Doze-resume re-arm — or the native engine's relay reconnect
      // (Stage 2 M2 of #1036, same semantics) — trigger a full refreshDmInbox
      // (limit 1000, decrypt-once gate) so wraps sent while the sub was deaf
      // surface promptly. refreshDmInboxRef gives us a stable ref to the
      // latest closure without adding `refreshDmInbox` to the deps array
      // (which would re-open the sub on every inbox refresh).
      onReconnect: (opts) => refreshDmInboxRef.current?.(opts) ?? Promise.resolve(),
    });
  }, [
    isLoggedIn,
    pubkey,
    signerType,
    getReadRelays,
    liveSubArmed,
    inboxSetterFor,
    setDeferredReplay,
    followGateBufferRef,
    followHydratedRef,
    followPubkeysRef,
  ]);

  return {
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
  };
}
