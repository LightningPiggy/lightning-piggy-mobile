import type { VerifiedEvent } from 'nostr-tools/pure';
import {
  aggregateRelayResults,
  type DeliveryStatus,
  type RelaySettle,
} from '../utils/dmDeliveryStatus';

// Minimal structural view of nostr-tools' SimplePool — just the two methods
// this module calls. Taking it as a parameter (rather than importing the
// concrete `pool` from `nostrService`) keeps this module a leaf with no
// dependency on `nostrService`, so there's no import cycle (Copilot #858).
export interface RelayPublisher {
  publish(relays: string[], event: VerifiedEvent): Promise<string>[];
  // Optional (SimplePool has it): force-close + drop the given relays so the
  // next publish reconnects from scratch. Used by the stale-socket retry.
  close?(relays: string[]): void;
}

// Result of a NIP-17 multi-wrap DM send. `wrapsPublished` / `errors` are the
// original fields callers' partial-send logic relies on; `delivery` is the
// added per-relay breakdown for the sent bubble's tick (#856).
export interface WrapPublishOutcome {
  recipientPubkey: string | undefined;
  published: boolean;
  error?: string;
}

export interface DmSendResult {
  /** One outcome per wrap, in input order; contains no rumor plaintext. */
  wrapOutcomes: WrapPublishOutcome[];
  wrapsPublished: number;
  errors: string[];
  delivery: DeliveryStatus;
}

// Fires with the FINAL per-relay breakdown once every relay has settled (or hit
// nostr-tools' publish timeout). The send itself resolves early — as soon as
// each wrap has a known outcome — so the optimistic bubble isn't blocked on a
// slow relay; this later call lets the tick upgrade from "fast relays only" to
// the complete single→double picture (#857).
export type OnDeliveryFinalized = (delivery: DeliveryStatus) => void;

// Upper bound on how long a send waits for relays before settling to a result
// (#857). Offline / unreachable relays leave `pool.publish` promises pending
// forever (no socket → nothing to resolve OR reject), so without this cap the
// send hangs and the optimistic bubble is stuck on its pending Clock with no
// way to reach the red failed state. 8s is comfortably past nostr-tools' own
// ~4.4s relay publish timeout for reachable relays, so a genuine slow-accept
// still lands as delivered, while a dead network settles to failed.
export const DM_PUBLISH_TIMEOUT_MS = 8_000;

const TIMED_OUT = Symbol('timed-out');

// nostr-tools' `pool.publish` RESOLVES (does not reject) with this string
// prefix when `ensureRelay` can't open a socket at all (abstract-pool.js,
// verified on 2.23.3). Without this check a fully-unreachable relay counted
// as an ACCEPT — `wrapsPublished` went up and the bubble painted a green tick
// for a message that never left the device.
export const isConnectionFailure = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('connection failure:');

// Transport-shaped failures — the socket was dead/unreachable, as opposed to a
// live relay actively rejecting the event (e.g. "blocked:", "rate-limited:").
// Covers nostr-tools' "publish timed out" (a half-open socket that never sends
// OK), "relay connection timed out" / "connection failed" / "websocket closed"
// (connect-level), and the resolved "connection failure: …" string above.
const isTransportFailure = (reason: unknown): boolean => {
  const message = typeof reason === 'string' ? reason : ((reason as Error)?.message ?? '');
  return /timed out|connection|websocket/i.test(message);
};

interface AttemptOutcome {
  result: DmSendResult;
  // Relays whose failure looked transport-shaped (dead socket, unreachable,
  // never settled) — the ones worth force-reconnecting before a retry.
  staleRelays: string[];
}

/**
 * One publish attempt of a batch of gift-wraps to a relay set, capturing each
 * relay's per-wrap accept/reject and folding them into a single
 * `DeliveryStatus`. See `publishWrapsTrackingRelays` for the full contract.
 */
async function attemptPublish(
  wraps: VerifiedEvent[],
  relays: string[],
  pool: RelayPublisher,
  meta: { eventId?: string; kind?: number } | undefined,
  onFinalized: OnDeliveryFinalized | undefined,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const errors: string[] = [];
  let published = 0;
  const wrapOutcomes: WrapPublishOutcome[] = wraps.map((wrap) => ({
    recipientPubkey: wrap.tags?.find((tag) => tag[0] === 'p')?.[1],
    published: false,
  }));
  // Settles seen so far, shared across the early-resolve and background phases.
  // A relay that accepts ANY wrap is `ok`; aggregateRelayResults folds repeats.
  const settles: RelaySettle[] = [];
  const staleRelays = new Set<string>();
  // Per-wrap promises that complete only once EVERY relay for that wrap has
  // settled — awaited in the background for the final breakdown.
  const fullSettlePromises: Promise<void>[] = [];

  await Promise.all(
    wraps.map(async (wrap, index) => {
      const wrapOutcome = wrapOutcomes[index];
      const perRelay = pool.publish(relays, wrap);
      // Relays that produced a real settle (accept OR reject) for THIS wrap —
      // used to tell "relay answered" apart from "socket black-holed" in the
      // timeout branch below. Deliberately per-wrap, not shared: a relay can
      // settle an earlier wrap and still black-hole a later one mid-death,
      // and that later hang must still mark it stale (Copilot #1011).
      const settledForWrap = new Set<string>();
      // Record each relay's outcome into the shared `settles` as soon as it
      // resolves/rejects, so the early snapshot reflects whatever has landed.
      // A resolution carrying the "connection failure:" string is a FAILURE
      // (see isConnectionFailure) — never count it as an accept.
      const tagged = perRelay.map((p, i) => {
        const relay = relays[i];
        return p.then(
          (value) => {
            settledForWrap.add(relay);
            if (isConnectionFailure(value)) {
              staleRelays.add(relay);
              settles.push({ relay, ok: false });
            } else {
              settles.push({ relay, ok: true });
            }
          },
          (reason) => {
            settledForWrap.add(relay);
            if (isTransportFailure(reason)) staleRelays.add(relay);
            settles.push({ relay, ok: false });
          },
        );
      });
      // Whole-wrap settle (background) — feeds the final snapshot only.
      fullSettlePromises.push(Promise.allSettled(tagged).then(() => undefined));

      // Decide this wrap's published/error status as soon as it's KNOWN: the
      // first accept wins immediately; `Promise.any` rejects (AggregateError)
      // only once every relay has rejected. Connection-failure resolutions are
      // re-thrown so they count as rejections here too. Race it against a
      // timeout so a dead network (publish promises that never settle) can't
      // hang the send.
      const accepts = perRelay.map((p) =>
        p.then((value) => {
          if (isConnectionFailure(value)) throw new Error(value);
          return value;
        }),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      try {
        const outcome = await Promise.race([Promise.any(accepts), timeout]);
        if (outcome === TIMED_OUT) {
          // No relay accepted within the window. Record the relays that never
          // settled as failed so the snapshot is a concrete all-failed result
          // (red tick) rather than an empty one (which renders as pending).
          // A relay that never even settles is the stale-socket signature.
          for (const relay of relays) {
            if (!settledForWrap.has(relay)) {
              staleRelays.add(relay);
              if (!settles.some((s) => s.relay === relay)) settles.push({ relay, ok: false });
            }
          }
          // Neutral wording: some relays may have answered (with a rejection)
          // while others never settled — the only universal fact on this
          // branch is that nothing ACCEPTED within the window.
          wrapOutcome.error = 'publish timed out — no relay accepted within the window';
          errors.push(wrapOutcome.error);
        } else {
          published++;
          wrapOutcome.published = true;
        }
      } catch (e) {
        // `Promise.any` AggregateError — every relay rejected. Pull the first
        // individual reason so the message is a concrete relay error.
        const agg = e as AggregateError;
        const firstReason = agg?.errors?.[0] as Error | undefined;
        wrapOutcome.error = firstReason?.message ?? (e as Error)?.message ?? 'publish failed';
        errors.push(wrapOutcome.error);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }),
  );

  // Total relays attempted — carried onto every snapshot as the tick's `total`
  // so the EARLY snapshot (only the fast relay settled) reads as "1 of N", not
  // "1 of 1" (which would paint a premature double-tick). The finalize below
  // reconciles to the real per-relay breakdown once every relay settles; a
  // relay promise that never settles is bounded by DM_PUBLISH_TIMEOUT_MS above,
  // which records it as failed so the final `total` still equals this count.
  const targetRelayCount = relays.length;

  // Background-finalize: once every relay has settled, hand the caller the
  // complete breakdown so a still-in-flight relay can settle the tick.
  if (onFinalized) {
    void Promise.all(fullSettlePromises).then(() =>
      onFinalized(aggregateRelayResults(settles, meta, targetRelayCount)),
    );
  }

  return {
    result: {
      wrapOutcomes,
      wrapsPublished: published,
      errors,
      delivery: aggregateRelayResults(settles, meta, targetRelayCount),
    },
    staleRelays: [...staleRelays],
  };
}

/**
 * Publish a batch of gift-wraps to a relay set, capturing each relay's
 * per-wrap accept/reject (`Promise.allSettled` over the per-relay promises
 * `pool.publish` returns) and folding them into a single `DeliveryStatus`.
 *
 * `wrapsPublished` keeps the old `Promise.any` threshold — a wrap counts as
 * published once ≥1 relay accepts it. `errors` records, per fully-failed wrap,
 * the FIRST rejecting relay's message (a concrete relay error, deliberately
 * NOT the old `AggregateError` "all promises were rejected" text). The added
 * `delivery` field carries the per-relay detail for the bubble's tick; #856 is
 * delivery VISIBILITY only — the retry/outbox work is #857.
 *
 * `publish(relays, event)` returns one promise per relay, in the same order as
 * `relays` — so a settle maps back to its relay URL by index. The pool is
 * injected so this module stays a leaf (no `nostrService` import cycle).
 *
 * Stale-socket auto-retry: the shared SimplePool has no ping/keepalive, so
 * after Android doze or a Wi-Fi→cellular handover its sockets can be half-open
 * — "connected" as far as the pool knows, but black holes on the wire. Every
 * publish then dies on nostr-tools' ~4.4s "publish timed out" until the OS
 * finally closes the socket (minutes later), which is why a manual Re-publish
 * eventually worked. When an attempt publishes NOTHING and at least one relay
 * failed transport-shaped, we force-close those relays (dropping the stale
 * sockets) and retry the whole batch once — the automatic equivalent of the
 * manual Re-publish. Live relay rejections (e.g. "blocked:") don't trigger it.
 */
export async function publishWrapsTrackingRelays(
  wraps: VerifiedEvent[],
  relays: string[],
  pool: RelayPublisher,
  // Event identity (rumor id + kind) surfaced in the long-press detail sheet
  // (#856). Carried straight onto the resulting DeliveryStatus.
  meta?: { eventId?: string; kind?: number },
  // Optional: called once with the COMPLETE breakdown after every relay has
  // settled (#857). The send resolves early; this fires later so a slow relay
  // can upgrade the tick (e.g. single → double) without delaying the bubble.
  onFinalized?: OnDeliveryFinalized,
  // Hard cap on the wait before settling — see DM_PUBLISH_TIMEOUT_MS. Injected
  // so tests can drive it to 0.
  timeoutMs: number = DM_PUBLISH_TIMEOUT_MS,
): Promise<DmSendResult> {
  // Gift-wrap authors are ephemeral; the send caller captures sender routing.
  // The caller's finalize must only ever fire for the attempt whose result we
  // return. Whether attempt 1 is that attempt isn't known until it resolves,
  // and its background finalize can land in the same microtask turn — so gate
  // it: buffer a finalize that arrives before the retry decision, then either
  // flush it (no retry) or drop it (retrying — attempt 2 owns the tick).
  let firstAttemptIsFinal = false;
  let decided = false;
  let buffered: DeliveryStatus | null = null;
  const gatedFinalize: OnDeliveryFinalized | undefined = onFinalized
    ? (delivery) => {
        if (!decided) {
          buffered = delivery;
        } else if (firstAttemptIsFinal) {
          onFinalized(delivery);
        }
      }
    : undefined;

  const first = await attemptPublish(wraps, relays, pool, meta, gatedFinalize, timeoutMs);

  const shouldRetry =
    wraps.length > 0 &&
    first.result.wrapsPublished === 0 &&
    first.staleRelays.length > 0 &&
    typeof pool.close === 'function';

  if (!shouldRetry) {
    firstAttemptIsFinal = true;
    decided = true;
    if (buffered && onFinalized) onFinalized(buffered);
    return first.result;
  }

  decided = true; // an all-failed finalize from attempt 1 is dropped here.
  try {
    pool.close!(first.staleRelays);
  } catch {
    // Closing an already-dead socket can throw in exotic states; the retry's
    // ensureRelay reconnects either way.
  }
  const second = await attemptPublish(wraps, relays, pool, meta, onFinalized, timeoutMs);
  // Attempt 2's result stands alone: callers derive "intended sends" from
  // wrapsPublished + errors.length, so merging attempt 1's errors in would
  // double-count the same wraps.
  return second.result;
}
