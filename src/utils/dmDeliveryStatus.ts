// Delivery-status plumbing for sent NIP-17 DMs (#856). A send fans a
// gift-wrap out to N relays; today the send path collapses the per-relay
// outcome via `Promise.any` ("≥1 relay accepted"). This module captures the
// per-relay accept/reject so a sent bubble can show a delivery tick and, on
// long-press, a "sent to X of Y relays" breakdown.
//
// VISIBILITY ONLY — it does NOT change the partial-send = failure semantics
// in useMessageSend, and adds no retry. The outbox/retry work is #857.

import type { DmProtocol } from './dmProtocol';

// Per-relay publish outcome for one sent message, keyed by relay URL.
// `ok` = at least one of this send's wraps was accepted by that relay;
// `failed` = the relay rejected / errored for every wrap we tried.
export type RelayDeliveryResult = 'ok' | 'failed';

// Attached to a sent (fromMe) message so the bubble can render its tick and
// the per-relay breakdown survives a thread reload (persisted in the DM
// cache alongside the message). `undefined` on a message = legacy / received
// row with no delivery tracking — render no tick.
export interface DeliveryStatus {
  // True once ≥1 relay accepted ≥1 wrap. Mirrors the existing `Promise.any`
  // success signal, so the tick shows for exactly the sends that already
  // count as "sent" today.
  delivered: boolean;
  // Group fan-out failed even though some wraps reached relays.
  sendFailed?: boolean;
  relayResults: Record<string, RelayDeliveryResult>;
  // How many relays the send ATTEMPTED — the full target set, not just the
  // relays that have settled so far (#857). The early/optimistic snapshot only
  // has settles for the fast relays, so `relayResults` undercounts; `total`
  // must reflect the attempted count or a single fast ack reads as "all relays"
  // (ok === total) and shows a premature double-tick. Undefined on legacy rows
  // / pre-publish failures → callers fall back to the settled-relay count.
  targetRelayCount?: number;
  // Optional event identity for the long-press detail sheet (#856). `eventId`
  // is the NIP-17 rumor id (the stable inner kind-14/15 event id, shared
  // across the recipient + self wraps); `kind` is the rumor kind (14 text,
  // 15 file). Best-effort — older persisted rows won't carry them.
  eventId?: string;
  kind?: number;
  // True while the send is still in flight — no relay has settled yet (#857).
  // Drives the faint pending Clock, distinguishing an optimistic bubble from an
  // all-failed send (which also has zero `ok` relays, but renders the red
  // AlertCircle). Cleared once the publish resolves.
  pending?: boolean;
}

// Build the seed `relayResults` for a not-yet-settled send from the target relay
// list — every target marked `failed` until a real settle upgrades it. This is
// what lets the message-info sheet list the relays a send was ATTEMPTED against
// even while it's pending or after an all-failed/hung timeout, instead of an
// empty breakdown (the missing-relays bug). Empty for callers with no relay list
// (legacy / tests) — those fall back to the bare "Not tracked" metadata.
function seedRelayResults(relays?: string[]): Record<string, RelayDeliveryResult> {
  const out: Record<string, RelayDeliveryResult> = {};
  for (const url of relays ?? []) out[url] = 'failed';
  return out;
}

// Status for an optimistic bubble that's still publishing (#857): no relay has
// settled yet, so the tick renders the faint pending Clock. `meta.relays` (the
// send's target relay set) pre-seeds `relayResults` so the info sheet can list
// every relay the send is going out to even before any has acked.
export function pendingDelivery(meta?: {
  eventId?: string;
  kind?: number;
  relays?: string[];
}): DeliveryStatus {
  const { relays, ...rest } = meta ?? {};
  return {
    delivered: false,
    relayResults: seedRelayResults(relays),
    targetRelayCount: relays?.length,
    pending: true,
    ...rest,
  };
}

// Status for a send that produced NO settled delivery — a hard error before the
// publish stage (not logged in, signer cancelled) OR a send that hung past the
// watchdog without any relay settling. The bubble shows the red failed glyph.
// `meta.relays` (the attempted target set) seeds `relayResults` as all-failed so
// the info sheet still lists the relays the send tried — without it the sheet
// showed no relays at all on a failed/hung send (the missing-relays bug).
export function failedDelivery(meta?: {
  eventId?: string;
  kind?: number;
  relays?: string[];
}): DeliveryStatus {
  const { relays, ...rest } = meta ?? {};
  return {
    delivered: false,
    relayResults: seedRelayResults(relays),
    targetRelayCount: relays?.length,
    ...rest,
  };
}

// Everything the message-info sheet needs for ONE message — sent or received
// (#856). For a sent message `deliveryStatus` carries the per-relay tick +
// Re-publish payload; for a received message it's absent and we just show the
// metadata (protocol / kind / id). `wireKind` distinguishes NIP-17
// (gift-wrapped, kind 14/15) from legacy NIP-04 (kind 4).
export interface MessageInfo {
  direction: 'sent' | 'received';
  eventId: string;
  // The stored kind: 4 = NIP-04, 14/15 = NIP-17 rumor kind (Marmot rows
  // reuse 14/15 for their kind-9 rumors — see utils/messageInfo).
  wireKind?: number;
  // The message's protocol (set by `buildMessageInfo`). Marmot rumors reuse
  // NIP-17's kinds, so the kind alone can't tell them apart.
  protocol?: DmProtocol;
  // What `eventId` is: a NIP-04 event, a NIP-17 / Marmot rumor (not on relays
  // by itself), or the NIP-17 gift wrap we received.
  idKind?: 'event' | 'rumor' | 'wrap';
  // Present only for sent messages — drives the relay breakdown + tick.
  deliveryStatus?: DeliveryStatus;
  // Raw text to hand Re-publish (sent kind-14 only); empty otherwise.
  resendText?: string;
}

/** Human label for the wire protocol shown in the message-info sheet. */
export function protocolLabel(wireKind: number | undefined, protocol?: DmProtocol): string {
  if (protocol === 'marmot') return 'Marmot (MLS)';
  if (protocol === 'nip04' || wireKind === 4) return 'NIP-04 (legacy DM)';
  // A known NIP-17 thread: any rumor kind (polls 1068, orders 16/17, …).
  if (protocol === 'nip17' || wireKind === 14 || wireKind === 15) return 'NIP-17 (gift-wrapped)';
  return 'Unknown';
}

/** Whether a message travelled as an encrypted NIP-17 gift wrap. */
export function isGiftWrapped(wireKind: number | undefined): boolean {
  return wireKind === 14 || wireKind === 15;
}

// One relay's settled publish outcomes across all of a send's wraps. The
// recipient wrap and the self-copy wrap each publish to the same relay list,
// so a relay can appear with one settle per wrap. We fold them: a relay is
// `ok` if it accepted ANY wrap (delivery to that relay is proven by a single
// ack), `failed` only if every wrap to it rejected.
export interface RelaySettle {
  relay: string;
  ok: boolean;
}

/**
 * Fold per-relay, per-wrap settle results into a single `DeliveryStatus`.
 *
 * Pure + dependency-free so it's unit-testable in isolation (ok / partial /
 * all-fail). Each entry is one wrap's outcome at one relay; the same relay
 * may appear multiple times (once per wrap). A relay is `ok` if it accepted
 * at least one wrap. `meta` carries optional event identity (rumor id + kind)
 * for the detail sheet.
 */
export function aggregateRelayResults(
  settles: RelaySettle[],
  meta?: { eventId?: string; kind?: number },
  // Number of relays the send attempted (the full target set). Carried onto the
  // status as `targetRelayCount` so the early snapshot reports the true total
  // even though only the fast relays have settled (#857). Omit for callers that
  // don't track a target (pure folds in tests) — `total` then derives from the
  // settled relays as before.
  targetRelayCount?: number,
): DeliveryStatus {
  const relayResults: Record<string, RelayDeliveryResult> = {};
  for (const s of settles) {
    // Once a relay is `ok` (accepted some wrap) it stays `ok` — a later
    // wrap's failure to the same relay doesn't downgrade proven delivery.
    if (s.ok) {
      relayResults[s.relay] = 'ok';
    } else if (relayResults[s.relay] !== 'ok') {
      relayResults[s.relay] = 'failed';
    }
  }
  const delivered = Object.values(relayResults).some((r) => r === 'ok');
  return { delivered, relayResults, eventId: meta?.eventId, kind: meta?.kind, targetRelayCount };
}

/**
 * Which title the message-info sheet shows, as a translation-key descriptor
 * (the component maps `key` → `deliveryDetailSheet.<key>` via i18n).
 *
 * The `!status` branch matters: a SENT message with no `DeliveryStatus` at all
 * is an UNTRACKED send — group sends today, plus 1:1 rows that predate
 * tracking — not a failure. Group bubbles only exist because the relay publish
 * succeeded (the composer alerts and skips the optimistic append otherwise),
 * so titling them "Send failed" was provably wrong. "Send failed" is
 * reserved for a TRACKED, settled send whose relay breakdown is empty (e.g. a
 * pre-publish `failedDelivery`); the status row's "Not tracked" / "Failed"
 * split (below) already made this distinction.
 */
export type DeliverySheetTitle =
  | { key: 'messageReceived' }
  | { key: 'messageSent' }
  | { key: 'sending' }
  | { key: 'sendingToRelays'; total: number }
  | { key: 'sendFailed' }
  | { key: 'sentToRelays'; ok: number; total: number };

export function deliverySheetTitle(
  direction: 'sent' | 'received',
  status: DeliveryStatus | undefined,
): DeliverySheetTitle {
  if (direction !== 'sent') return { key: 'messageReceived' };
  if (!status) return { key: 'messageSent' };
  const { ok, total } = summariseDelivery(status);
  // In flight: seeded relays read as `failed` (ok 0 of N), but the send hasn't
  // settled, so say "Sending…" rather than "Sent to 0 of N relays".
  if (status.pending) {
    return total > 0 ? { key: 'sendingToRelays', total } : { key: 'sending' };
  }
  if (status.sendFailed || total === 0) return { key: 'sendFailed' };
  return { key: 'sentToRelays', ok, total };
}

/** Count of relays that accepted, and the total relays attempted. Drives the
 * breakdown copy ("Sent to 4 of 6 relays") and the single→double tick. `total`
 * is the attempted relay count (`targetRelayCount`) when known, so an early
 * snapshot with only the fast relay settled reads as "1 of N" (single tick) —
 * NOT "1 of 1" (premature double). Falls back to the settled-relay count for
 * legacy rows that predate `targetRelayCount`. Guards against a stale target
 * undercounting by never reporting fewer relays than have actually settled. */
export function summariseDelivery(status: DeliveryStatus): { ok: number; total: number } {
  const values = Object.values(status.relayResults);
  const settledTotal = values.length;
  const total =
    status.targetRelayCount !== undefined
      ? Math.max(status.targetRelayCount, settledTotal)
      : settledTotal;
  return { ok: values.filter((r) => r === 'ok').length, total };
}

/** Strip the `wss://` / `ws://` scheme and trailing slash for a compact relay
 * label in the breakdown sheet. */
export function shortRelayLabel(url: string): string {
  return url.replace(/^wss?:\/\//, '').replace(/\/$/, '');
}
