import type { AbstractRelay } from 'nostr-tools/abstract-relay';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { hydrateVerifiedEventCache, flushVerifiedEventCache } from './nostrVerifyCache';

/** One queue for ALL sockets: per-relay schedulers could each spend a frame
 * budget in the same JS turn. Keep SDK verification/filter/dedup/delivery
 * together, in wire order, before EOSE. Never pretend an unverified event is
 * valid just to defer its signature check. */
export class RelayReceiveQueue {
  private jobs = new Map<number, { run: () => void | Promise<void>; bytes: number }>();
  private serial = 0;
  private bytes = 0;
  private draining = false;

  enqueue(run: () => void | Promise<void>, bytes = 0): boolean {
    if (this.jobs.size >= 20_000 || this.bytes + bytes > 8 * 1024 * 1024) return false;
    this.jobs.set(this.serial++, { run, bytes });
    this.bytes += bytes;
    if (!this.draining) void this.drain();
    return true;
  }

  private async drain(): Promise<void> {
    this.draining = true;
    const pacing = createYieldScheduler({ safetyEvery: 64, budgetMs: 4, coldStart: true });
    try {
      await hydrateVerifiedEventCache();
      while (this.jobs.size) {
        // Gate BEFORE every unit, including after await/hydration. A 34 ms
        // Schnorr is indivisible, but a second one never follows in the same
        // budget slice. Fast cached hashes share the 4 ms budget.
        await pacing.maybeYield();
        const id = this.jobs.keys().next().value!;
        const job = this.jobs.get(id)!;
        this.jobs.delete(id);
        this.bytes -= job.bytes;
        try {
          await job.run();
        } catch {
          // A bad callback must not wedge the remaining sockets' receive work.
        }
      }
    } finally {
      pacing.dispose();
      this.draining = false;
    }
  }
}

const sharedQueue = new RelayReceiveQueue();
const installed = new WeakSet<AbstractRelay>();

interface FrameBudget {
  left: number;
  exceeded: boolean;
  onExceeded: () => void;
}
/** Raw-frame budgets, by normalised relay URL. Only sockets the app opened on
 * someone else's behalf (outbox reads, #1390) ever have one: the viewer's own
 * relays are never counted. */
const frameBudgets = new Map<string, FrameBudget>();

/**
 * Give `url`'s socket `frames` more frames (any type, counted on arrival,
 * before any parsing) before it's closed and `onExceeded` runs once. A second
 * call tops up the same budget.
 */
export function addRelayFrameBudget(url: string, frames: number, onExceeded: () => void): void {
  const budget = frameBudgets.get(url);
  if (budget && !budget.exceeded) budget.left += frames;
  else frameBudgets.set(url, { left: frames, exceeded: false, onExceeded });
}

/** Stop counting `url`'s frames. */
export function clearRelayFrameBudget(url: string): void {
  frameBudgets.delete(url);
}

/** False when this frame is over its socket's budget (drop it). */
function withinFrameBudget(relay: AbstractRelay): boolean {
  const budget = frameBudgets.get(relay.url);
  if (!budget) return true;
  if (budget.exceeded) return false;
  if (--budget.left >= 0) return true;
  budget.exceeded = true;
  // Out of the socket's message handler before closing it.
  void Promise.resolve().then(() => {
    try {
      relay.close();
    } finally {
      budget.onExceeded();
    }
  });
  return false;
}

/** Snapshot deadlines share the receive queue's boundary: finish only after
 * events already received have been verified, delivered and persisted. Explicit
 * cancellation must bypass this barrier so tab-blur still closes immediately. */
export function finishAfterRelayReceive(finish: () => void): void {
  const queued = sharedQueue.enqueue(async () => {
    try {
      await flushVerifiedEventCache();
    } finally {
      finish();
    }
  });
  // Overload already closes paced sockets; don't leave a query pending forever
  // if the bounded queue cannot accept its completion marker either.
  if (!queued) finish();
}

/** Install BEFORE connect(): nostr-tools binds _onmessage when opening WS.
 * Uses the SDK's public receive/prepare hooks; integration tests guard those
 * hooks on upgrades. Control replies bypass crypto backlog (AUTH/OK/COUNT). */
export function paceRelayReceive(relay: AbstractRelay, queue = sharedQueue): void {
  if (installed.has(relay)) return;
  installed.add(relay);
  const receive = relay._onmessage.bind(relay);
  const prepare = relay.prepareSubscription.bind(relay);
  const close = relay.close.bind(relay);
  let closed = false;
  let receiving = false;
  let wireEose: (() => Promise<void>) | undefined;
  const enqueue = (run: () => void | Promise<void>, bytes = 0) => {
    if (
      !queue.enqueue(() => {
        if (!closed) return run();
      }, bytes)
    )
      relay.close();
  };
  relay._onmessage = (message) => {
    if (closed) return;
    // One Map lookup, only non-empty while outbox sockets are open.
    if (frameBudgets.size > 0 && !withinFrameBudget(relay)) return;
    const data = message.data;
    // Only explicit crypto-free control types bypass pacing. Queue ambiguous
    // JSON too: an escaped "\\u0045VENT" also decodes to EVENT in the SDK.
    if (typeof data === 'string' && /^\s*\[\s*"(?:AUTH|OK|COUNT|NOTICE)"/.test(data)) {
      receive(message);
    } else
      enqueue(
        () => {
          receiving = true;
          try {
            receive(message);
          } finally {
            receiving = false;
          }
          const complete = wireEose;
          wireEose = undefined;
          return complete?.();
        },
        typeof data === 'string' ? data.length * 2 : 0,
      );
  };
  relay.prepareSubscription = (...args) => {
    const sub = prepare(...args);
    const eose = sub.receivedEose.bind(sub);
    // The SDK's wall-clock timeout may expire while a large valid backlog is
    // being paced. Queue that timeout behind received events rather than close
    // the subscription and discard events already received before the timeout.
    sub.receivedEose = () => {
      const complete = async () => {
        // A completed snapshot has durable verification trust before its
        // caller stores/decrypts the results. Live events also debounce writes.
        await flushVerifiedEventCache();
        if (!closed && relay.openSubs.get(sub.id) === sub) eose();
      };
      // Wire EOSE already occupies its ordered queue position. Await its flush
      // there; only wall-clock timeouts need a new job behind received events.
      if (receiving) wireEose = complete;
      else enqueue(complete);
    };
    return sub;
  };
  relay.close = () => {
    closed = true;
    close();
  };
}
