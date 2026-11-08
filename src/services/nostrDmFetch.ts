import type { Filter } from 'nostr-tools/filter';
import { enabledAppRelays } from './appRelayPrefs';
import { DM_INBOX_LIMIT, KIND4_REPLAY_OVERLAP_SECONDS } from './dmInboxFetchPolicy';
import { pool, trackRelays } from './nostrPool';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import type { QuorumStats, RelayQuorum } from './relayQuorumQuery';
import { PERF_LOGS_ENABLED } from '../utils/perfLog';

// Bulk DM reads (inbox + per-conversation kind-4), extracted from
// ./nostrService (#703 size cap). Both send ONE REQ per relay carrying every
// filter (#1759). By default they are full reads: they wait for every relay
// (to EOSE, failure, or the per-relay timeout), exactly as before #1759.
//
// The inbox fetch can opt into a QUORUM read (`quorum: true`): finished once
// DM_FETCH_QUORUM relays reached EOSE plus a grace period, with the deadline
// as the backstop. Why 2 relays + 1.2 s rather than a majority: the read set
// is the user's relays plus ~5 app defaults, and waiting for the k-th of n
// answers is the k-th order statistic of their latencies — a majority of 6-8
// relays brings the slow tail straight back. Two independent EOSEs guard
// against a single relay that is empty or behind.
//
// A quorum read that cut a relay off reports `complete: false`. Callers must
// then (a) not advance a kind-4 cursor from it, and (b) follow up with a full
// read off the critical path, or the cut relay's data is never fetched: the
// live sub only covers `#p: viewer`, so a slow relay's SENT kind-4 (from
// another device) would be hidden indefinitely, cut again on every quorum
// read. useDmInbox does both (deferred backfill). Only the latency-critical
// focus refresh uses the quorum; pull-to-refresh, backfill and conversation
// reads are full reads. Failed relays never make a read partial.
export const DM_FETCH_QUORUM: RelayQuorum = { quorum: 2, graceMs: 1200 };

/** Logs the quorum outcome and records whether the read was complete. */
const settledInto =
  (what: string, read: { complete: boolean }) =>
  (s: QuorumStats): void => {
    read.complete = s.cut === 0;
    if (!PERF_LOGS_ENABLED) return;
    console.log(
      `[Perf] ${what} fetch quorum: relays=${s.relays}, eosed=${s.eosed}, failed=${s.failed}, ` +
        `cut=${s.cut}, outcome=${s.outcome}, ${s.ms}ms`,
    );
  };

export interface RawDmEvent {
  id: string;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Fetch NIP-4 encrypted DMs (kind 4) exchanged between `myPubkey` and
 * `otherPubkey`, in either direction. Returns raw events — decryption
 * happens in the context layer where the signer (nsec / Amber) lives.
 *
 * Two filters in one REQ per relay: messages authored by me tagged to the
 * other, and messages authored by the other tagged to me. Most relays index
 * `#p`, so this pair covers both conversation halves.
 */
export async function fetchDirectMessageEvents(
  myPubkey: string,
  otherPubkey: string,
  relays: string[],
  options: { limit?: number; since?: number } = {},
): Promise<{ events: RawDmEvent[]; complete: boolean }> {
  const allRelays = [...new Set([...relays, ...enabledAppRelays('default', DEFAULT_RELAYS)])];
  trackRelays(allRelays);
  const limit = options.limit ?? 200;
  // Damus's trick (SubscriptionManager.swift:293-300): pad `since` back
  // by 2 minutes so relays with slightly-off clocks still return the
  // last few events we might have missed on the previous fetch. On
  // first fetch (no cached last-seen) the caller passes undefined, so
  // the filter has no `since` and the relay returns full history.
  const since =
    options.since !== undefined
      ? Math.max(0, options.since - KIND4_REPLAY_OVERLAP_SECONDS)
      : undefined;
  const fromMeFilter: Filter = {
    kinds: [4],
    authors: [myPubkey],
    '#p': [otherPubkey],
    limit,
  };
  const toMeFilter: Filter = {
    kinds: [4],
    authors: [otherPubkey],
    '#p': [myPubkey],
    limit,
  };
  if (since !== undefined) {
    fromMeFilter.since = since;
    toMeFilter.since = since;
  }
  try {
    // Full read: a conversation open must see every relay's history (the
    // thread paints from the store meanwhile). maxWait closes each relay's
    // REQ at 15 s if EOSE never arrives (proper teardown).
    const events = await pool.querySyncFilters(allRelays, [fromMeFilter, toMeFilter], 15000);
    const byId = new Map<string, RawDmEvent>();
    for (const ev of events) if (ev.kind === 4) byId.set(ev.id, ev as RawDmEvent);
    return { events: Array.from(byId.values()), complete: true };
  } catch (error) {
    if (__DEV__) console.warn('[Nostr] fetchDirectMessageEvents failed:', error);
    return { events: [], complete: false };
  }
}

export interface RawGiftWrapEvent {
  id: string;
  pubkey: string;
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  sig: string;
}

export interface FetchedInboxEvents {
  kind4: RawDmEvent[];
  kind1059: RawGiftWrapEvent[];
  /** False when a relay was cut off (or the read failed): don't advance a
   * kind-4 cursor from this read. */
  complete: boolean;
}

/**
 * Fetch every DM event that could end up in the current user's inbox:
 * legacy NIP-04 kind-4 events in either direction, plus NIP-17 gift wraps
 * (kind 1059) addressed to them. Returned events are raw — the caller
 * decrypts/unwraps in the context layer where the signer lives.
 *
 * Three filters in ONE REQ per relay (one budget slot, one round trip):
 * `authors=me` covers outgoing kind-4 (which tag the recipient, not me);
 * `#p=me` covers incoming kind-4 and NIP-17 wraps (which always tag the
 * recipient — including self-wraps of the sender's own copy). This matches
 * Damus's twin kind-4 strategy and layers NIP-17 on top.
 */
export async function fetchInboxDmEvents(
  myPubkey: string,
  relays: string[],
  options: {
    limit?: number;
    since?: number;
    signal?: AbortSignal;
    /** Ids already stored: skipped before parse/verify. They are absent from
     * the result, so a cursor computed from it advances no further for them. */
    isKnownEvent?: (id: string) => boolean;
    /** Quorum read (see the module comment): only for the latency-critical
     * focus refresh, which must follow a partial result with a full read. */
    quorum?: boolean;
  } = {},
): Promise<FetchedInboxEvents> {
  const allRelays = [...new Set([...relays, ...enabledAppRelays('default', DEFAULT_RELAYS)])];
  trackRelays(allRelays);
  // Share the live-sub limit and retry-store capacity policy (#383).
  const limit = options.limit ?? DM_INBOX_LIMIT;
  // `since` shifted back 2 min (Damus clock-drift pad). Applied only to kind-4 filters below; wraps deliberately skip it (see next comment).
  const since =
    options.since !== undefined
      ? Math.max(0, options.since - KIND4_REPLAY_OVERLAP_SECONDS)
      : undefined;
  const sentK4Filter: Filter = { kinds: [4], authors: [myPubkey], limit };
  const recvK4Filter: Filter = { kinds: [4], '#p': [myPubkey], limit };
  // NIP-59 (gift-wrap) wraps have RANDOMIZED timestamps within ~2 days
  // of the real publish time in either direction (per spec, for
  // plausible deniability). So `wrap.created_at` does NOT track when
  // the underlying message was sent. Applying `since` to the wraps
  // filter caused recently-published wraps to be silently dropped at
  // the relay whenever their random ts < lastSeen — and lastSeen could
  // itself be a future-dated wrap's random ts (see callers using
  // Math.max over kind1059.created_at), so the inbox query would
  // progressively skip more and more wraps as the future-dated cap
  // ratcheted forward. Symptom: a contact's recent DM is visible inside
  // the per-conversation thread (which fetches peer-scoped without
  // `since`) but never appears on the Messages tab inbox list.
  // Resolution: don't filter wraps by `since` at all. The relay query
  // is bounded by limit + the `#p:[myPubkey]` filter, and the consumer
  // dedupes against the persisted wrap-id cache so already-decrypted
  // wraps short-circuit cheaply. Sharing one REQ keeps the filters
  // separate, so the wrap filter never inherits the kind-4 `since`.
  const wrapsFilter: Filter = { kinds: [1059], '#p': [myPubkey], limit };
  if (since !== undefined) {
    sentK4Filter.since = since;
    recvK4Filter.since = since;
  }
  const __t0 = performance.now();
  // A full read is complete by definition (pre-#1759 semantics).
  const read = { complete: !options.quorum };
  try {
    // 8 s (was 15 s): a quorum read's backstop, a full read's per-relay
    // timeout. Either way every REQ is closed, so the cold-start fetch
    // genuinely terminates.
    const events = await pool.querySyncFilters(
      allRelays,
      [sentK4Filter, recvK4Filter, wrapsFilter],
      8000,
      {
        abort: options.signal,
        alreadyHaveEvent: options.isKnownEvent,
        ...(options.quorum && {
          quorum: DM_FETCH_QUORUM,
          onQuorumSettled: settledInto('inbox', read),
        }),
      },
    );
    const k4 = new Map<string, RawDmEvent>();
    const k1059 = new Map<string, RawGiftWrapEvent>();
    let sentK4 = 0;
    for (const ev of events) {
      if (ev.kind === 4 && !k4.has(ev.id)) {
        k4.set(ev.id, ev as RawDmEvent);
        if (ev.pubkey === myPubkey) sentK4++;
      } else if (ev.kind === 1059) k1059.set(ev.id, ev as RawGiftWrapEvent);
    }
    // [Perf] Cold-start freeze attribution (#751). The SDK ingests every
    // returned event (JSON.parse + verify + matchFilters) before resolving —
    // logs the wrap count + wall-clock so we can tell whether the dominant
    // cost is fetch volume (reduce limit/fan-out) or per-event ingest
    // (yield). Prints here, inside the fetch, so it survives the caller's
    // post-fetch abort short-circuit, which suppresses the
    // [Perf] refreshDmInbox count line.
    console.log(
      `[Perf] fetchInboxDmEvents: ${(performance.now() - __t0).toFixed(0)}ms ` +
        `wraps=${k1059.size} sentK4=${sentK4} recvK4=${k4.size - sentK4} ` +
        `relays=${allRelays.length} limit=${limit}`,
    );
    return {
      kind4: Array.from(k4.values()),
      kind1059: Array.from(k1059.values()),
      complete: read.complete,
    };
  } catch (error) {
    if (__DEV__) console.warn('[Nostr] fetchInboxDmEvents failed:', error);
    return { kind4: [], kind1059: [], complete: false };
  }
}
