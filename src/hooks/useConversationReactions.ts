import { useCoalescedMap } from '../utils/useCoalescedMap';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useAccountState } from '../contexts/useAccountState';
import {
  cacheConversationReactions,
  reactionCacheGeneration,
  isReactionCacheGenerationCurrent,
  readConversationReactions,
} from '../utils/conversationReactionCache';
import {
  isLostReaction,
  pendingReactionIds,
  subscribePendingReactions,
  trackPendingReaction,
} from '../utils/pendingReactionStore';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import type { ConversationMessageInput, Item } from '../utils/conversationItems';
import {
  applyReactionDeletion,
  isOptimisticReactionId,
  makeOptimisticReactionId,
  isPendingReactionPublish,
  markPendingReactions,
  parseReactionEvent,
  ReactionPublishError,
  type ReactionPublishOutcome,
  reduceReactions,
  type MessageReactionState,
  type ReactionRecord,
} from '../utils/reactions';

// Per-message reactions + long-press action state for the 1:1 conversation
// (#205). Lifted out of ConversationScreen (file-size cap) so the screen stays
// composition: the hook owns the kind-7 fetch/reduce, the optimistic
// publish/retract toggle, and the "currently-actioned message" descriptor;
// the screen just renders pills + the MessageActionsSheet from what it returns.

export interface UseConversationReactionsParams {
  messages: ConversationMessageInput[];
  scopeKey?: string | null;
  // Viewer pubkey (author of our own sent bubbles).
  myPubkey: string | null;
  // This conversation's peer pubkey (author of received bubbles).
  peerPubkey: string;
  authorForItem?: (item: Item) => string | null;
  // Resolves only on an authoritative completed read; failures/timeouts reject.
  fetchReactionsForMessages: (targetEventIds: string[]) => Promise<
    {
      id: string;
      pubkey: string;
      kind: number;
      content: string;
      created_at: number;
      tags: string[][];
    }[]
  >;
  publishReaction: (input: {
    emoji: string;
    targetEventId: string;
    targetAuthorPubkey: string;
    targetEventKind?: number;
  }) => Promise<ReactionPublishOutcome>;
  deleteReaction: (reactionEventId: string) => Promise<boolean>;
  // Fetch NIP-09 (kind-5) retractions of the given reaction event ids, so a
  // peer un-reacting is reflected locally instead of leaving a stale pill.
  fetchReactionDeletions: (reactionEventIds: string[]) => Promise<
    {
      id: string;
      pubkey: string;
      created_at: number;
      tags: string[][];
    }[]
  >;
  // Opens the SendSheet preset to the peer — the "Zap this message" action.
  onZapMessage: () => void;
  // Reactions / retractions arriving live (Marmot: they come over MLS while
  // the thread is open, not from a relay query). Returns an unsubscribe.
  subscribeLiveReactions?: (
    onEvent: (event: {
      id: string;
      pubkey: string;
      kind: number;
      content: string;
      created_at: number;
      tags: string[][];
    }) => void,
  ) => () => void;
}

interface ActionedMessage {
  targetId: string;
  authorPubkey: string;
  fromMe: boolean;
  // kind-14 (NIP-17 chat) or kind-4 (NIP-04 DM); goes in the kind-7 `k` tag.
  targetKind: 14 | 15 | 4;
  // Plain chat text or a sanitized attachment filename, offered as "Copy text".
  // Never expose stored encryption keys or structured payloads.
  copyText?: string;
  /** A filename can be copied without making the attachment editable. */
  isPlainText?: boolean;
  // Our send hasn't been accepted by any relay yet (or failed).
  pending?: boolean;
}

export interface UseConversationReactionsResult {
  reactionsByTarget: Map<string, MessageReactionState>;
  actionsForMessage: ActionedMessage | null;
  closeMessageActions: () => void;
  handleToggleReaction: (emoji: string, existingReactionId: string | null) => void;
  handleZapMessage: () => void;
  // Per-item helpers the screen's renderItem wires straight into MessageBubble.
  reactionsForItem: (item: Item) => MessageReactionState | undefined;
  buildOnLongPress: (item: Item) => (() => void) | undefined;
  buildOnToggleReaction: (
    item: Item,
  ) => ((emoji: string, existingReactionId: string | null) => void) | undefined;
}

// A message item's cross-peer-stable reaction/zap target id, or undefined for
// variants that don't carry one (zap cards, order cards, day headers).
function itemRumorId(item: Item): string | undefined {
  if (item.kind === 'message' || item.kind === 'gif' || item.kind === 'location') {
    return item.rumorId;
  }
  return undefined;
}

export function useConversationReactions({
  messages,
  scopeKey,
  myPubkey,
  peerPubkey,
  authorForItem,
  fetchReactionsForMessages,
  publishReaction,
  deleteReaction,
  fetchReactionDeletions,
  onZapMessage,
  subscribeLiveReactions,
}: UseConversationReactionsParams): UseConversationReactionsResult {
  const t = useTranslation();
  // `reactionRecords` is the flat list of every kind-7 seen for any message in
  // this thread; `reactionsByTarget` is the reduced view. Separate slots so an
  // optimistic local append folds in cleanly without a re-fetch.
  const owner = myPubkey && scopeKey ? `${myPubkey.toLowerCase()}:${scopeKey}` : null;
  const cacheScope = useMemo(() => ({ owner, token: reactionCacheGeneration() }), [owner]);
  const cacheToken = cacheScope.token;
  const writerIsCurrent = useCallback(
    () => isReactionCacheGenerationCurrent(cacheToken),
    [cacheToken],
  );
  const initial = useMemo(() => readConversationReactions(owner), [owner]);
  const [reactionRecords, setReactionRecords] = useAccountState(owner, initial.records);
  // Sent reactions no relay acknowledged in time, awaiting a relay copy (#1656).
  // Shared per owner, so a chat reopened mid-confirmation still shows them.
  const confirmingIds = useSyncExternalStore(subscribePendingReactions, () =>
    pendingReactionIds(owner),
  );
  const reactionsByTarget = useMemo<Map<string, MessageReactionState>>(
    () => markPendingReactions(reduceReactions(reactionRecords, myPubkey ?? null), confirmingIds),
    [reactionRecords, myPubkey, confirmingIds],
  );
  // A reaction that definitely didn't go out: if it's still showing (the user
  // didn't remove it meanwhile), drop it and say so. Checked on every record
  // change as well as on each loss, since a loss can be announced before the
  // optimistic → real id swap has committed.
  const [lossSignal, setLossSignal] = useState(0);
  useEffect(
    () =>
      subscribePendingReactions((lost) => {
        if (lost?.owner === owner) setLossSignal((n) => n + 1);
      }),
    [owner],
  );
  useEffect(() => {
    if (!owner || !writerIsCurrent()) return;
    if (!reactionRecords.some((r) => isLostReaction(owner, r.id))) return;
    setReactionRecords((prev) => prev.filter((r) => !isLostReaction(owner, r.id)));
    Alert.alert(
      t('messageActionsSheet.reactionFailedTitle'),
      t('messageActionsSheet.reactionFailedBody'),
    );
  }, [reactionRecords, lossSignal, owner, writerIsCurrent, setReactionRecords, t]);

  // Commit markers contain no account, message, or event identifiers.
  const renderTiming = useMemo(
    () => ({ owner, started: Date.now(), messages: false, reactions: false }),
    [owner],
  );
  useEffect(() => {
    if (!__DEV__) return;
    const timing = renderTiming;
    const elapsed = Date.now() - timing.started;
    if (messages.length > 0 && !timing.messages) {
      timing.messages = true;
      console.log(`[PerfBlock] chat messages rendered: ${elapsed}ms`);
    }
    if (messages.some((m) => m.rumorId && reactionsByTarget.has(m.rumorId)) && !timing.reactions) {
      timing.reactions = true;
      console.log(`[PerfBlock] chat reactions rendered: ${elapsed}ms`);
    }
  }, [messages, reactionsByTarget, renderTiming]);

  // New scope gets its own bookkeeping during render, so a reused screen
  // cannot expose the previous thread or let a late writer mutate its cache.
  const fetchScope = useMemo(() => ({ owner, ids: new Set<string>() }), [owner]);
  const scheduled = fetchScope.ids;
  const retractions = useMemo(
    () => new Map([...initial.retractions].map(([id, authors]) => [id, new Set(authors)])),
    [initial],
  );
  useLayoutEffect(() => {
    cacheConversationReactions(owner, { records: reactionRecords, retractions }, cacheToken);
  }, [owner, reactionRecords, retractions, cacheToken]);

  const mergeFreshRecords = useCallback(
    (fresh: ReactionRecord[]) => {
      if (!writerIsCurrent() || fresh.length === 0) return;
      setReactionRecords((prev) => {
        const seen = new Set(prev.map((r) => r.id));
        const merged = [...prev];
        for (const r of fresh) {
          // NIP-09: only the reactor's own retraction counts.
          if (retractions.get(r.id.toLowerCase())?.has(r.reactorPubkey)) continue;
          // A reaction that never went out can't be restored or re-read (#1656).
          if (isLostReaction(owner, r.id)) continue;
          if (!seen.has(r.id)) {
            merged.push(r);
            seen.add(r.id);
          }
        }
        return merged;
      });
    },
    [setReactionRecords, retractions, writerIsCurrent, owner],
  );

  // Apply a batch of NIP-09 (kind-5) deletion events to the local record list.
  // Each deletion's `e` tags name the reaction ids it retracts; NIP-09 only
  // lets an event's own author delete it, so `applyReactionDeletion` drops a
  // record only when the deleter pubkey matches the reactor's — a third party
  // can't retract someone else's reaction. No-op (returns `prev`) when nothing
  // actually matched, so an unrelated deletion batch doesn't force a re-render.
  const applyDeletionEvents = useCallback(
    (deletions: { pubkey: string; tags: string[][] }[]) => {
      if (!writerIsCurrent() || deletions.length === 0) return;
      for (const d of deletions) {
        for (const t of d.tags) {
          if (t[0] !== 'e' || typeof t[1] !== 'string' || t[1].length === 0) continue;
          const id = t[1].toLowerCase();
          const by = retractions.get(id) ?? new Set<string>();
          by.add(d.pubkey.toLowerCase());
          retractions.set(id, by);
        }
      }
      cacheConversationReactions(
        owner,
        {
          records: readConversationReactions(owner).records,
          retractions,
        },
        cacheToken,
      );
      setReactionRecords((prev) => {
        let next = prev;
        for (const d of deletions) {
          for (const t of d.tags) {
            if (t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0) {
              next = applyReactionDeletion(next, t[1].toLowerCase(), d.pubkey);
            }
          }
        }
        return next.length === prev.length ? prev : next;
      });
    },
    [setReactionRecords, retractions, owner, cacheToken, writerIsCurrent],
  );

  // Stage live MLS events before applying them: one state update per burst,
  // including deletions that arrive before their reaction.
  const {
    map: liveEvents,
    enqueue,
    reset,
    setMap,
  } = useCoalescedMap<
    Parameters<NonNullable<UseConversationReactionsParams['subscribeLiveReactions']>>[0] extends (
      event: infer E,
    ) => void
      ? E
      : never
  >();
  useFocusEffect(
    useCallback(() => {
      reset();
      scheduled.clear();
      if (!subscribeLiveReactions) return;
      return subscribeLiveReactions((event) => enqueue(event.id, event));
    }, [scheduled, subscribeLiveReactions, enqueue, reset]),
  );
  useEffect(() => {
    if (liveEvents.size === 0) return;
    const events = [...liveEvents.values()];
    setMap(new Map());
    applyDeletionEvents(events.filter((event) => event.kind === 5));
    mergeFreshRecords(events.map(parseReactionEvent).filter((r): r is ReactionRecord => !!r));
  }, [liveEvents, setMap, applyDeletionEvents, mergeFreshRecords]);

  // Fetch reactions for any new target ids (the cross-peer-stable rumor id).
  // Optimistic-local / warm-cache rows without a rumorId are skipped — they'll
  // get fetched once a decrypt supplies the id.
  useEffect(() => {
    // Each scope owns its scheduled ids; cancelled reads can retry on the
    // next message update without modifying another conversation's set.
    const targets: string[] = [];
    for (const m of messages) {
      const targetId = m.rumorId;
      if (!targetId) continue;
      if (scheduled.has(targetId)) continue;
      targets.push(targetId);
      scheduled.add(targetId);
    }
    if (targets.length === 0) return;
    let cancelled = false;
    let settled = false;
    (async () => {
      try {
        const events = await fetchReactionsForMessages(targets);
        settled = true;
        if (cancelled || !writerIsCurrent()) return;
        const fresh = events.map(parseReactionEvent).filter((r): r is ReactionRecord => !!r);
        mergeFreshRecords(fresh);
        // Now that we know the reaction ids for these targets, pull any NIP-09
        // retractions of them and apply them — so a peer who un-reacted before
        // we loaded doesn't leave a stale pill rendered.
        const targetSet = new Set(targets);
        const reactionIds = [
          ...new Set([
            ...fresh.map((r) => r.id),
            ...readConversationReactions(owner)
              .records.filter((r) => targetSet.has(r.targetEventId))
              .map((r) => r.id),
          ]),
        ];
        if (reactionIds.length === 0) return;
        const deletions = await fetchReactionDeletions(reactionIds);
        if (cancelled || !writerIsCurrent()) return;
        applyDeletionEvents(deletions);
      } catch {
        settled = true;
      }
    })();
    return () => {
      cancelled = true;
      // If the effect is torn down (e.g. `messages` changed) before the fetch
      // resolves, un-schedule this run's ids so a later run can retry.
      // Otherwise a cancelled in-flight fetch would leave them permanently
      // marked "scheduled" and their reactions would never load.
      if (!settled) {
        for (const id of targets) scheduled.delete(id);
      }
    };
  }, [
    messages,
    scheduled,
    fetchReactionsForMessages,
    mergeFreshRecords,
    fetchReactionDeletions,
    applyDeletionEvents,
    subscribeLiveReactions,
    owner,
    writerIsCurrent,
  ]);

  // The currently-actioned message (long-pressed → MessageActionsSheet open).
  const [actionsForMessage, setActionsForMessage] = useState<ActionedMessage | null>(null);
  const closeMessageActions = useCallback(() => setActionsForMessage(null), []);
  useEffect(() => closeMessageActions(), [scopeKey, closeMessageActions]);

  // Optimistic-publish bookkeeping for the removal-before-ack race. When the
  // user un-reacts before `publishReaction` has returned the real kind-7 id,
  // we can't yet delete the real event — so we record the optimistic id here.
  // Once the publish resolves, the add path sees the id in this set and
  // retracts the REAL id instead of leaking a reaction the user cancelled.
  const cancelledOptimisticRef = useRef(new Set<string>());
  // Monotonic counter feeding `makeOptimisticReactionId` so two taps in the
  // same millisecond can't collide on an id (the cancel bookkeeping keys on it).
  const optimisticSeqRef = useRef(0);

  // Core toggle: publish/delete a reaction for an EXPLICIT target descriptor.
  // Taking the target as an argument (rather than reading `actionsForMessage`)
  // keeps the pill-tap path race-free — the caller passes the item's descriptor
  // directly instead of seeding state and hoping it commits first.
  const toggleReactionForTarget = useCallback(
    async (target: ActionedMessage | null, emoji: string, existingReactionId: string | null) => {
      if (!writerIsCurrent() || !target || !myPubkey) {
        closeMessageActions();
        return;
      }
      closeMessageActions();
      if (existingReactionId) {
        // Aggregation collapses duplicate votes, so retract every matching
        // own event rather than exposing an older vote after deleting the newest.
        const ids = new Set([
          existingReactionId,
          ...reactionRecords
            .filter(
              (r) =>
                r.targetEventId === target.targetId &&
                r.reactorPubkey === myPubkey.toLowerCase() &&
                r.emoji === emoji,
            )
            .map((r) => r.id),
        ]);
        setReactionRecords((prev) => prev.filter((r) => !ids.has(r.id)));
        // Pending publishes must retract their real IDs once acknowledged.
        for (const id of ids) {
          if (isOptimisticReactionId(id)) cancelledOptimisticRef.current.add(id);
        }
        const deleted: string[] = [];
        let failed = false;
        const scheduler = createYieldScheduler({ safetyEvery: 8 });
        try {
          for (const id of ids) {
            if (isOptimisticReactionId(id)) continue;
            await scheduler.maybeYield();
            try {
              if (await deleteReaction(id)) deleted.push(id);
              else failed = true;
            } catch {
              failed = true;
            }
          }
        } finally {
          scheduler.dispose();
        }
        // Keep successful retractions hidden even if a stale history/live
        // event arrives later; reconcile only the failed deletions.
        applyDeletionEvents([{ pubkey: myPubkey, tags: deleted.map((id) => ['e', id]) }]);
        if (failed) {
          // A failed read cannot prove removal. Restore unpublished deletions
          // immediately; mergeFreshRecords still honors confirmed retractions.
          mergeFreshRecords(
            reactionRecords.filter(
              (r) => ids.has(r.id) && !isOptimisticReactionId(r.id) && !deleted.includes(r.id),
            ),
          );
          if (writerIsCurrent()) {
            Toast.show({
              type: 'error',
              text1: t('messageActionsSheet.reactionFailedTitle'),
              text2: t('messageActionsSheet.reactionFailedBody'),
            });
          }
          scheduled.delete(target.targetId);
          try {
            const events = await fetchReactionsForMessages([target.targetId]);
            mergeFreshRecords(
              events.map(parseReactionEvent).filter((r): r is ReactionRecord => !!r),
            );
          } catch {
            // The UI discards this promise. Keep restored records on relay
            // failure/timeout rather than rejecting the toggle.
          }
        }
        return;
      }
      // Optimistic add — synthesize a `local-…` record so the pill renders
      // immediately; replace with the real id once publish returns.
      const optimisticId = makeOptimisticReactionId(optimisticSeqRef.current++);
      const optimistic: ReactionRecord = {
        id: optimisticId,
        reactorPubkey: myPubkey.toLowerCase(),
        emoji,
        createdAt: Math.floor(Date.now() / 1000),
        targetEventId: target.targetId,
      };
      setReactionRecords((prev) => [...prev, optimistic]);
      let outcome: ReactionPublishOutcome;
      let failureReason: string | null = null;
      try {
        outcome = await publishReaction({
          emoji,
          targetEventId: target.targetId,
          targetAuthorPubkey: target.authorPubkey,
          targetEventKind: target.targetKind,
        });
      } catch (err) {
        outcome = null;
        if (err instanceof ReactionPublishError) failureReason = err.message;
      }
      const pending = isPendingReactionPublish(outcome) ? outcome : null;
      const realId = pending ? pending.id : (outcome as string | null);
      if (!writerIsCurrent()) return;
      // Did the user un-react while the publish was in flight? (`delete` both
      // reads and clears the flag in one shot.)
      const cancelled = cancelledOptimisticRef.current.delete(optimisticId);
      // Sent, but no relay acknowledged in time: keep it showing as pending,
      // with no alert, until it's found on a relay or given up on. Tracked
      // before the cancel path, so a restored reaction still gets settled.
      if (pending && owner) trackPendingReaction(owner, pending.id, pending.settled);
      if (realId) {
        if (cancelled) {
          // The reaction WAS published (real id now known) but the user has
          // since removed it — retract the REAL kind-7 so it doesn't reappear
          // on the next load. The optimistic record was already filtered out
          // by the removal path above.
          let deleted = false;
          try {
            deleted = await deleteReaction(realId);
          } catch {
            // A signing or relay failure leaves the published reaction intact.
          }
          if (deleted) {
            applyDeletionEvents([{ pubkey: myPubkey, tags: [['e', realId]] }]);
          } else if (!isLostReaction(owner, realId)) {
            mergeFreshRecords([{ ...optimistic, id: realId }]);
            if (writerIsCurrent()) {
              Toast.show({
                type: 'error',
                text1: t('messageActionsSheet.reactionFailedTitle'),
                text2: t('messageActionsSheet.reactionFailedBody'),
              });
            }
          }
          return;
        }
        setReactionRecords((prev) =>
          prev.map((r) => (r.id === optimisticId ? { ...r, id: realId } : r)),
        );
      } else {
        // Publish failed — nothing landed on a relay. Drop the placeholder and
        // only warn if the user hadn't already cancelled the reaction.
        setReactionRecords((prev) => prev.filter((r) => r.id !== optimisticId));
        if (!cancelled) {
          Alert.alert(
            t('messageActionsSheet.reactionFailedTitle'),
            failureReason ?? t('messageActionsSheet.reactionFailedBody'),
          );
        }
      }
    },
    [
      closeMessageActions,
      writerIsCurrent,
      setReactionRecords,
      scheduled,
      reactionRecords,
      applyDeletionEvents,
      myPubkey,
      publishReaction,
      deleteReaction,
      fetchReactionsForMessages,
      mergeFreshRecords,
      owner,
      t,
    ],
  );

  // Sheet-driven toggle (MessageActionsSheet): acts on the currently-actioned
  // message. Reads `actionsForMessage` because the sheet is a singleton bound
  // to whichever message was long-pressed.
  const handleToggleReaction = useCallback(
    (emoji: string, existingReactionId: string | null) => {
      void toggleReactionForTarget(actionsForMessage, emoji, existingReactionId);
    },
    [toggleReactionForTarget, actionsForMessage],
  );

  // Zap the actioned message's author. Close the sheet first so SendSheet
  // doesn't open on top of a bottom sheet.
  const handleZapMessage = useCallback(() => {
    closeMessageActions();
    onZapMessage();
  }, [closeMessageActions, onZapMessage]);

  // Resolve an item's descriptor (target id + author + inner kind), or null
  // when it isn't a reaction target (missing rumor id, or a non-message row).
  const descriptorForItem = useCallback(
    (item: Item): ActionedMessage | null => {
      const targetId = itemRumorId(item);
      if (!targetId || item.kind === 'zap' || item.kind === 'order' || item.kind === 'dayHeader') {
        return null;
      }
      const authorPubkey = authorForItem
        ? authorForItem(item)
        : item.fromMe
          ? myPubkey
          : peerPubkey;
      if (!authorPubkey) return null;
      // NIP-25 `k`: the target's kind (kind-15 files included).
      const wireKind = item.kind === 'message' ? item.wireKind : undefined;
      const targetKind: 14 | 15 | 4 = wireKind === 4 ? 4 : wireKind === 15 ? 15 : 14;
      const text = item.kind === 'message' ? (item.text ?? '') : '';
      const file = item.kind === 'message' ? item.file : undefined;
      const copyText =
        file?.name ??
        (item.kind === 'message' &&
        (item.wireKind === undefined || item.wireKind === 4 || item.wireKind === 14) &&
        !text.includes('#lpe=1') &&
        text.trim() !== ''
          ? text
          : undefined);
      return {
        targetId,
        authorPubkey,
        fromMe: item.fromMe,
        targetKind,
        ...(copyText ? { copyText } : {}),
        ...(file ? { isPlainText: false } : {}),
        ...('deliveryStatus' in item && item.deliveryStatus?.delivered === false
          ? { pending: true }
          : {}),
      };
    },
    [myPubkey, peerPubkey, authorForItem],
  );

  const reactionsForItem = useCallback(
    (item: Item): MessageReactionState | undefined => {
      const targetId = itemRumorId(item);
      return targetId ? reactionsByTarget.get(targetId) : undefined;
    },
    [reactionsByTarget],
  );

  const buildOnLongPress = useCallback(
    (item: Item): (() => void) | undefined => {
      const descriptor = descriptorForItem(item);
      if (!descriptor) return undefined;
      return () => setActionsForMessage(descriptor);
    },
    [descriptorForItem],
  );

  const buildOnToggleReaction = useCallback(
    (item: Item) => {
      const descriptor = descriptorForItem(item);
      if (!descriptor) return undefined;
      // Pass the descriptor straight through so the toggle acts on THIS pill's
      // message — no `setActionsForMessage` + `setTimeout` dance (which could
      // race a concurrent long-press and toggle the wrong / a null target).
      return (emoji: string, existingReactionId: string | null) => {
        void toggleReactionForTarget(descriptor, emoji, existingReactionId);
      };
    },
    [descriptorForItem, toggleReactionForTarget],
  );

  return {
    reactionsByTarget,
    actionsForMessage,
    closeMessageActions,
    handleToggleReaction,
    handleZapMessage,
    reactionsForItem,
    buildOnLongPress,
    buildOnToggleReaction,
  };
}
