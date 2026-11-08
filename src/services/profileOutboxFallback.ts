import type { Event } from 'nostr-tools';
import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { perfLog } from '../utils/perfLog';
import { leaseOutboxRelays, personOutboxRelays, whenOwnRelaysHydrated } from './authorOutboxRelays';
import {
  areCurrentUserOwnRelaysHydrated,
  getCurrentUserOwnRelays,
  getCurrentUserPubkey,
  onCurrentUserPubkeyChange,
} from './nostrActiveAccount';
import { pool } from './nostrPool';
import { getManyPeerRelayLists } from './peerRelayLists';
import { querySyncAbortable } from './relayQuery';
import { verifyEventCached } from './nostrVerifyCache';
import { normalizeRelayUrl } from '../utils/relayListKey';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';

// The missing-profile fallback (#1390): someone whose kind-0 the viewer's
// relays and the profile indexers don't have may still publish it on their
// own NIP-65 write relays (or a relay a hint names). Only for MISSES — a
// profile that resolves never comes here — and bounded:
//   - at most MAX_FALLBACK_PEOPLE people per call, MAX_AUTHOR_OUTBOX_RELAYS
//     relays per person, inside the app-wide outbox lease ceiling;
//   - one person per query (`authors: [X]` to X's relays only — never one
//     person's pubkey on someone else's personal relay);
//   - a short in-memory retry throttle per person (nothing persisted) for
//     background display lookups only: a verified, user-driven lookup (the
//     fetch that feeds a Lightning address) is never suppressed;
//   - every candidate is signature-checked before the newest is chosen.
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
/** Longest a fallback waits for the viewer's own relays to be known (cold
 * start) before giving up for now — no miss is recorded then. */
export const FALLBACK_HYDRATION_WAIT_MS = 10_000;
/** Most throttle entries remembered (oldest dropped first). */
const MAX_THROTTLE_ENTRIES = 512;

/** True once the viewer's own relays are known — waiting up to
 * FALLBACK_HYDRATION_WAIT_MS for them; false on timeout or abort. */
function ownRelaysKnown(signal: AbortSignal | undefined): Promise<boolean> {
  if (areCurrentUserOwnRelaysHydrated()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let cancel: () => void = () => {};
    let settled = false;
    const finish = (known: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancel();
      signal?.removeEventListener('abort', onAbort);
      resolve(known);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(false), FALLBACK_HYDRATION_WAIT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    cancel = whenOwnRelaysHydrated(() => finish(true));
  });
}

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

/** Most kind-0 candidates per person that get a full signature check — a
 * relay can ignore `limit: 1` and send many (forged) events. */
export const MAX_VERIFIED_CANDIDATES = 3;

/**
 * The newest kind-0 BY `pubkey` (relays can ignore `authors`) that passes a
 * full signature check: a forged newer copy from one relay never displaces a
 * genuine one from another, and every result can be trusted for its
 * `created_at` (newest-wins merging). Bounded and paced: a cheap pubkey/kind
 * filter first, then at most MAX_VERIFIED_CANDIDATES newest are verified,
 * with the budget-gated yield scheduler between Schnorr checks (CLAUDE.md:
 * heavy loops yield) so they never run back to back on the JS thread.
 */
async function newestProfile(
  events: readonly Event[],
  pubkey: string,
  signal: AbortSignal | undefined,
): Promise<Event | undefined> {
  const candidates = events
    .filter((ev) => ev.pubkey === pubkey && ev.kind === 0)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_VERIFIED_CANDIDATES);
  const scheduler = createYieldScheduler({ signal, safetyEvery: MAX_VERIFIED_CANDIDATES + 1 });
  try {
    for (let i = 0; i < candidates.length; i++) {
      if (i > 0) await scheduler.maybeYield();
      if (signal?.aborted) return undefined;
      if (verifyEventCached(candidates[i])) return candidates[i];
    }
    return undefined;
  } finally {
    scheduler.dispose();
  }
}

/** `skipped`: over the app-wide relay ceiling, or cancelled — not a miss, just not now. */
type LookupOutcome = Event | 'miss' | 'skipped';

/** One person's kind-0 from their own relays only. */
async function lookupOne(
  pubkey: string,
  relays: readonly string[],
  signal: AbortSignal | undefined,
  /** The viewer's own relays this person also names, not asked yet: asked on
   * the viewer's own sockets, never leased. */
  ownRelays: readonly string[] = [],
): Promise<LookupOutcome> {
  if (signal?.aborted) return 'skipped'; // before any socket opens
  const lease = leaseOutboxRelays(relays);
  const targets = [...lease.relays, ...ownRelays];
  if (targets.length === 0) return 'skipped';
  try {
    const events = await querySyncAbortable(
      pool,
      targets,
      { kinds: [0], authors: [pubkey], limit: 1 },
      { maxWait: FALLBACK_QUERY_MAX_WAIT_MS, signal },
    );
    if (signal?.aborted) return 'skipped';
    return (await newestProfile(events, pubkey, signal)) ?? (signal?.aborted ? 'skipped' : 'miss');
  } catch {
    return signal?.aborted ? 'skipped' : 'miss';
  } finally {
    lease.release();
  }
}

/**
 * Kind-0 events for people still missing after the normal fetch, from each
 * person's own write relays and hints. Never rejects. Every event passed a
 * full signature check (its `created_at` can be trusted); display callers
 * still slim them, as for every batch profile.
 */
export async function fetchMissingProfileEvents(
  pubkeys: readonly string[],
  options: ProfileFallbackOptions,
): Promise<Map<string, Event>> {
  const found = new Map<string, Event>();
  const { signal } = options;
  const viewer = options.viewerPubkey === undefined ? getCurrentUserPubkey() : options.viewerPubkey;
  if (isTestRelayLockdown(viewer) || signal?.aborted) return found;
  // Not before the viewer's own relays are known (one of them could be
  // leased): a cold-start call waits for them, bounded and abortable.
  if (!(await ownRelaysKnown(signal)) || signal?.aborted) return found;
  const now = Date.now();
  // Only background display lookups are throttled. A verified lookup is one
  // person, on a miss, user-driven (opening a contact): it always asks, so a
  // relay back up — or a new hint — is tried at once.
  const throttles = options.purpose === 'display';
  const noteMiss = (pk: string, at: number) => {
    if (throttles) recordMiss(throttleKey(options.purpose, viewer, pk), at);
  };
  const people: string[] = [];
  for (const raw of pubkeys) {
    if (people.length >= MAX_FALLBACK_PEOPLE) break;
    const pk = raw.trim().toLowerCase();
    if (!HEX_PUBKEY.test(pk) || people.includes(pk)) continue;
    if (throttles && throttled(throttleKey(options.purpose, viewer, pk), now)) continue;
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
  const plans: { pubkey: string; relays: string[]; own: string[] }[] = [];
  // The viewer's own relays (read + DM inbox) are never leased as someone
  // else's outbox relay, whoever calls. One the caller didn't ask (e.g. the
  // contact screen passes read relays only) is still asked — on the viewer's
  // own socket, which is fine for privacy: it's the viewer's relay.
  const own = getCurrentUserOwnRelays();
  const asked = [...options.alreadyAsked, ...own];
  const ownSet = new Set(own.map(normalizeRelayUrl));
  for (const pubkey of people) {
    const result = lists.get(pubkey);
    const write = result?.status === 'ok' ? (result.lists.write ?? []) : [];
    const hints = options.hints?.get(pubkey) ?? [];
    // Capped after dropping the relays already asked (personOutboxRelays).
    const relays = personOutboxRelays(write, hints, asked);
    // Filtered to the viewer's own relays BEFORE the cap (inside), so an
    // unasked own relay is never crowded out by the person's other relays.
    const ownUnasked = personOutboxRelays(write, hints, options.alreadyAsked, (url) =>
      ownSet.has(url),
    );
    // Nothing new to ask (no list, or only relays already asked): a miss —
    // unless the lookup itself failed, which a later call may get past.
    if (relays.length === 0 && ownUnasked.length === 0) {
      if (result?.status === 'ok') noteMiss(pubkey, now);
      continue;
    }
    plans.push({ pubkey, relays, own: ownUnasked });
  }
  for (let i = 0; i < plans.length; i += FALLBACK_CONCURRENCY) {
    if (signal?.aborted) break;
    const round = plans.slice(i, i + FALLBACK_CONCURRENCY);
    const outcomes = await Promise.all(
      round.map((p) => lookupOne(p.pubkey, p.relays, signal, p.own)),
    );
    round.forEach(({ pubkey }, j) => {
      const outcome = outcomes[j];
      if (outcome === 'miss') noteMiss(pubkey, Date.now());
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
