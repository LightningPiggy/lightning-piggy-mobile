import { gateLiveDm, startFollowGateFallback } from './liveDmFollowGateDecision';
import { loadRepliedPartners, hasRepliedTo } from '../services/dmRepliedPartners';
import { loadKind4ReplayCursor } from './kind4RetryStore';
import { getAppFormatLocale } from '../utils/appFormatLocale';
import { dmRowPreview } from '../utils/dmRowPreview';
import { dmThreadId, protocolForWireKind } from '../utils/dmProtocol';
import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import * as nostrConnectService from '../services/nostrConnectService';
import type { SignerType } from '../types/nostr';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { unwrapWrapNsec, unwrapWrapViaNip44, type DecodedRumor } from '../utils/nip17Unwrap';
import { listPersistedGroupWrapIds } from '../services/groupMessagesStorageService';
import { selectDmWrapIds, upsertDmMessages, type DmMessageRow } from '../services/dmDb';
import { nip04PlaintextCache, getMemoisedSecretKey } from './nostrSecretKeyCache';
import { notifyDmMessage } from './nostrEventBus';
import { fireMessageNotification, isThreadActivelyViewed } from '../services/notificationService';
import { createLiveRumorSurfacer } from './liveDmRumorSurface';
import { createLiveDmEngineBridge } from './liveDmEngineBridge';
import {
  claimWrapNotification,
  markWrapHandled,
  noteLiveDmSubArmed,
  retractContentlessWrapAlert,
  takeContentlessWrapAlert,
} from '../services/dmWrapNotificationDedupe';
import { createYieldScheduler, NIP17_LOOP_YIELD_EVERY } from './nostrDecryptPacing';
import { capKnownWrapIds } from './knownWrapIdsCap';
import type { LiveSubFollowGateBuffer, DeferredFollowGateEntry } from './liveSubFollowGate';
import {
  COLD_INITIAL_WRAP_LIMIT,
  DM_INBOX_CAP,
  inboxLastSeenKey,
  loadLastSeen,
  mergeInboxEntries,
} from './nostrDmCache';
import { ensureDmStoreMigrated } from './dmStoreMigrationRunner';
import { ensureNip17GroupHistoryRepaired } from './nip17GroupHistoryRepairRunner';
import { createCoalescedFlushQueue } from '../utils/coalescedFlushQueue';
import type { RefreshDmInboxOptions } from './nostrContextTypes';
import { createLiveDmReconnectController } from './nostrLiveDmReconnect';

// Self-re-arm on relay drop / app resume (#934) — the connection lifecycle
// (open / backoff-reconnect / resume-rearm / the post-reconnect settle timer
// that flushes the #1035 blind window) is owned by the extracted
// `createLiveDmReconnectController` (see nostrLiveDmReconnect.ts for the full
// rationale). This file stays responsible for decoding, decrypting,
// persisting, and surfacing each event.

/**
 * Snapshot + live-dependency bundle the live-DM subscription closes over.
 *
 * `viewerPubkey` / `activeSigner` are the effect-instance snapshots (the
 * `pubkey` / `signerType` captured at the moment the subscription opened).
 * `pubkey` / `signerType` are the same render-snapshot the inline
 * `useEffect` closed over — the mid-flight identity guards inside the
 * handler compare `viewerPubkey !== pubkey` / `activeSigner !== signerType`
 * against them exactly as before. Within one effect instance these never
 * change (React captures the render's values), so the guards evaluate
 * identically to the pre-extraction version. `followPubkeysRef`,
 * `knownWrapIdsRef`, and the two setters are stable across re-renders, so
 * reading them through the bundle keeps the gate + dedup behaviour
 * byte-for-byte identical.
 */

export interface LiveDmSubscriptionParams {
  viewerPubkey: string;
  isCurrentOwner?: () => boolean;
  activeSigner: SignerType;
  pubkey: string | null;
  signerType: SignerType | null;
  readRelays: string[];
  knownWrapIdsRef: React.MutableRefObject<{ pubkey: string | null; set: Set<string> }>;
  followPubkeysRef: React.MutableRefObject<Set<string>>;
  followHydratedRef?: React.MutableRefObject<boolean>;
  setDmInbox: React.Dispatch<React.SetStateAction<DmInboxEntry[]>>;
  setAmberNip44Permission: React.Dispatch<React.SetStateAction<'unknown' | 'granted' | 'denied'>>;
  // Follow-gate deferral buffer (#851 F2). Fresh inbound dropped while the
  // post-switch follows list is still hydrating is buffered here; the hook
  // calls `replayDeferredFollowGate` (registered via `setDeferredReplay`)
  // when follows update, re-surfacing + re-notifying entries that now pass.
  followGateBuffer: LiveSubFollowGateBuffer;
  setDeferredReplay: (fn: ((item: DeferredFollowGateEntry) => void) | null) => void;
  includeNonFollowOrders?: () => boolean;
  /** Optional: called once after a RECONNECT re-arm settles (JS sub — see
   * nostrLiveDmReconnect.ts) or after the native engine reports a relay
   * reconnect (settle-delayed — see liveDmEngineBridge.ts), to flush any
   * wraps missed while the socket was down (wraps sent while down can rank
   * below the sub's `limit` because of #469 random timestamps). Not fired on
   * the initial cold arm (the normal cold-start + deferred-backfill path
   * covers that). See #1035. */
  onReconnect?: (opts?: RefreshDmInboxOptions) => Promise<void>;
}

/**
 * Open the long-lived kind-1059 (NIP-17 gift wrap) + kind-4 (NIP-04)
 * subscription for the current viewer (#349) and return the teardown
 * function. Extracted verbatim from `useDmInbox`'s live-sub `useEffect`
 * body (#703) — the hook calls this from the effect and returns the
 * result as its cleanup. No logic / ordering / guard changed.
 */
export function startLiveDmSubscription(params: LiveDmSubscriptionParams): () => void {
  const {
    viewerPubkey,
    isCurrentOwner = () => true,
    activeSigner,
    pubkey,
    signerType,
    readRelays,
    knownWrapIdsRef,
    followPubkeysRef,
    followHydratedRef = { current: false },
    setDmInbox,
    setAmberNip44Permission,
    followGateBuffer,
    setDeferredReplay,
    onReconnect,
  } = params;
  const seen = new Set<string>();
  const SEEN_CAP = 4096;
  // Tells the background watch in this context that a decrypting sub owns
  // wrap alerts (see dmWrapNotificationDedupe). Undone in the teardown.
  noteLiveDmSubArmed(true);
  // In-memory mirror of the encrypted DM store's wrap-id index
  // (#848). Backed by `knownWrapIdsRef` so the Set survives this
  // effect's re-runs (relay-list change → fresh effect instance).
  // Seeded by union below from the store + persisted group wrap ids,
  // but does NOT replace any entries the prior sub instance added
  // in-memory but the deferred
  // writeChain hasn't persisted yet. Per issue #505 — the relay
  // re-streams the backlog since the last `since` cursor, and on a
  // busy account that's 100+ wraps in ~12 s, almost all of which are
  // already known; pre-#505 the dedup-cache hit check was
  // lazy-populated and downstream of several per-event operations.
  if (knownWrapIdsRef.current.pubkey !== viewerPubkey) {
    knownWrapIdsRef.current = { pubkey: viewerPubkey, set: new Set() };
  }
  const knownWrapIds: Set<string> = knownWrapIdsRef.current.set;
  let cancelled = false;
  // Budget-gated yield scheduler for the live-sub receive path (#1035).
  // Created once per subscription lifetime — shared across re-arms so the
  // elapsed-budget window carries over and a relay reconnect that delivers a
  // small burst doesn't reset the timer and pay zero yields. Disposed on
  // teardown. safetyEvery mirrors NIP17_LOOP_YIELD_EVERY so a pathological
  // stream can't monopolise the thread indefinitely even if performance.now
  // resolution is coarse. NB (Copilot #1039 review): the budget gate is
  // wall-clock since the last yield, NOT accumulated JS work — the shared
  // scheduler's designed semantics (nostrDecryptPacing; dmWrapIngest uses it
  // identically). In this event-driven usage a sporadic wrap arriving after
  // an idle gap therefore pays ONE RAF before decrypt — the same cost as the
  // unconditional per-wrap yieldToEventLoop() this replaced, so no
  // regression — while wraps landing inside a burst amortise to one yield
  // per ~4 ms of work instead of one RAF each (where the #1035 win is).
  //
  // The AbortController spans the subscription lifetime: teardown aborts it
  // BEFORE dispose(), which settles any in-flight maybeYield() awaiter (a bare
  // dispose() only cancels the RAF, leaving the awaiter — and its wrap, whose
  // id is already in knownWrapIds — hung forever).
  const wrapYieldAbort = new AbortController();
  const wrapYieldScheduler = createYieldScheduler({
    signal: wrapYieldAbort.signal,
    safetyEvery: NIP17_LOOP_YIELD_EVERY,
  });
  let writeChain: Promise<void> = Promise.resolve();
  // Wall-clock second the sub opened. We fire OS notifications ONLY for
  // messages whose own timestamp is at/after this (minus a clock-skew
  // buffer) — i.e. genuinely-new arrivals, never the historical backlog
  // the relay replays on open (a fresh login otherwise floods to Android's
  // 50-cap, #279). We can't use EOSE for this: nostr-tools fires `oneose`
  // on an ~2 s eoseTimeout, which lands mid-backlog for a large history and
  // wrongly marks the rest "live". The message timestamp is reliable —
  // NIP-17 randomises only the gift-WRAP time; the inner kind-14 rumor's
  // `created_at` (and kind-4's) is the real send time.
  const subOpenedAtSec = Math.floor(Date.now() / 1000);
  const NOTIFY_SKEW_SEC = 120; // tolerate sender/receiver clock drift
  const isFreshArrival = (createdAtSec: number): boolean =>
    createdAtSec >= subOpenedAtSec - NOTIFY_SKEW_SEC;

  // Coalesce per-event inbox merges into batched setDmInbox calls — at most
  // one per ~150 ms quiet window or per 25 events. Without batching, a
  // relay-restream burst (e.g. cold start with 200+ kind-4 events queued)
  // causes one React re-render per event = 30+ rerenders/sec on the JS
  // thread, which is what locks the UI for 30 seconds; batching collapses
  // that into ~6 rerenders/sec at most. The queue flushes on the LEADING
  // edge, so the common case — one fresh DM arriving in the foreground —
  // surfaces immediately instead of idling out the full 150 ms window
  // (#934 item 3). Notifications still fire per-event so unread
  // counts/sounds aren't dropped.
  const inboxFlushQueue = createCoalescedFlushQueue<DmInboxEntry>({
    flushMs: 150,
    threshold: 25,
    onFlush: (batch) => setDmInbox((prev) => mergeInboxEntries(prev, batch, DM_INBOX_CAP)),
  });
  const queueInboxEntry = inboxFlushQueue.push;
  const flushPendingInbox = inboxFlushQueue.flush;

  // Initialize before replay registration: a hydrated store drains synchronously.
  // Catch failures so one rejected write cannot prevent subsequent persistence.
  const chainWrite = (task: () => Promise<void>): void => {
    writeChain = writeChain.then(task).catch((e) => {
      if (__DEV__) console.warn('[Nostr] live wrap persist failed:', e);
    });
  };
  const pendingReplays = new Set<DeferredFollowGateEntry>();
  const releaseReplayClaim = (item: DeferredFollowGateEntry): void => {
    if (!pendingReplays.delete(item)) return;
    knownWrapIds.delete(item.entry.id);
    seen.delete(item.entry.id);
    item.onEvict?.();
  };
  // Replay the surface + notify side-effects of a fresh inbound that was
  // deferred by the follow-gate during the post-switch hydration window
  // (#851 F2). Called by the hook (via the registered ref) once follows
  // hydrate and the buffered partner is confirmed followed — so we re-run
  // group routing for deferred two-party chats using the shared live path
  // to store and notify the correct room or DM. Other deferred previews
  // persist directly after adoption confirms their partners.
  // Preserve buffer order across async room creation: a later subjectless
  // chat must see the room registered by the preceding subject-tagged chat.
  let deferredRumorReplayChain = Promise.resolve();
  const replayDeferredFollowGate = (item: DeferredFollowGateEntry): void => {
    if (cancelled || !isCurrentOwner()) return;
    if (item.groupRumor) {
      const rumor = item.groupRumor;
      deferredRumorReplayChain = deferredRumorReplayChain
        .then(() => surfaceRumor(rumor, item.entry.id))
        .catch((e) => {
          if (__DEV__) console.warn('[Nostr] deferred group replay failed:', e);
        });
      return;
    }
    // A reopened subscription has a fresh seen set: claim before queuing I/O
    // so relay redelivery cannot race this replay. Cleanup releases both sets.
    seen.add(item.entry.id);
    knownWrapIds.add(item.entry.id);
    capKnownWrapIds(knownWrapIds);
    pendingReplays.add(item);
    chainWrite(async () => {
      if (cancelled || !isCurrentOwner()) {
        releaseReplayClaim(item);
        return;
      }
      try {
        await upsertDmMessages([
          {
            owner: viewerPubkey,
            eventId: item.entry.id,
            conversation: item.partnerPubkey,
            createdAt: item.entry.createdAt,
            sender: item.entry.fromMe ? viewerPubkey : item.partnerPubkey,
            content: item.content ?? item.entry.text,
            fromMe: item.entry.fromMe,
            wireKind: item.entry.wireKind,
            ...(item.entry.rumorId ? { rumorId: item.entry.rumorId } : {}),
          },
        ]);
        pendingReplays.delete(item);
        if (cancelled || !isCurrentOwner()) return;
        knownWrapIds.add(item.entry.id);
        capKnownWrapIds(knownWrapIds);
        // Conversation reloads read SQLite, so signal only after the row exists.
        notifyDmMessage(item.partnerPubkey);
      } catch (error) {
        releaseReplayClaim(item);
        throw error;
      }
    });
    queueInboxEntry(item.entry);
    // claimWrapNotification: the background watch (same JS context, no follow
    // gate) may have already notified for this wrap — never post twice (#279).
    // Its contentless alert, though, is replaced by this real one — recorded
    // first, then the placeholder goes.
    const placeholder = takeContentlessWrapAlert(item.entry.id);
    const threadId = dmThreadId(item.partnerPubkey, protocolForWireKind(item.entry.wireKind));
    // Only once the real alert was written (or the thread is on screen).
    const dropPlaceholder = (id: string | null) =>
      placeholder && (id || isThreadActivelyViewed(threadId))
        ? retractContentlessWrapAlert(viewerPubkey, item.entry.id)
        : undefined;
    if (item.notify && (claimWrapNotification(item.entry.id) || placeholder)) {
      void Promise.resolve(
        fireMessageNotification({
          owner: viewerPubkey,
          kind: 'dm',
          threadId,
          title: item.notify.title,
          body: item.notify.body,
          data: {
            conversationPubkey: item.partnerPubkey,
            messageId: item.entry.id,
            conversationProtocol: protocolForWireKind(item.entry.wireKind),
          },
        }),
      )
        .then(dropPlaceholder)
        .catch(() => undefined);
    }
  };
  setDeferredReplay(replayDeferredFollowGate);
  const followGate = startFollowGateFallback(
    followPubkeysRef,
    followHydratedRef,
    followGateBuffer,
    replayDeferredFollowGate,
  );

  const surfaceRumor = createLiveRumorSurfacer({
    viewerPubkey,
    isCancelled: () => cancelled || !isCurrentOwner(),
    shouldAbort: () =>
      cancelled || !isCurrentOwner() || viewerPubkey !== pubkey || activeSigner !== signerType,
    followPubkeysRef,
    followGateBuffer,
    isFollowHydrated: () => followHydratedRef.current,
    isFollowCacheReady: followGate.ready,
    isFreshArrival,
    queueInboxEntry,
    includeNonFollowOrders: params.includeNonFollowOrders,
    knownWrapIds,
    releaseWrapClaim: (id) => {
      knownWrapIds.delete(id);
      seen.delete(id);
    },
    seen,
    chainWrite,
  });

  // --- Native relay engine (Stage 2 M2, #1036 — see liveDmEngineBridge) ---
  // 'engine': the rust-nostr pool owns the kind-1059 socket, verification and
  //   NIP-59 unwrap natively; the JS sub skips its wrap filter (kind-4/16/17
  //   stay on the JS pool). nsec + Android + EXPO_PUBLIC_NATIVE_ENGINE=1 only.
  // 'xcheck' (dev): BOTH paths run; the engine is observe-only and a differ
  //   compares delivered wrap ids. 'off': today's JS path, byte-identical.
  const engineBridge = createLiveDmEngineBridge({
    activeSigner,
    viewerPubkey,
    readRelays,
    wrapsLimit: COLD_INITIAL_WRAP_LIMIT,
    knownWrapIds,
    isCancelled: () => cancelled || !isCurrentOwner(),
    surfaceRumor,
    onReconnect,
    onEngineUnavailable: () => {
      // Native start failed — restore the JS wrap filter so the inbox
      // never goes deaf behind the flag. rearm() re-opens the sub, which
      // re-reads the skipWraps getter (now false). Only reachable after
      // engineBridge.start(), i.e. after reconnectController.start().
      engineActive = false;
      reconnectController.rearm();
    },
  });
  // Flips false if the native start fails (see onEngineUnavailable above).
  let engineActive = engineBridge.mode === 'engine';

  const handleInboxEvent = async (ev: nostrService.RawInboxDmEvent): Promise<void> => {
    // Skip persisted kind-4 messages as well as known NIP-17 wraps: the
    // retained kind-4 recovery floor re-streams already recovered messages.
    // Earliest-possible short-circuit for wraps decrypted on a previous launch.
    // Cost saved per backlog wrap:
    // console.log + seen.has + seen.add + kind dispatch + cacheKey
    // build + the async AsyncStorage.getItem race. On a busy
    // fixture with 100+ wraps in the backlog this compressed the
    // cold-start JS-thread occupation window from ~12 s to <1 s.
    // Per issue #505.
    if ((ev.kind === 1059 || ev.kind === 4) && knownWrapIds.has(ev.id)) {
      // Already stored (and shown): nothing for the background watch to alert.
      if (ev.kind === 1059) markWrapHandled(ev.id);
      return;
    }
    // Eagerly claim this wrap.id in the in-memory dedup Set before
    // doing any async work. The deferred writeChain at the bottom of
    // this handler also does this, but only after AsyncStorage I/O
    // completes — leaving a window where a re-opened sub (relay-list
    // change mid cold start) re-streams the same wrap and gets past
    // the early-return because the Set hasn't been updated yet.
    // Set.add is idempotent so the trailing writeChain add becomes
    // a no-op. kind 4 has its own `seen` Set below.
    if (ev.kind === 1059) {
      knownWrapIds.add(ev.id);
      capKnownWrapIds(knownWrapIds);
    }
    if (__DEV__) console.log(`[Nostr] live evt kind=${ev.kind} recv ${ev.id.slice(0, 8)}`);
    if (cancelled || !isCurrentOwner()) return;
    if (seen.has(ev.id)) {
      if (__DEV__) console.log(`[Nostr] live evt ${ev.id.slice(0, 8)} dedup-seen`);
      return;
    }
    seen.add(ev.id);
    // Drop oldest ~25% so a long-lived sub under spam doesn't grow the Set unboundedly.
    if (seen.size > SEEN_CAP) {
      const drop = Math.floor(SEEN_CAP / 4);
      const it = seen.values();
      for (let i = 0; i < drop; i++) seen.delete(it.next().value!);
    }

    // NIP-04 (kind-4) — partner is in the envelope; decrypt directly with the active signer.
    if (ev.kind === 4) {
      const fromMe = ev.pubkey === viewerPubkey;
      const recipientTag = ev.tags.find((t) => t[0] === 'p')?.[1]?.toLowerCase();
      const partnerPubkey = fromMe ? recipientTag : ev.pubkey.toLowerCase();
      if (!partnerPubkey || !/^[0-9a-f]{64}$/.test(partnerPubkey)) {
        if (__DEV__) console.log(`[Nostr] live kind-4 ${ev.id.slice(0, 8)} no-partner`);
        return;
      }
      let plaintext = nip04PlaintextCache.get(ev.id);
      if (plaintext === undefined) {
        try {
          if (activeSigner === 'nsec') {
            const secretKey = await getMemoisedSecretKey(viewerPubkey);
            if (!secretKey) return;
            plaintext = await nostrService.decryptNip04WithSecret(
              secretKey,
              partnerPubkey,
              ev.content,
            );
          } else if (activeSigner === 'amber') {
            plaintext = await amberService.requestNip04Decrypt(
              ev.content,
              partnerPubkey,
              viewerPubkey,
            );
          } else if (activeSigner === 'nip46') {
            plaintext = await nostrConnectService.requestNip04Decrypt(
              ev.content,
              partnerPubkey,
              viewerPubkey,
            );
          } else {
            return;
          }
        } catch (error) {
          if (__DEV__)
            console.warn(`[Nostr] live kind-4 ${ev.id.slice(0, 8)} decrypt failed:`, error);
          return;
        }
        if (!plaintext) {
          if (__DEV__) console.log(`[Nostr] live kind-4 ${ev.id.slice(0, 8)} empty-plaintext`);
          return;
        }
        // A decrypt that outlived its account must not repopulate the cache
        // the switch just cleared.
        if (cancelled || !isCurrentOwner()) return;
        nip04PlaintextCache.set(ev.id, plaintext);
      } else if (__DEV__) {
        console.log(`[Nostr] live kind-4 ${ev.id.slice(0, 8)} dedup-cache`);
      }
      // Handled (background sync in this context won't re-ping it) only once
      // decided: ours, a known stranger, or alerted below. A message we don't
      // alert for (not fresh) stays the sync's to ping.
      if (fromMe || isFreshArrival(ev.created_at)) markWrapHandled(ev.id);
      if (cancelled || !isCurrentOwner() || viewerPubkey !== pubkey || activeSigner !== signerType)
        return;

      const k4InboxEntry: DmInboxEntry = {
        id: ev.id,
        partnerPubkey,
        fromMe,
        createdAt: ev.created_at,
        text: plaintext,
        wireKind: 4,
      };
      if (
        gateLiveDm({
          entry: k4InboxEntry,
          kind: 4,
          follows: followPubkeysRef.current,
          hydrated: followHydratedRef.current,
          cacheReady: followGate.ready(),
          buffer: followGateBuffer,
          fresh: isFreshArrival(ev.created_at),
          bypassOwn: true,
          replied: hasRepliedTo(viewerPubkey, k4InboxEntry.partnerPubkey),
          onEvict: () => seen.delete(ev.id),
        }) !== 'pass'
      )
        return;
      // Persist the decrypted kind-4 to the encrypted store (#848 — the RAM
      // LRU dies with the session). The store is the ONLY at-rest home now
      // (#850; the plaintext inbox-preview blob is retired). Same writeChain
      // as kind-1059 to serialize concurrent store writes. Also bump
      // inboxLastSeenKey (a bare timestamp) so refreshDmInbox's kind-4
      // `since` filter advances and doesn't re-fetch already-seen events.
      const k4Row: DmMessageRow = {
        owner: viewerPubkey,
        eventId: ev.id,
        conversation: partnerPubkey,
        createdAt: ev.created_at,
        sender: fromMe ? viewerPubkey : partnerPubkey,
        content: plaintext,
        fromMe,
        wireKind: 4,
      };
      writeChain = writeChain
        .then(async () => {
          if (cancelled || !isCurrentOwner()) return;
          // N5 (#850): a store failure THROWS here (caught by the trailing
          // .catch), so the lastSeen bump below never runs for a row the DB
          // failed to keep — aligned with the kind-1059 path. The next
          // refresh's `since` floor then re-fetches the event instead of
          // silently skipping past an unpersisted message.
          await upsertDmMessages([k4Row]);
          if (cancelled || !isCurrentOwner()) return;
          knownWrapIds.add(ev.id);
          capKnownWrapIds(knownWrapIds);
          const lastSeenRaw = await AsyncStorage.getItem(inboxLastSeenKey(viewerPubkey));
          const lastSeen = lastSeenRaw ? Number(lastSeenRaw) : 0;
          if (ev.created_at > lastSeen) {
            // Re-check after the awaits: logout may have wiped these stores
            // while we were writing.
            if (cancelled || !isCurrentOwner()) return;
            await AsyncStorage.setItem(inboxLastSeenKey(viewerPubkey), String(ev.created_at)).catch(
              () => {},
            );
          }
        })
        .catch((e) => {
          if (__DEV__) console.warn('[Nostr] live kind-4 persist failed:', e);
        });
      // Surface to the UI without awaiting the persist chain (#934 item 2):
      // awaiting meant every earlier event's SQLite upsert + inbox-blob
      // read-merge-write had to settle before THIS one could reach
      // setDmInbox, so under a backlog burst arrival latency grew with
      // queue depth. Persistence stays fully serialized via writeChain; a
      // failed persist is recovered by the next refreshDmInbox — the same
      // recovery model as the follow-gate replay path.
      if (cancelled || !isCurrentOwner() || viewerPubkey !== pubkey || activeSigner !== signerType)
        return;

      const preview = dmRowPreview(plaintext, 4, getAppFormatLocale());
      queueInboxEntry({ ...k4InboxEntry, text: preview });
      notifyDmMessage(partnerPubkey);
      // OS notification (#279) — only genuinely-fresh inbound (the
      // historical backlog the relay replays on open has old timestamps
      // and stays silent), never my own echo; suppressed by
      // notificationService when the user is viewing this exact thread.
      if (!fromMe && isFreshArrival(ev.created_at)) {
        void fireMessageNotification({
          owner: viewerPubkey,
          kind: 'dm',
          threadId: dmThreadId(partnerPubkey, protocolForWireKind(ev.kind)),
          title: 'New message',
          body: preview,
          data: {
            conversationPubkey: partnerPubkey,
            messageId: ev.id,
            conversationProtocol: protocolForWireKind(ev.kind),
          },
        });
      }
      if (__DEV__)
        console.log(
          `[Nostr] live kind-4 ${ev.id.slice(0, 8)} surfaced (partner=${partnerPubkey.slice(0, 8)}, fromMe=${fromMe})`,
        );
      return;
    }

    // Public kinds 16/17 are reposts / website reactions, never Gamma orders.
    if (ev.kind === 16 || ev.kind === 17) return;

    // NIP-17 (kind-1059) — existing gift-wrap unwrap path. Local alias preserves original variable name without renaming through the body below.
    const wrap = ev;

    // knownWrapIds is seeded eagerly up-front below (before the
    // subscription opens) — the in-flow lazy-load was removed in
    // #505 because it (a) raced when many wraps arrived together
    // and each tried to seed the Set concurrently, and (b) made
    // dedup hits pay through a long per-event prologue before the
    // check fired. The check for known IDs lives at the very top of
    // this function for kind-1059 events. This point is only reached
    // for genuinely new (not-yet-stored) wraps, OR — in the rare
    // case the seed failed (see the catch in the sub-open block) —
    // for wraps that should have been pre-known. In that case the
    // wrap re-decrypts; the encrypted-store upsert below is
    // idempotent by (owner, event_id), but the `dmMessageListeners`
    // may fire a second time for messages already shown in a
    // previous session. Acceptable trade-off because the seed only
    // fails on DB I/O error which is extremely rare.

    const onSkip = (reason: string, wrapId: string) => {
      if (__DEV__) console.warn(`[Nostr] live NIP-17 unwrap skip (${wrapId}): ${reason}`);
    };

    // Budget-gated yield before each per-wrap decryption (#1035 / #496).
    // Replaces the unconditional `yieldToEventLoop()` (one RAF ≈ 16 ms per
    // wrap regardless of load). The gate is wall-clock since the last yield
    // (the shared scheduler's semantics — see the creation-site comment), so
    // a sporadic foreground wrap after an idle gap still pays one RAF (same
    // as the unconditional yield this replaced — no regression); the win is
    // in bursts, which amortise to one yield per ~4 ms of work instead of
    // one RAF per wrap. The safety cap (every NIP17_LOOP_YIELD_EVERY wraps)
    // backstops edge cases where decrypt runs faster than performance.now
    // resolution on some devices.
    await wrapYieldScheduler.maybeYield();
    // Torn down while parked on the yield (abort settles the awaiter): skip
    // post-teardown decrypt/persist work. `knownWrapIds` was already eagerly
    // claimed for this wrap at the top of the handler (#505) — undo that
    // claim here (Copilot #1039 review) so a wrap that was never actually
    // decrypted/persisted/surfaced isn't permanently orphaned as "known".
    // `knownWrapIdsRef` survives this effect's re-runs (relay-list change →
    // fresh live-sub instance, same viewer), so without this a torn-down
    // in-flight wrap would be silently skipped by every future live-sub
    // instance for the rest of the session even though the store never got
    // it — undetectable because it never resurfaces even on the next arm.
    if (cancelled || !isCurrentOwner()) {
      knownWrapIds.delete(wrap.id);
      return;
    }

    let rumor: DecodedRumor | null = null;
    if (activeSigner === 'nsec') {
      const secretKey = await getMemoisedSecretKey(viewerPubkey);
      if (!secretKey) return;
      rumor = unwrapWrapNsec(wrap, secretKey, onSkip);
    } else if (activeSigner === 'amber') {
      try {
        rumor = await unwrapWrapViaNip44(
          wrap,
          (ct, cp) => amberService.requestNip44DecryptSilent(ct, cp, viewerPubkey),
          onSkip,
        );
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const message = (error as Error)?.message ?? '';
        if (code === 'PERMISSION_NOT_GRANTED' || /PERMISSION_NOT_GRANTED/.test(message)) {
          // Same flag refreshDmInbox sets — Account screen surfaces
          // a one-tap grant button; without it, the live sub would
          // silently fail every wrap until the user re-enabled
          // Amber's blanket nip44_decrypt.
          if (!cancelled && isCurrentOwner()) setAmberNip44Permission('denied');
          return;
        }
        if (__DEV__) console.warn('[Nostr] live Amber NIP-17 unwrap failed:', error);
        return;
      }
    } else if (activeSigner === 'nip46') {
      // NIP-46 live unwrap. No silent-batch path (the silent variant
      // throws), so use the plain per-wrap decrypt over the bunker.
      // No PERMISSION_NOT_GRANTED concept, so no permission flag flip.
      try {
        rumor = await unwrapWrapViaNip44(
          wrap,
          (ct, cp) => nostrConnectService.requestNip44Decrypt(ct, cp, viewerPubkey),
          onSkip,
        );
      } catch (error) {
        if (__DEV__) console.warn('[Nostr] live NIP-46 NIP-17 unwrap failed:', error);
        return;
      }
    }
    if (!rumor) {
      if (__DEV__) console.log(`[Nostr] live wrap ${wrap.id.slice(0, 8)} no-rumor`);
      return;
    }
    // Dev cross-check: record every wrap the JS path successfully unwrapped
    // so the differ can flag divergence from the engine's deliveries.
    engineBridge.recordJsUnwrap(wrap.id);
    // Post-unwrap policy — extracted verbatim to liveDmRumorSurface.ts and
    // shared with the native-engine path. Starts with the same
    // cancelled/identity guard that used to sit here.
    await surfaceRumor(rumor, wrap.id);
  };

  // Load the persisted kind-4 lastSeen cursor before opening the sub so the relay only re-streams events the user hasn't seen yet — without this, a heavy DM history floods the JS thread with hundreds of `live evt kind=4` deliveries on every cold start (each one a NIP-04 decrypt round-trip + setDmInbox re-render).
  //
  // Connection lifecycle (open / backoff-reconnect / resume-rearm / the
  // post-reconnect settle timer) is owned by the extracted controller
  // (#1039 review — see nostrLiveDmReconnect.ts). It's constructed here,
  // armed once the async seed below resolves the kind-4 cursor, and torn
  // down from this effect's cleanup.
  const reconnectController = createLiveDmReconnectController({
    viewerPubkey,
    readRelays,
    // Engine mode: the native pool owns the kind-1059 filter; the JS sub
    // keeps kind-4 (and the close-driven re-arm moves to the kind-4
    // sub — see subscribeInboxDmsForViewer). Read per-arm so the fallback
    // re-arm restores the wrap filter if the engine fails to start.
    skipWraps: () => engineActive,
    onEvent: (ev) => {
      // Fire-and-forget: handleInboxEvent awaits its own state, and any throw is caught + logged here so the sub keeps running. Whether a notification fires is gated inside on the message's own timestamp (isFreshArrival), not on EOSE.
      handleInboxEvent(ev).catch((e) => {
        if (__DEV__) console.warn('[Nostr] live DM handler failed:', e);
      });
    },
    onReconnect,
    isCancelled: () => cancelled || !isCurrentOwner(),
  });

  (async () => {
    // Use the atomic refresh cursor; missing metadata retains the legacy / 7-day fallback.
    const sinceK4Cursor = await loadKind4ReplayCursor(
      viewerPubkey,
      await loadLastSeen(inboxLastSeenKey(viewerPubkey)).catch(() => undefined),
    ).catch(() => undefined);
    if (cancelled || !isCurrentOwner()) return;
    // Pre-seed `knownWrapIds` from the encrypted store's wrap-id index
    // (#848 — one indexed id-only query, no plaintext leaves the DB). The
    // early-return in `handleInboxEvent` (top) checks this Set as the very
    // first thing and skips all downstream per-event work for known wraps.
    // Per issue #505. Runs after the one-time plaintext→DB migration so a
    // just-migrated install seeds the full id set.
    try {
      await ensureDmStoreMigrated(viewerPubkey);
      // Before arming: the follow gate passes people we've replied to (#1623).
      await loadRepliedPartners(viewerPubkey);
      const storedWrapIds = await selectDmWrapIds(viewerPubkey);
      for (const id of storedWrapIds) knownWrapIds.add(id);
      // Also seed from persisted group messages — group-routed wraps
      // never land in the DM store (the tryRouteGroupRumor branch
      // returns before the row is built). Without this union every
      // cold start re-decrypts + re-routes the same group wraps the
      // relay re-streams since the last `since` cursor.
      const dmCount = knownWrapIds.size;
      const groupWrapIds = await listPersistedGroupWrapIds(viewerPubkey);
      for (const id of groupWrapIds) knownWrapIds.add(id);
      if (__DEV__) {
        console.log(
          `[Nostr] live DM sub: seeded knownWrapIds with ${dmCount} dm + ${knownWrapIds.size - dmCount} group wraps`,
        );
      }
      capKnownWrapIds(knownWrapIds);
    } catch (e) {
      // Seed-from-DB failed — leave knownWrapIds as the empty Set we
      // initialised at outer-scope. Known wraps re-stream through the
      // full handler (decrypt, route, upsert, queueInboxEntry,
      // notifyDmMessage). Two observable side effects vs the pre-#505
      // in-flow dedup check:
      //   1. `dmMessageListeners` registered for an open conversation
      //      will re-fire for messages already surfaced in a prior
      //      session.
      //   2. The `unwrapWrapNsec` / `unwrapWrapViaNip44` call runs
      //      unnecessarily for each known wrap (1–3 ms each).
      // The encrypted-store upsert is idempotent — it doesn't grow
      // unboundedly. We accept this regression on the failure path
      // because (a) DB read failures are extremely rare, and (b) the
      // alternative (resurrecting the lazy-load inside the handler)
      // would re-introduce the race + per-event prologue cost that
      // motivated #505 in the first place.
      if (__DEV__)
        console.warn('[Nostr] live DM sub: knownWrapIds seed failed, dedup degraded:', e);
    }
    if (cancelled || !isCurrentOwner()) return;
    const recoverySince = followGateBuffer.kind4RecoverySince;
    reconnectController.start(
      recoverySince === undefined
        ? sinceK4Cursor
        : Math.min(sinceK4Cursor ?? recoverySince, recoverySince),
    );
    // Repair legacy history independently: slow/missing relay wraps must not
    // delay arming live delivery. Uses its own bounded fetch, not replay dedup.
    void ensureNip17GroupHistoryRepaired(
      viewerPubkey,
      activeSigner,
      readRelays,
      wrapYieldAbort.signal,
      (row) => {
        if (cancelled || !isCurrentOwner()) return;
        queueInboxEntry({
          id: row.eventId,
          partnerPubkey: row.conversation,
          fromMe: row.fromMe,
          createdAt: row.createdAt,
          text: dmRowPreview(row.content, row.wireKind, getAppFormatLocale()),
          wireKind: row.wireKind,
          rumorId: row.rumorId,
        });
      },
    );
    // Native engine (Stage 2 M2, #1036) — started AFTER the knownWrapIds
    // seed so the engine's native dedupe set is seeded with the same ids.
    // No-op in 'off' mode; falls back to a JS re-arm on failure.
    await engineBridge.start();
  })();

  return () => {
    cancelled = true;
    // Release synchronously before a new subscription can claim these ids.
    // Old queued cancellations must not remove claims owned by the new sub.
    for (const item of pendingReplays) releaseReplayClaim(item);
    noteLiveDmSubArmed(false);
    // Invalidate any in-flight close signal + pending reconnect FIRST (#934):
    // stopReconnecting() bumps the generation and stops the AppState-resume
    // re-arm BEFORE closeSubscription() below fires `onWrapsClose`
    // synchronously — without that ordering, the intentional close would
    // schedule a bogus reconnect (a logout / account switch / relay-list
    // change must fully stop the sub, not resurrect it).
    reconnectController.stopReconnecting();
    flushPendingInbox();
    // Detach this closure; account-owned deferrals survive relay-list re-opens.
    // Identity teardown clears the canonical store on switch/sign-out.
    setDeferredReplay(null);
    followGate.dispose();
    // Stop the native engine — tears the rust-nostr pool down AND clears the
    // module's single-entry key cache, so a logout / account switch never
    // leaves the old identity's secret in native memory (Stage 2 M2 key
    // lifecycle).
    engineBridge.stop();
    // Abort first — settles any in-flight maybeYield() awaiter — then detach.
    wrapYieldAbort.abort();
    wrapYieldScheduler.dispose();
    reconnectController.closeSubscription();
  };
}
