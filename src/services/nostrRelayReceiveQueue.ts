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
    if (frameGrants.size > 0 && !withinFrameBudget(relay)) return;
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
