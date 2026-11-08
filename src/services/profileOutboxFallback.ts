import type { Event } from 'nostr-tools';
import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { perfLog } from '../utils/perfLog';
import { leaseOutboxRelays, personOutboxRelays } from './authorOutboxRelays';
import {
  getCurrentUserOwnRelays,
  getCurrentUserPubkey,
  onCurrentUserPubkeyChange,
} from './nostrActiveAccount';
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
/** A background fallback starts this long after it's scheduled (CLAUDE.md:
 * non-urgent work is staggered, cancellable). */
export const FALLBACK_START_DELAY_MS = 3_000;
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
  /** Stops the work: no new lookup, round or socket after it aborts, and open queries close. */
  signal?: AbortSignal;
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

/** `skipped`: over the app-wide relay ceiling, or cancelled — not a miss, just not now. */
type LookupOutcome = Event | 'miss' | 'skipped';

/** One person's kind-0 from their own relays only. */
async function lookupOne(
  pubkey: string,
  relays: readonly string[],
  signal: AbortSignal | undefined,
): Promise<LookupOutcome> {
  if (signal?.aborted) return 'skipped'; // before any socket opens
  const lease = leaseOutboxRelays(relays);
  if (lease.relays.length === 0) return 'skipped';
  try {
    const events = await querySyncAbortable(
      pool,
      lease.relays,
      { kinds: [0], authors: [pubkey], limit: 1 },
      { maxWait: FALLBACK_QUERY_MAX_WAIT_MS, signal },
    );
    if (signal?.aborted) return 'skipped';
    return newestProfile(events, pubkey) ?? 'miss';
  } catch {
    return signal?.aborted ? 'skipped' : 'miss';
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
  const { signal } = options;
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  if (isTestRelayLockdown(viewer) || signal?.aborted) return found;
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
    signal,
  });
  if (signal?.aborted) return found;
  const plans: { pubkey: string; relays: string[] }[] = [];
  // The viewer's own relays (read + DM inbox) count as asked whoever calls:
  // they're never leased as someone else's outbox relay.
  const asked = [...options.alreadyAsked, ...getCurrentUserOwnRelays()];
  for (const pubkey of people) {
    const result = lists.get(pubkey);
    const write = result?.status === 'ok' ? (result.lists.write ?? []) : [];
    // Capped after dropping the relays already asked (personOutboxRelays).
    const relays = personOutboxRelays(write, options.hints?.get(pubkey) ?? [], asked);
    // Nothing new to ask (no list, or only relays already asked): a miss —
    // unless the lookup itself failed, which a later call may get past.
    if (relays.length === 0) {
      if (result?.status === 'ok') recordMiss(throttleKey(options.purpose, viewer, pubkey), now);
      continue;
    }
    plans.push({ pubkey, relays });
  }
  for (let i = 0; i < plans.length; i += FALLBACK_CONCURRENCY) {
    if (signal?.aborted) break;
    const round = plans.slice(i, i + FALLBACK_CONCURRENCY);
    const outcomes = await Promise.all(round.map((p) => lookupOne(p.pubkey, p.relays, signal)));
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

/**
 * `fetchMissingProfileEvents` in the background, for a batch caller that
 * mustn't wait on it (cold-start contact profiles): starts after
 * FALLBACK_START_DELAY_MS, and `onFound` runs only when something was found.
 * Stopped — timer, lookups, open queries and the result — by the returned
 * function, by `options.signal`, or by an account switch away from
 * `options.viewerPubkey` (pass the owner captured when the caller's work
 * STARTED: if the account already changed, nothing runs at all).
 */
export function scheduleMissingProfileFallback(
  pubkeys: readonly string[],
  options: ProfileFallbackOptions,
  onFound: (found: Map<string, Event>) => void,
): () => void {
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (options.signal?.aborted || getCurrentUserPubkey() !== viewer) {
    cancel();
    return cancel;
  }
  const stopWatching = onCurrentUserPubkeyChange((pubkey) => {
    if (pubkey !== viewer) cancel();
  });
  options.signal?.addEventListener('abort', cancel, { once: true });
  const cleanUp = () => {
    stopWatching();
    options.signal?.removeEventListener('abort', cancel);
  };
  const timer = setTimeout(() => {
    void fetchMissingProfileEvents(pubkeys, {
      ...options,
      viewerPubkey: viewer,
      signal: controller.signal,
    })
      .then((found) => {
        if (!controller.signal.aborted && found.size > 0) onFound(found);
      })
      .catch(() => {
        // Best-effort: the profiles just stay missing until the next retry.
      })
      .finally(cleanUp);
  }, FALLBACK_START_DELAY_MS);
  controller.signal.addEventListener(
    'abort',
    () => {
      clearTimeout(timer);
      cleanUp();
    },
    { once: true },
  );
  return cancel;
}

const latestGeneration = new Map<string, AbortController>();

/**
 * A cancellation token for one batch refresh's background fallback, taken
 * when the refresh STARTS. The next refresh for the same owner aborts it, so
 * a fallback from an older refresh can never apply over a newer one.
 */
export function newFallbackGeneration(owner: string | null): AbortSignal {
  const key = owner ?? '';
  latestGeneration.get(key)?.abort();
  const controller = new AbortController();
  latestGeneration.set(key, controller);
  return controller.signal;
}

/** Forget the retry throttle (tests). */
export function __resetProfileFallbackForTests(): void {
  recentMisses.clear();
  latestGeneration.clear();
}
