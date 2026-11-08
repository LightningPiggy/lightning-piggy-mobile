import type { Event as NostrEvent } from 'nostr-tools/pure';
import { finishAfterRelayReceive } from './nostrRelayReceiveQueue';

/** The close reason the health-aware pool gives a one-shot REQ that reached EOSE. */
export const RELAY_EOSE_REASON = 'closed automatically on eose';

/**
 * Finish a read once `quorum` relays have reached EOSE, plus `graceMs` for
 * the rest (#1759). Without it, one stuck relay (rate-limited, AUTH-gated, a
 * dead socket after Doze) holds the whole read until the deadline.
 */
export type RelayQuorum = { quorum: number; graceMs: number };

export type QuorumOutcome = 'all' | 'quorum' | 'deadline' | 'aborted';

export interface QuorumStats {
  relays: number;
  eosed: number;
  failed: number;
  /** Relays still pending when the read finished (closed by us). */
  cut: number;
  /** Frames skipped before parse/verify by the caller's `alreadyHaveEvent`. */
  skippedKnown: number;
  outcome: QuorumOutcome;
  ms: number;
}

export interface QuorumRelayHandlers {
  /** Shared across relays: dedupes before the SDK parses or verifies. */
  alreadyHaveEvent: (id: string) => boolean;
  onevent: (event: NostrEvent) => void;
  /** Called once per relay; `RELAY_EOSE_REASON` means it served its history. */
  onclose: (reason: string) => void;
}

/**
 * Runs one REQ per relay (opened by `open`) and resolves with the deduped
 * events once:
 * - every relay has reached EOSE or failed ('all'), or
 * - `quorum` relays have reached EOSE and `graceMs` has passed ('quorum'), or
 * - `maxWait` has passed ('deadline' — the backstop; its completion still
 *   drains events already received, like `querySyncAbortable`), or
 * - `signal` aborts ('aborted', immediately).
 *
 * Never rejects: a partial read is fine for callers that reconcile through a
 * live subscription. Relays still pending at the end are closed, so their
 * queued frames are dropped instead of being verified on the JS thread.
 */
export function queryRelaysQuorum(input: {
  relays: string[];
  open: (url: string, handlers: QuorumRelayHandlers) => { close: (reason?: string) => void };
  maxWait: number;
  quorum: RelayQuorum;
  signal?: AbortSignal;
  /** Skip ids the caller already has, before parse/verify. */
  alreadyHaveEvent?: (id: string) => boolean;
  onSettled?: (stats: QuorumStats) => void;
}): Promise<NostrEvent[]> {
  const { relays, quorum, signal } = input;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const events: NostrEvent[] = [];
    const seen = new Set<string>();
    const delivered = new Set<string>();
    const eosed = new Set<string>();
    const failed = new Set<string>();
    const subs = new Map<string, { close: (reason?: string) => void }>();
    const need = Math.max(1, Math.min(quorum.quorum, relays.length));
    let skippedKnown = 0;
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: QuorumOutcome) => {
      if (settled) return;
      settled = true;
      if (grace) clearTimeout(grace);
      if (deadline) clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      let cut = 0;
      for (const [url, sub] of subs) {
        if (eosed.has(url) || failed.has(url)) continue;
        cut++;
        try {
          sub.close(`quorum read finished (${outcome})`);
        } catch {
          // already closing — ignore.
        }
      }
      try {
        input.onSettled?.({
          relays: relays.length,
          eosed: eosed.size,
          failed: failed.size,
          cut,
          skippedKnown,
          outcome,
          ms: Date.now() - startedAt,
        });
      } catch (error) {
        // A stats consumer must never wedge the read or throw into the SDK.
        if (__DEV__) console.warn('[Nostr] quorum onSettled failed:', error);
      }
      resolve(events);
    };
    const onAbort = () => finish('aborted');
    const settleRelay = (url: string, reason: string) => {
      if (settled || eosed.has(url) || failed.has(url)) return;
      const answered = reason === RELAY_EOSE_REASON;
      (answered ? eosed : failed).add(url);
      if (eosed.size + failed.size === relays.length) finish('all');
      else if (answered && eosed.size === need)
        // Quorum relays' events are all in (each EOSE is paced behind its own
        // events), so close the stragglers now rather than queue behind their
        // backlog. NB the grace is wall-clock: a straggler whose frames are
        // still in the receive queue is cut too — `cut` vs `eosed` in the
        // callers' [Perf] lines measures how often (#1759).
        grace = setTimeout(() => finish('quorum'), quorum.graceMs);
    };
    if (signal?.aborted || relays.length === 0) {
      finish(signal?.aborted ? 'aborted' : 'all');
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    deadline = setTimeout(() => finishAfterRelayReceive(() => finish('deadline')), input.maxWait);
    const handlers = (url: string): QuorumRelayHandlers => ({
      alreadyHaveEvent: (id) => {
        if (settled) return true;
        if (input.alreadyHaveEvent?.(id)) {
          skippedKnown++;
          return true;
        }
        const have = seen.has(id);
        seen.add(id);
        return have;
      },
      onevent: (event) => {
        if (settled || delivered.has(event.id)) return;
        delivered.add(event.id);
        events.push(event);
      },
      onclose: (reason) => settleRelay(url, reason),
    });
    for (const url of relays) {
      if (settled) break;
      subs.set(url, input.open(url, handlers(url)));
    }
  });
}
