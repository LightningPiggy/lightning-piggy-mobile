import type { Event } from 'nostr-tools';
import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { perfLog } from '../utils/perfLog';
import {
  leaseOutboxRelays,
  MAX_AUTHOR_OUTBOX_RELAYS,
  personOutboxRelays,
} from './authorOutboxRelays';
import { getCurrentUserPubkey } from './nostrActiveAccount';
import { pool } from './nostrPool';
import { getManyPeerRelayLists } from './peerRelayLists';
import { querySyncAbortable } from './relayQuery';

// The missing-profile fallback (#1390): someone whose kind-0 the viewer's
// relays and the profile indexers don't have may still publish it on their
// own NIP-65 write relays (or a relay a hint names). Only for MISSES — a
// profile that resolves never comes here — and bounded:
//   - at most MAX_FALLBACK_PEOPLE people per call, MAX_AUTHOR_OUTBOX_RELAYS
//     relays per person, inside the app-wide outbox lease ceiling;
//   - one person per query (`authors: [X]` to X's relays only — never one
//     person's pubkey on someone else's personal relay);
//   - a short in-memory retry throttle per person (nothing persisted), kept
//     separately for display-only and verified callers, so a display-only
//     miss never suppresses the verified fetch that feeds a Lightning address.
// Relay-list lookups go to the indexers / the viewer's relays (./peerRelayLists).
// Test accounts in lockdown skip it: they only ever read the LAN test relay.

/** Most people one call looks up on their own relays. */
export const MAX_FALLBACK_PEOPLE = 10;
/** People queried at once (5 × 3 relays stays under the 25-relay lease ceiling),
 * so a full call is two rounds: ≲ one lookup + 2 × FALLBACK_QUERY_MAX_WAIT_MS. */
const FALLBACK_CONCURRENCY = 5;
/** Relay wait for one person's kind-0. */
export const FALLBACK_QUERY_MAX_WAIT_MS = 5_000;
/** A person whose fallback found nothing isn't retried for this long. */
export const FALLBACK_RETRY_THROTTLE_MS = 5 * 60_000;
/** Most throttle entries remembered (oldest dropped first). */
const MAX_THROTTLE_ENTRIES = 512;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export type FallbackPurpose = 'display' | 'verified';

export interface ProfileFallbackOptions {
  /** `verified` callers re-verify the event themselves (it may feed a payment). */
  purpose: FallbackPurpose;
  /** Relays the caller already asked; not asked again. */
  alreadyAsked: readonly string[];
  /** The viewer's read relays, for the relay-list lookup. */
  lookupRelays?: readonly string[];
  /** Untrusted relay hints per person (nprofile / kind-3), sanitised here. */
  hints?: ReadonlyMap<string, readonly unknown[]>;
  /** Whose lookup this is; defaults to the active account. */
  viewerPubkey?: string | null;
}

const recentMisses = new Map<string, number>();

const throttleKey = (purpose: FallbackPurpose, viewer: string | null | undefined, pk: string) =>
  `${purpose}:${viewer ?? ''}:${pk}`;

function throttled(key: string, now: number): boolean {
  const at = recentMisses.get(key);
  if (at === undefined) return false;
  if (now - at < FALLBACK_RETRY_THROTTLE_MS) return true;
  recentMisses.delete(key);
  return false;
}

function recordMiss(key: string, now: number): void {
  recentMisses.delete(key);
  recentMisses.set(key, now);
  while (recentMisses.size > MAX_THROTTLE_ENTRIES)
    recentMisses.delete(recentMisses.keys().next().value!);
}

/** The newest structurally plausible kind-0 BY `pubkey` (relays can ignore `authors`). */
function newestProfile(events: readonly Event[], pubkey: string): Event | undefined {
  let best: Event | undefined;
  for (const ev of events) {
    if (ev.pubkey !== pubkey || ev.kind !== 0) continue;
    if (!best || ev.created_at > best.created_at) best = ev;
  }
  return best;
}

/** `skipped`: over the app-wide relay ceiling — not a miss, just not now. */
type LookupOutcome = Event | 'miss' | 'skipped';

/** One person's kind-0 from their own relays only. */
async function lookupOne(pubkey: string, relays: readonly string[]): Promise<LookupOutcome> {
  const lease = leaseOutboxRelays(relays);
  if (lease.relays.length === 0) return 'skipped';
  try {
    const events = await querySyncAbortable(
      pool,
      lease.relays,
      { kinds: [0], authors: [pubkey], limit: 1 },
      { maxWait: FALLBACK_QUERY_MAX_WAIT_MS },
    );
    return newestProfile(events, pubkey) ?? 'miss';
  } catch {
    return 'miss';
  } finally {
    lease.release();
  }
}

/**
 * Kind-0 events for people still missing after the normal fetch, from each
 * person's own write relays and hints. Never rejects. The events are NOT
 * signature-verified (the pool fast-paths kind 0): display callers slim them,
 * verified callers verify them.
 */
export async function fetchMissingProfileEvents(
  pubkeys: readonly string[],
  options: ProfileFallbackOptions,
): Promise<Map<string, Event>> {
  const found = new Map<string, Event>();
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  if (isTestRelayLockdown(viewer)) return found;
  const now = Date.now();
  const people: string[] = [];
  for (const raw of pubkeys) {
    if (people.length >= MAX_FALLBACK_PEOPLE) break;
    const pk = raw.trim().toLowerCase();
    if (!HEX_PUBKEY.test(pk) || people.includes(pk)) continue;
    if (throttled(throttleKey(options.purpose, viewer, pk), now)) continue;
    people.push(pk);
  }
  if (people.length === 0) return found;
  const started = Date.now();
  const lists = await getManyPeerRelayLists(people, {
    viewerPubkey: viewer,
    lookupRelays: options.lookupRelays,
  });
  const plans: { pubkey: string; relays: string[] }[] = [];
  for (const pubkey of people) {
    const result = lists.get(pubkey);
    const write = result?.status === 'ok' ? (result.lists.write ?? []) : [];
    const relays = personOutboxRelays(
      write.slice(0, MAX_AUTHOR_OUTBOX_RELAYS),
      options.hints?.get(pubkey) ?? [],
      options.alreadyAsked,
    );
    // Nothing new to ask (no list, or only relays already asked): a miss —
    // unless the lookup itself failed, which a later call may get past.
    if (relays.length === 0) {
      if (result?.status === 'ok') recordMiss(throttleKey(options.purpose, viewer, pubkey), now);
      continue;
    }
    plans.push({ pubkey, relays });
  }
  for (let i = 0; i < plans.length; i += FALLBACK_CONCURRENCY) {
    const round = plans.slice(i, i + FALLBACK_CONCURRENCY);
    const outcomes = await Promise.all(round.map((p) => lookupOne(p.pubkey, p.relays)));
    round.forEach(({ pubkey }, j) => {
      const outcome = outcomes[j];
      if (outcome === 'miss') recordMiss(throttleKey(options.purpose, viewer, pubkey), Date.now());
      else if (outcome !== 'skipped') found.set(pubkey, outcome);
    });
  }
  perfLog(
    `profileOutboxFallback n=${people.length} asked=${plans.length} found=${found.size} ` +
      `${Date.now() - started}ms`,
  );
  return found;
}

/** Forget the retry throttle (tests). */
export function __resetProfileFallbackForTests(): void {
  recentMisses.clear();
}
