import type { AbstractRelay, Subscription } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { hydrateVerifiedEventCache } from './nostrVerifyCache';
import {
  maybeLogReceiveWindow,
  recordInboxEoseLatency,
  recordReceiveWait,
  type ReceiveLane,
} from './relayReceivePerf';

export type { ReceiveLane } from './relayReceivePerf';

/** Consecutive inbox jobs run while normal work waits before one normal job
 * gets a turn: the inbox goes first, but a kind-4 backlog can't starve the rest. */
export const INBOX_BURST = 4;
export const RECEIVE_QUEUE_MAX_JOBS = 20_000;
export const RECEIVE_QUEUE_MAX_BYTES = 8 * 1024 * 1024;

type Job = {
  run: () => void | Promise<void>;
  bytes: number;
  seq: number;
  queuedAt: number;
  /** Runs only once every job enqueued before it, in either lane, has run. */
  barrier: boolean;
};
const head = (lane: Map<number, Job>): Job | undefined => lane.values().next().value;

/** One queue for ALL sockets: per-relay schedulers could each spend a frame
 * budget in the same JS turn. Keep SDK verification/filter/dedup/delivery
 * together, before EOSE. Never pretend an unverified event is valid just to
 * defer its signature check.
 *
 * Two FIFO lanes share that budget. Inbox subscriptions (kind 4 / 1059 DMs)
 * drain first, so a DM or its EOSE doesn't wait behind another feature's
 * Schnorr-verified backlog (group backfill, zap receipts, reactions…). A
 * subscription's frames all go to ONE lane, so its order (EVENT before its
 * EOSE) holds; only different subscriptions are reordered. */
export class RelayReceiveQueue {
  private lanes: Record<ReceiveLane, Map<number, Job>> = { inbox: new Map(), normal: new Map() };
  private serial = 0;
  private bytes = 0;
  private inboxStreak = 0;
  private draining = false;
  /** Seqs of queued barriers, oldest first (they're pushed in seq order). */
  private barriers = new Set<number>();

  get size(): number {
    return this.lanes.inbox.size + this.lanes.normal.size;
  }

  enqueue(run: () => void | Promise<void>, bytes = 0, lane: ReceiveLane = 'normal'): boolean {
    return this.push(lane, run, bytes, false);
  }

  /** `run` waits for every job already queued, in both lanes; inbox jobs
   * queued after it wait for it too. */
  enqueueBarrier(run: () => void | Promise<void>, bytes = 0): boolean {
    return this.push('normal', run, bytes, true);
  }

  private push(lane: ReceiveLane, run: Job['run'], bytes: number, barrier: boolean): boolean {
    if (this.size >= RECEIVE_QUEUE_MAX_JOBS || this.bytes + bytes > RECEIVE_QUEUE_MAX_BYTES)
      return false;
    const seq = this.serial++;
    this.lanes[lane].set(seq, { run, bytes, seq, queuedAt: Date.now(), barrier });
    if (barrier) this.barriers.add(seq);
    this.bytes += bytes;
    if (!this.draining) void this.drain();
    return true;
  }

  private next(): ReceiveLane {
    const inbox = head(this.lanes.inbox);
    const normal = head(this.lanes.normal);
    if (!normal) return 'inbox';
    // While a barrier is queued (anywhere in the normal lane), only inbox work
    // OLDER than it may run: newer inbox frames must not overtake the normal
    // backlog ahead of the barrier and delay (or extend) its snapshot.
    const barrier: number | undefined = this.barriers.values().next().value;
    if (!inbox || (barrier !== undefined && inbox.seq > barrier)) return 'normal';
    if (normal.barrier) return 'inbox'; // older inbox work runs before it
    return this.inboxStreak < INBOX_BURST ? 'inbox' : 'normal';
  }

  private async drain(): Promise<void> {
    this.draining = true;
    const pacing = createYieldScheduler({ safetyEvery: 64, budgetMs: 4, coldStart: true });
    try {
      await hydrateVerifiedEventCache();
      while (this.size) {
        // Gate BEFORE every unit, including after await/hydration. A 34 ms
        // Schnorr is indivisible, but a second one never follows in the same
        // budget slice. Fast cached hashes share the 4 ms budget.
        await pacing.maybeYield();
        // Pick after the yield: inbox frames that arrived meanwhile go first.
        const lane = this.next();
        const job = head(this.lanes[lane])!;
        this.lanes[lane].delete(job.seq);
        if (job.barrier) this.barriers.delete(job.seq);
        this.bytes -= job.bytes;
        this.inboxStreak =
          lane === 'inbox' && this.lanes.normal.size > 0 ? this.inboxStreak + 1 : 0;
        const started = Date.now();
        if (!job.barrier) recordReceiveWait(lane, started - job.queuedAt);
        maybeLogReceiveWindow(started);
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

/** Same rule as `reqPriority(filters) === 0` in `relayReqBudget` (kept local:
 * that module imports this one). Covers the inbox fetch, the live inbox and
 * Marmot Welcomes, which arrive as kind-1059 gift wraps too. */
export const isInboxSubscription = (filters: Filter[]): boolean =>
  filters.some((f) => f.kinds?.some((k) => k === 4 || k === 1059));
const inboxSubs = new WeakSet<Subscription>();
type Lane = ReceiveLane | 'barrier';

/** `["EVENT"|"EOSE"|"CLOSED", "<sub id>"` with a plain (unescaped) type and
 * id. Anchored: stops at the id's closing quote, never parses the event. */
const FRAME_SUB_ID = /^\s*\[\s*"[A-Z]+"\s*,\s*"([^"\\]*)"/;

/** How many raw frames ONE socket to a URL may receive, while outbox leases
 * hold that URL. Only URLs the app opened on someone else's behalf (outbox
 * reads, #1390) ever have one: the viewer's own relays are never counted. */
const frameGrants = new Map<string, { frames: number; onExceeded: () => void }>();
/** Frames each socket has received, keyed by the WebSocket itself (a relay
 * that reconnects gets a new one) — never per URL: a closed socket's count
 * (or blown budget) never touches the next socket to that URL. */
const framesUsed = new WeakMap<object, number>();
const socketOf = (relay: AbstractRelay): object =>
  (relay as unknown as { ws?: object }).ws ?? relay;

/**
 * Let each socket to `url` receive `frames` more frames (any type, counted on
 * arrival, before any parsing); past that, the socket is closed and
 * `onExceeded` runs, once per socket. A second call tops up the grant.
 */
export function addRelayFrameBudget(url: string, frames: number, onExceeded: () => void): void {
  const grant = frameGrants.get(url);
  if (grant) grant.frames += frames;
  else frameGrants.set(url, { frames, onExceeded });
}

/** Stop counting frames for `url` (its leases are gone). */
export function clearRelayFrameBudget(url: string): void {
  frameGrants.delete(url);
}

/** This socket closed (for any reason): forget its count. */
export function forgetRelayFrames(relay: AbstractRelay): void {
  framesUsed.delete(socketOf(relay));
  framesUsed.delete(relay);
}

/** False when this frame is over its socket's budget (drop it). */
function withinFrameBudget(relay: AbstractRelay): boolean {
  const grant = frameGrants.get(relay.url);
  if (!grant) return true;
  const socket = socketOf(relay);
  const used = (framesUsed.get(socket) ?? 0) + 1;
  framesUsed.set(socket, used);
  if (used <= grant.frames) return true;
  if (used === grant.frames + 1) {
    // Out of the socket's message handler before closing it. Frames that
    // arrive meanwhile are dropped; once closed, the socket drops the rest.
    void Promise.resolve().then(() => {
      try {
        relay.close();
      } finally {
        grant.onExceeded();
      }
    });
  }
  return false;
}

/** Snapshot deadlines share the receive queue's boundary: finish only after
 * events already received (in either lane) have been verified and delivered.
 * Verification trust persists in the background (`nostrVerifyCache`), never
 * on this path. Explicit cancellation must bypass this barrier so tab-blur
 * still closes immediately. */
export function finishAfterRelayReceive(finish: () => void): void {
  // Overload already closes paced sockets; don't leave a query pending forever
  // if the bounded queue cannot accept its completion marker either.
  if (!sharedQueue.enqueueBarrier(finish)) finish();
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
  let receivedAt = 0;
  let wireEose: (() => void) | undefined;
  /** A relay that sent a frame we can't attribute to a subscription cheaply
   * (escaped JSON, binary) loses the inbox lane. That frame is a barrier, so
   * it and everything the relay sends after it keep wire order behind its
   * earlier inbox frames. The fence lifts only once every demoted job has run
   * (never merely on reconnect), so no later inbox frame can overtake one. */
  let demotedPending = 0;
  const fenced = () => demotedPending > 0;
  const enqueue = (run: () => void | Promise<void>, bytes: number, lane: Lane, demoted = false) => {
    const guarded = demoted
      ? async () => {
          try {
            if (!closed) await run();
          } finally {
            demotedPending--;
          }
        }
      : () => {
          if (!closed) return run();
        };
    const queued =
      lane === 'barrier'
        ? queue.enqueueBarrier(guarded, bytes)
        : queue.enqueue(guarded, bytes, lane);
    if (queued && demoted) demotedPending++;
    if (!queued) relay.close();
  };
  const laneOf = (data: unknown): Lane => {
    const id = typeof data === 'string' ? FRAME_SUB_ID.exec(data)?.[1] : undefined;
    if (id === undefined) return 'barrier';
    const sub = fenced() ? undefined : relay.openSubs.get(id);
    return sub && inboxSubs.has(sub) ? 'inbox' : 'normal';
  };
  relay._onmessage = (message) => {
    if (closed) return;
    // One Map lookup, only non-empty while outbox sockets are open.
    if (frameGrants.size > 0 && !withinFrameBudget(relay)) return;
    const data = message.data;
    // Only explicit crypto-free control types bypass pacing. Queue ambiguous
    // JSON too: an escaped "\\u0045VENT" also decodes to EVENT in the SDK.
    if (typeof data === 'string' && /^\s*\[\s*"(?:AUTH|OK|COUNT|NOTICE)"/.test(data)) {
      receive(message);
      return;
    }
    const arrivedAt = Date.now();
    const lane = laneOf(data);
    enqueue(
      () => {
        receiving = true;
        receivedAt = arrivedAt;
        try {
          receive(message);
        } finally {
          receiving = false;
        }
        const complete = wireEose;
        wireEose = undefined;
        complete?.();
      },
      typeof data === 'string' ? data.length * 2 : 0,
      lane,
      lane === 'barrier' || fenced(),
    );
  };
  relay.prepareSubscription = (...args) => {
    const sub = prepare(...args);
    const inbox = isInboxSubscription(args[0]);
    if (inbox) inboxSubs.add(sub);
    const eose = sub.receivedEose.bind(sub);
    // The SDK's wall-clock timeout may expire while a large valid backlog is
    // being paced. Queue that timeout behind received events (in this
    // subscription's lane) rather than close the subscription and discard
    // events already received before the timeout.
    sub.receivedEose = () => {
      const since = receiving ? receivedAt : Date.now();
      const complete = () => {
        if (closed || relay.openSubs.get(sub.id) !== sub) return;
        // A timeout and a wire EOSE can both complete; the SDK fires oneose once.
        if (inbox && !sub.eosed) recordInboxEoseLatency(Date.now() - since);
        eose();
      };
      // Wire EOSE already occupies its ordered queue position: complete it
      // there, right after the SDK has parsed it. Only wall-clock timeouts
      // need a new job behind received events.
      if (receiving) wireEose = complete;
      else if (inbox && !fenced()) enqueue(complete, 0, 'inbox');
      else enqueue(complete, 0, 'normal', fenced());
    };
    return sub;
  };
  relay.close = () => {
    closed = true;
    close();
  };
}
