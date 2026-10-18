import { useFocusEffect } from '@react-navigation/native';
import { useAppRelayPrefs } from './useAppRelayPrefs';
import { getCurrentUserPubkey } from '../services/nostrActiveAccount';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseFoundLog, type FoundLog } from '../utils/foundLog';
import { subscribeFoundLogs } from '../services/nostrPlacesPublisher';
import { subscribeFindLogZaps } from '../services/findLogZapsService';

// Real-time ingest for a cache's found-logs (kind 7516) and the zap
// receipts (kind 9735) attached to them. Lifted out of HuntPiggyDetailScreen
// (file-size cap, #703) — the screen just renders `sortedLogs` /
// `zapTotalsByLog` and calls `addOptimisticLog` after posting; this hook
// owns the two relay subscriptions, their coalesced-flush batching, and
// the derived per-log zap totals.
//
// Both subscriptions batch per-event Map/array pushes into one setState per
// ≤150 ms flush (or immediately once a burst reaches 25 pending items) —
// without batching, a relay burst fires N × O(prev) clones + React commits,
// one per arriving event (#1029 found-logs / #739 Fix 4 zaps).

export interface UseFoundLogIngestResult {
  logs: Map<string, FoundLog>;
  sortedLogs: FoundLog[];
  zapsByLog: Map<string, Map<string, number>>;
  zapTotalsByLog: Map<string, number>;
  // Inserts a just-published log immediately, ahead of the relay round-trip
  // that will otherwise echo it back via the subscription.
  addOptimisticLog: (log: FoundLog) => void;
}

export function useFoundLogIngest(coord: string): UseFoundLogIngestResult {
  const relayScope = useAppRelayPrefs();
  const account = getCurrentUserPubkey();
  const [logs, setLogs] = useState<Map<string, FoundLog>>(new Map());
  // Zap totals per find-log id. Outer key is the kind-7516 log id; inner
  // Map is keyed by kind-9735 receipt id so the same zap arriving from
  // multiple relays only counts once. Sum the inner values for the total
  // displayed on the row.
  const [zapsByLog, setZapsByLog] = useState<Map<string, Map<string, number>>>(new Map());

  // ----- found-logs subscription (coalesced) ------------------------------

  const pendingLogsRef = useRef<Map<string, FoundLog>>(new Map());
  const logFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Declared here (rather than beside the zap-subscription effect below) so
  // the found-logs effect can reset them synchronously on every `coord`
  // instance — see the reset block at the top of the effect.
  const pendingZapsRef = useRef<{ receiptId: string; logId: string; sats: number }[]>([]);
  const zapFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Reset all derived output for this coord instance up front. `logs` /
    // `zapsByLog` are plain state, but `pendingZapsRef`/`zapFlushTimerRef`
    // are refs shared across effect instances (like pendingLogsRef above,
    // whose reset the previous instance's cleanup already handles) — if the
    // hook is reused with a new `coord`, without this the previous cache's
    // logs/zaps (and any zaps buffered but not yet flushed) would remain
    // visible/pending until the new subscriptions happened to overwrite them.
    // Functional form keeps the reset render-free on first mount (state is
    // already an empty Map — returning it unchanged skips the re-render).
    setLogs((prev) => (prev.size === 0 ? prev : new Map()));
    setZapsByLog((prev) => (prev.size === 0 ? prev : new Map()));
    pendingZapsRef.current = [];
    if (zapFlushTimerRef.current) {
      clearTimeout(zapFlushTimerRef.current);
      zapFlushTimerRef.current = null;
    }
  }, [coord, account]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const flushLogs = (): void => {
        // Cancelled check MUST run first, before touching the timer ref.
        // pendingLogsRef/logFlushTimerRef are declared outside this effect so
        // the SAME refs are reused by the next effect instance after `coord`
        // changes; a stale/cancelled flushLogs call that cleared the timer ref
        // unconditionally could null out a timer the *new*, live instance had
        // already scheduled, silently stalling its auto-flush until another
        // event happened to arrive. Bailing out before the clearTimeout means
        // a stale call can never touch state that belongs to a newer instance.
        if (cancelled) return;
        if (logFlushTimerRef.current) {
          clearTimeout(logFlushTimerRef.current);
          logFlushTimerRef.current = null;
        }
        if (pendingLogsRef.current.size === 0) return;
        const batch = pendingLogsRef.current;
        pendingLogsRef.current = new Map();
        setLogs((prev) => {
          // Dedupe: skip any id already committed so we don't clobber a
          // newer optimistic insert (the handlePostLog path). Only allocate
          // `next` when we actually find a new id — a relay echo of ids that
          // are already in `prev` avoids the O(prev.size) clone entirely.
          let next: Map<string, FoundLog> | null = null;
          for (const [id, log] of batch) {
            if (prev.has(id)) continue;
            if (next === null) next = new Map(prev);
            next.set(id, log);
          }
          return next ?? prev;
        });
      };

      const closer = subscribeFoundLogs(coord, (event) => {
        // A relay event can arrive after cleanup (queued delivery, or a closer
        // that isn't synchronous) — never buffer into the shared ref once this
        // effect instance is cancelled, or stale logs from the previous coord
        // could surface under the next one.
        if (cancelled) return;
        const log = parseFoundLog(event);
        pendingLogsRef.current.set(log.id, log);
        if (pendingLogsRef.current.size >= 25) {
          flushLogs();
          return;
        }
        if (logFlushTimerRef.current === null)
          logFlushTimerRef.current = setTimeout(flushLogs, 150);
      });
      return () => {
        cancelled = true;
        // Drop any buffered logs — after setting cancelled the flushLogs
        // guard discards them without calling setLogs. On a real unmount
        // the component is gone so committing is pointless; on a coord
        // change the next effect opens a fresh subscription and a stale
        // relay-echo for the previous coord shouldn't populate the new list.
        pendingLogsRef.current = new Map();
        if (logFlushTimerRef.current) {
          clearTimeout(logFlushTimerRef.current);
          logFlushTimerRef.current = null;
        }
        closer();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Re-arm the captured app relay defaults.
    }, [coord, relayScope]),
  );

  // ----- zap receipts subscription (coalesced) ----------------------------

  // Re-subscribe to kind-9735 zap receipts on the `#e` tag of find-logs.
  // Keyed on sorted log ids so a new log re-opens the sub while an
  // unchanged set doesn't. Receipts deduped by receiptId across relays.
  const logIdsKey = useMemo(() => [...logs.keys()].sort().join(','), [logs]);
  useFocusEffect(
    useCallback(() => {
      const logIds = logIdsKey ? logIdsKey.split(',') : [];
      if (logIds.length === 0) return undefined;
      let cancelled = false;

      const flush = (): void => {
        // Cancelled check MUST run first, before touching the timer ref — the
        // same stale-timer race flushLogs above guards against. pendingZapsRef
        // / zapFlushTimerRef are shared across effect instances (reused on the
        // next `logIdsKey` change), so a queued flush callback from a
        // superseded instance could otherwise clear the *new* instance's
        // already-scheduled timer, stalling its auto-flush until another zap
        // happened to arrive.
        if (cancelled) return;
        if (zapFlushTimerRef.current) {
          clearTimeout(zapFlushTimerRef.current);
          zapFlushTimerRef.current = null;
        }
        if (pendingZapsRef.current.length === 0) return;
        const batch = pendingZapsRef.current;
        pendingZapsRef.current = [];
        setZapsByLog((prev) => {
          // Mirror the found-log flush: only allocate the cloned outer Map on
          // the first genuinely new (logId, receiptId) pair — a batch of
          // duplicate receipts echoed from multiple relays exits without the
          // O(prev.size) clone entirely.
          let next: Map<string, Map<string, number>> | null = null;
          for (const { receiptId, logId, sats } of batch) {
            const inner = (next ?? prev).get(logId);
            if (inner && inner.has(receiptId)) continue; // already counted
            if (next === null) next = new Map(prev);
            const nextInner = new Map(inner ?? []);
            nextInner.set(receiptId, sats);
            next.set(logId, nextInner);
          }
          return next ?? prev;
        });
      };
      const closer = subscribeFindLogZaps(logIds, ({ receiptId, logId, sats }) => {
        // Same reasoning as the found-logs callback above: never buffer into
        // the shared ref once this effect instance is cancelled.
        if (cancelled) return;
        pendingZapsRef.current.push({ receiptId, logId, sats });
        if (pendingZapsRef.current.length >= 25) {
          flush();
          return;
        }
        if (zapFlushTimerRef.current === null) zapFlushTimerRef.current = setTimeout(flush, 150);
      });
      return () => {
        cancelled = true;
        // Drop any buffered zaps rather than calling flush() here — same
        // reasoning as the found-logs cleanup: `logIdsKey` changing (e.g. a
        // coord change resetting `logs`) opens a fresh subscription reusing
        // these shared refs, so draining a torn-down instance's batch into
        // state risks mixing zaps into the wrong cache's totals.
        pendingZapsRef.current = [];
        if (zapFlushTimerRef.current) {
          clearTimeout(zapFlushTimerRef.current);
          zapFlushTimerRef.current = null;
        }
        closer();
      };
      // Coord is represented by logIdsKey: on a coord change,
      // logIdsKey still holds the previous cache's ids for one render (the logs
      // reset lands in the other effect), so re-running here early would open a
      // fresh subscription for the OLD ids. Waiting for logIdsKey to update
      // means the old sub lingers one beat, which is harmless — receipts for
      // absent logs are never rendered — while subscribing stale ids is not.
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Zap defaults change independently of the log IDs.
    }, [logIdsKey, relayScope]),
  );

  // ----- derived views + optimistic insert --------------------------------

  const sortedLogs = useMemo(
    () => [...logs.values()].sort((a, b) => b.createdAt - a.createdAt),
    [logs],
  );

  // Per-log zap totals, flattened from the receipt-keyed inner Maps so
  // the row can render a single sats number cheaply on each draw.
  const zapTotalsByLog = useMemo(() => {
    const m = new Map<string, number>();
    for (const [logId, receipts] of zapsByLog) {
      let total = 0;
      for (const sats of receipts.values()) total += sats;
      if (total > 0) m.set(logId, total);
    }
    return m;
  }, [zapsByLog]);

  const addOptimisticLog = useCallback((log: FoundLog) => {
    setLogs((prev) => {
      const next = new Map(prev);
      next.set(log.id, log);
      return next;
    });
  }, []);

  return { logs, sortedLogs, zapsByLog, zapTotalsByLog, addOptimisticLog };
}
