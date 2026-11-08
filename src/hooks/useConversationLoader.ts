import { useNotificationMessageWindow } from './useNotificationMessageWindow';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { filterMessagesByProtocol, type DmProtocol } from '../utils/dmProtocol';
import { subscribeDmMessages } from '../contexts/nostrEventBus';
import { subscribeDmStorage } from '../services/dmDb';
import {
  DM_CONV_CAP,
  keepPendingLocalRows,
  mergeConversationMessages,
  reconcileDeliveryStatus,
} from '../contexts/nostrDmCache';
import type { ConversationMessage } from '../contexts/nostrContextTypes';
import type { ConversationMessageInput } from '../utils/conversationItems';
import type { DeliveryStatus } from '../utils/dmDeliveryStatus';
import { createAbortReplacer } from '../utils/abortReplace';
import { createConversationLiveRefresh } from '../utils/conversationLiveRefresh';
import { perfLog } from '../utils/perfLog';
import { useChatOpenTiming } from './useChatOpenTiming';

/** Why `load` is asking the relays: perf lines attribute every fetch. */
type RelayFetchReason = 'open' | 'refresh' | 'gap';

// Owns the conversation thread's data lifecycle (#868): read-through paint from
// the ingested store, the background relay top-up, abort-on-unmount, and
// single-flight of re-entrant refreshes. Lifted out of ConversationScreen so the
// screen is composition — and so the load orchestration is independently
// readable. State (`messages`, `loading`, `refreshing`) lives here because the
// load loop and the live-sub effect are the only writers; the screen consumes
// the result and the composer hook still appends optimistic rows via setMessages.

export interface UseConversationLoaderParams {
  notification?: { owner: string | null; messageId?: string };
  pubkey: string;
  protocol: DmProtocol;
  isLoggedIn: boolean;
  fetchConversation: (
    otherPubkey: string,
    opts?: { signal?: AbortSignal; protocol?: 'nip04' | 'nip17' },
  ) => Promise<ConversationMessage[]>;
  loadInitialConversation: (
    otherPubkey: string,
    protocol?: DmProtocol,
  ) => Promise<ConversationMessage[]>;
  persistDeliveryStatuses: (
    otherPubkey: string,
    statusById: Record<string, DeliveryStatus>,
  ) => Promise<void>;
}

export interface UseConversationLoaderResult {
  messages: ConversationMessageInput[];
  setMessages: React.Dispatch<React.SetStateAction<ConversationMessageInput[]>>;
  loading: boolean;
  refreshing: boolean;
  handleRefresh: () => Promise<void>;
}

export function useConversationLoader({
  pubkey,
  protocol,
  notification,
  isLoggedIn,
  fetchConversation,
  loadInitialConversation,
  persistDeliveryStatuses,
}: UseConversationLoaderParams): UseConversationLoaderResult {
  const [messages, setMessages] = useState<ConversationMessageInput[]>([]);
  // Mirror of `messages` for reads outside render (e.g. the delivery-tick
  // reconcile in `load`, so persistence runs as a side-effect rather than
  // inside a setMessages updater — Copilot #858).
  const messagesRef = useRef<ConversationMessageInput[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Mount/unmount tracker so the async `load()` below can bail when the user
  // navigates back mid-fetch. Without this, every back-press during the 6-12 s
  // cold fetchConversation still runs the full decrypt + persist chain on the
  // unmounted component, wasting JS thread time that could have been responding
  // to input. Declared BEFORE `load` because `load`'s body closes over it.
  const isMountedRef = useRef(true);
  // Single-flight + abort (#868): the controller for the in-flight conversation
  // fetch. `load` aborts-and-replaces it on every call, so a re-entry (the mount
  // effect firing again, a gap re-fetch, or a second pull) can't stack a
  // second decrypt loop on the JS thread; the unmount cleanup aborts it so a
  // back-press mid-fetch cancels the relay query + decrypt instead of letting it
  // drain. At most one in-flight conversation fetch per screen instance.
  // Lazily created on first access so the factory doesn't run on every render
  // (and only once under StrictMode's double-invoke). Stable for the instance.
  const fetchAbortRef = useRef<ReturnType<typeof createAbortReplacer> | null>(null);
  if (fetchAbortRef.current === null) {
    fetchAbortRef.current = createAbortReplacer();
  }
  useEffect(() => {
    isMountedRef.current = true;
    // Snapshot the replacer for the cleanup closure — it's created once and
    // never reassigned, but copying it satisfies react-hooks/exhaustive-deps.
    const replacer = fetchAbortRef.current;
    return () => {
      isMountedRef.current = false;
      replacer?.abort();
    };
  }, []);

  // Relay fetches this screen instance has made, for the perf lines.
  const relayFetchesRef = useRef(0);
  // Bumped by every live message / store commit, so a relay fetch that
  // overlapped one re-reads the store after replacing the list: the fetch's
  // store slice predates the commit and would otherwise drop the new row.
  const liveEpochRef = useRef(0);
  // The focused session's coalesced store read (null while blurred).
  const scheduleStoreReadRef = useRef<(() => void) | null>(null);

  const load = useCallback(
    async (showSpinner: boolean, reason: RelayFetchReason) => {
      if (!isLoggedIn) {
        setLoading(false);
        return;
      }
      // Single-flight: cancel any in-flight fetch and replace it with this one,
      // so a re-entrant load can never run two decrypt loops at once (#868).
      // Non-null: the ref is initialized during render before any load can run.
      const signal = fetchAbortRef.current!.begin();
      // Read-through (#868): paint from the union of the per-conversation cache
      // AND the encrypted store the inbox is built from — so a DM the inbox
      // already ingested shows within one frame and the thread is never behind
      // the preview. The relay fetch below is a background top-up, not a
      // precondition for showing anything. Only show the spinner if BOTH are
      // empty (a true cold open with nothing ingested yet).
      // Per-protocol window (#1118): the store + fetch read only this thread,
      // so another protocol's newer history can't use up its slice.
      const initial = filterMessagesByProtocol(
        await loadInitialConversation(pubkey, protocol),
        protocol,
      );
      if (signal.aborted || !isMountedRef.current) return;
      if (initial.length > 0 || protocol === 'marmot') {
        setMessages((prev) =>
          keepPendingLocalRows(filterMessagesByProtocol(prev, protocol), initial),
        );
        setLoading(false);
      } else if (showSpinner) {
        setLoading(true);
      }
      // Marmot's first read is already authoritative. Session hydration runs
      // independently and notifies this focused screen after committing rows.
      // An empty cached thread can render immediately too; don't read it twice.
      if (protocol === 'marmot') {
        setLoading(false);
        return;
      }
      const epochAtFetch = liveEpochRef.current;
      relayFetchesRef.current++;
      perfLog(`ConversationFetch ${protocol} relay (${reason}) total=${relayFetchesRef.current}`);
      try {
        const conv = filterMessagesByProtocol(
          await fetchConversation(pubkey, { signal, protocol }),
          protocol,
        );
        // A superseding load (or unmount) aborted this fetch — drop the result
        // so we don't setState on a cancelled / stale pass.
        if (signal.aborted) return;
        // If the user navigated away while the fetch was in flight, don't fire
        // state updates — those would either trigger a re-render on an unmounted
        // component (React warning) or land on the *next* thread that inherits
        // this instance. Check the ref and bail.
        if (isMountedRef.current) {
          // Carry any delivery tick (#856) from the current in-memory rows onto
          // the fetched list, so a just-sent bubble keeps its tick even when the
          // relay echo lands before the optimistic row's async cache write
          // commits (the on-disk merge would miss it in that race). Computed
          // against messagesRef (not inside the setMessages updater) so the
          // AsyncStorage write is a plain side-effect — keeps the updater pure
          // and StrictMode-safe (Copilot #858).
          const previous = filterMessagesByProtocol(messagesRef.current, protocol);
          // A live row painted from the store mid-fetch isn't in `conv` (its
          // store slice was read when the fetch began): merge rather than
          // replace, so the row never blinks out before the re-read below.
          const overlapped = liveEpochRef.current !== epochAtFetch;
          const fetched = overlapped
            ? mergeConversationMessages(previous, conv, DM_CONV_CAP)
            : conv;
          const reconciled = keepPendingLocalRows(
            previous,
            reconcileDeliveryStatus(previous, fetched),
          );
          // Durably write the reconciled ticks back to the conv cache, keyed by
          // the (now real-id) row id, so the tick survives a cold restart —
          // fetchConversation persisted the echo rows WITHOUT delivery when it
          // won the race against the optimistic local- write.
          const statusById: Record<string, DeliveryStatus> = {};
          for (const m of reconciled) {
            if (m.deliveryStatus && !m.id.startsWith('local-')) {
              statusById[m.id] = m.deliveryStatus;
            }
          }
          void persistDeliveryStatuses(pubkey, statusById);
          setMessages(reconciled);
          // The store is the superset: re-read it so the merge settles to it.
          if (overlapped) scheduleStoreReadRef.current?.();
        }
      } finally {
        // Leave the spinner state to whichever load is current — an aborted /
        // superseded pass must not clear a spinner the replacing load owns.
        if (isMountedRef.current && !signal.aborted) {
          setLoading(false);
        }
      }
    },
    [
      isLoggedIn,
      fetchConversation,
      loadInitialConversation,
      persistDeliveryStatuses,
      pubkey,
      protocol,
    ],
  );

  // Live updates (#349, #1325): a live message is announced by
  // `subscribeDmMessages` and its row committed to the DM store (in either
  // order — see conversationLiveRefresh). Both only re-read the store; the
  // relay is reserved for focus (open / refocus catch-up), pull-to-refresh and
  // a live message whose store write never lands.
  useFocusEffect(
    useCallback(() => {
      if (!pubkey) return;
      // Catch up with messages received while this screen was blurred.
      void load(true, 'open');
      const viewer = notification?.owner?.toLowerCase();
      const peer = pubkey.toLowerCase();
      // Only the newest read may apply, and only while this focus lasts: an
      // older read resolving late would drop the newer message again.
      let storeRead = 0;
      let focused = true;
      const readStore = () => {
        const read = ++storeRead;
        void loadInitialConversation(pubkey, protocol)
          .then((rows) => {
            if (!isMountedRef.current || !focused || read !== storeRead) return;
            const stored = filterMessagesByProtocol(rows, protocol);
            // Keep the delivery ticks `load` reconciled: the store rows may
            // not carry them yet.
            setMessages((prev) => {
              const previous = filterMessagesByProtocol(prev, protocol);
              return keepPendingLocalRows(previous, reconcileDeliveryStatus(previous, stored));
            });
            const c = live.counts();
            perfLog(
              `ConversationLive ${protocol} store read: live=${c.liveMessages} ` +
                `commits=${c.storeCommits} storeReads=${c.storeReads} ` +
                `relayFetches=${relayFetchesRef.current} gapFetches=${c.gapFetches}`,
            );
          })
          .catch(() => undefined);
      };
      const live = createConversationLiveRefresh({
        readStore,
        fetchRelay: () => void load(false, 'gap'),
        // Marmot threads never read the relays here (see `load`).
        trackGaps: protocol !== 'marmot',
      });
      scheduleStoreReadRef.current = live.scheduleStoreRead;
      const unsubscribe = subscribeDmMessages((partnerPubkey) => {
        if (partnerPubkey !== peer) return;
        liveEpochRef.current++;
        live.onLiveMessage();
      });
      const unsubscribeStore = subscribeDmStorage((owner, rows) => {
        // Only this account's writes to this thread. Rows are empty, or carry
        // no conversation (deletes), when a write isn't thread-specific:
        // re-read then too.
        if (viewer && owner.toLowerCase() !== viewer) return;
        const touchesThread = rows.some(
          (r) => !r.conversation || r.conversation.toLowerCase() === peer,
        );
        if (rows.length && !touchesThread) return;
        liveEpochRef.current++;
        live.onStoreCommit();
      });
      return () => {
        focused = false;
        live.dispose();
        scheduleStoreReadRef.current = null;
        unsubscribe();
        unsubscribeStore();
        // A blurred thread (e.g. kept underneath another protocol's thread)
        // must not keep decrypting or prompting a signer; refocus reloads.
        fetchAbortRef.current?.abort();
      };
    }, [pubkey, protocol, load, loadInitialConversation, notification?.owner]),
  );

  // Generation guard so overlapping pull-to-refreshes don't drop the spinner
  // early (Copilot #869): `load` is single-flight and aborts the previous
  // fetch, so an earlier call resolves as soon as it's superseded. Only the
  // newest refresh clears `refreshing`; superseded ones leave it to the winner.
  const refreshGenRef = useRef(0);
  const handleRefresh = useCallback(async () => {
    const gen = ++refreshGenRef.current;
    setRefreshing(true);
    try {
      await load(false, 'refresh');
    } finally {
      if (refreshGenRef.current === gen) {
        setRefreshing(false);
      }
    }
  }, [load]);

  // Route changes can reuse a mounted screen: never paint the old protocol while loading.
  const threadMessages = useMemo(
    () => filterMessagesByProtocol(messages, protocol),
    [messages, protocol],
  );
  const routedMessages = useNotificationMessageWindow(
    notification?.owner ?? null,
    pubkey,
    protocol,
    notification?.messageId,
    threadMessages,
  );
  useChatOpenTiming(`dm:${protocol}`, loading, routedMessages.length);
  return { messages: routedMessages, setMessages, loading, refreshing, handleRefresh };
}
