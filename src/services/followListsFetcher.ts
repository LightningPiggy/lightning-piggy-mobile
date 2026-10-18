// Relay side of the friends-of-friends computation: fetch each friend's
// newest kind-3 follow list. This is the `fetchKind3` that
// `friendsOfFriendsService.computeFofSet` injects (the heuristics, caps and
// cache all live there) — keep it a plain "pubkey → follows" lookup.
//
// Perf (#1274 pattern): kind-3 events are large (hundreds of `p` tags) and a
// schnorr check costs ~25 ms on a phone, so the shared pool's eager per-event
// verification is avoided. Events arrive through the structure-only market
// pool, bounded candidates are retained, and revisions are verified newest
// first in a budget-gated, yielded loop until each friend has a valid winner.
// Forged newer revisions cannot displace an older authenticated follow list.
import type { Event } from 'nostr-tools';
import { acquireMarketListingsPool } from './marketListingsPool';
import { collectRelaySnapshot } from './relaySnapshot';
import { selectHealthyRelays } from './relayHealth';
import { verifyEventCached } from './nostrVerifyCache';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';

/** Contact-list indexers queried alongside the user's read relays. */
export const FOLLOW_LIST_RELAYS = [
  'wss://purplepag.es',
  'wss://user.kindpag.es',
  'wss://relay.primal.net',
];
/** Relays per batch (indexers first, then the user's read relays). */
export const MAX_FOLLOW_LIST_RELAYS = 6;
/** One batch's ceiling, and the time other relays get after the first answers. */
const BATCH_TIMEOUT_MS = 8000;
const GRACE_MS = 1500;
/** A contact list beyond this many tags is not a person's follow list. */
const MAX_TAGS = 5000;
/** UTF-16 ceilings also bound serialized UTF-8/escaped payloads by a constant. */
export const MAX_FOLLOW_CONTENT_CHARS = 32768;
export const MAX_FOLLOW_TAG_CHARS = 512000;

function boundedPayload(event: Event): boolean {
  if (event.content.length > MAX_FOLLOW_CONTENT_CHARS || event.tags.length > MAX_TAGS) return false;
  // Include per-string overhead: empty strings must not bypass the budget.
  let chars = 0;
  for (const tag of event.tags) {
    chars += 2;
    for (const value of tag) {
      chars += value.length + 3;
      if (chars > MAX_FOLLOW_TAG_CHARS) return false;
    }
  }
  return chars <= MAX_FOLLOW_TAG_CHARS;
}

const HEX64 = /^[0-9a-f]{64}$/;
const abortError = () =>
  Object.assign(new Error('Follow-list fetch aborted'), { name: 'AbortError' });
const normaliseRelay = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();

/** Indexers first, then the user's read relays — de-duplicated and capped. */
export function followListRelays(userRelays: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of [...FOLLOW_LIST_RELAYS, ...userRelays]) {
    const url = normaliseRelay(raw);
    if (/^wss:\/\/[^/\s]+/.test(url)) seen.add(url);
  }
  return [...seen].slice(0, MAX_FOLLOW_LIST_RELAYS);
}

/** Newest first; on a timestamp tie the lowest id (replaceable-event rule). */
const newestFirst = (a: Event, b: Event) => b.created_at - a.created_at || a.id.localeCompare(b.id);

/**
 * Fetch the newest verified kind-3 for each of `pubkeys` (one bounded batch —
 * `computeFofSet` already chunks the friend list). Returns lowercase-hex
 * follows per friend; friends with no (verifiable) contact list are absent.
 */
export async function fetchFollowLists(
  pubkeys: readonly string[],
  userRelays: readonly string[],
  signal?: AbortSignal,
): Promise<Record<string, string[]>> {
  const wanted = new Set(pubkeys.map((p) => p.toLowerCase()).filter((p) => HEX64.test(p)));
  const abort = signal ?? new AbortController().signal;
  const urls = selectHealthyRelays(followListRelays(userRelays));
  if (abort.aborted) throw abortError();
  if (wanted.size === 0) return {};
  if (urls.length === 0) throw new Error('No follow-list relays available');
  // Enforce the aggregate requested limit even if a relay ignores it. Fail
  // instead of caching a graph whose valid candidates might have been lost.
  const maxCandidates = wanted.size * urls.length;
  const candidates: Event[] = [];
  let overflow = false;
  const lease = acquireMarketListingsPool(urls);
  try {
    const snapshot = await collectRelaySnapshot({
      urls,
      // Replaceable kind: one event per author, so the author count bounds it.
      filters: [{ kinds: [3], authors: [...wanted], limit: wanted.size }],
      maxConcurrentFilters: 1,
      signal: abort,
      deadline: Date.now() + BATCH_TIMEOUT_MS,
      graceMs: GRACE_MS,
      relayPool: lease.pool,
      onEvent: (event) => {
        if (event.kind !== 3 || !wanted.has(event.pubkey) || !boundedPayload(event)) return;
        if (candidates.length >= maxCandidates) {
          overflow = true;
          return;
        }
        candidates.push(event);
      },
    });
    if (abort.aborted) throw abortError();
    if (snapshot.answered.length === 0) throw new Error('No follow-list relay answered');
    if (overflow) throw new Error('Follow-list candidate budget exceeded');
  } finally {
    lease.release();
  }
  const out: Record<string, string[]> = {};
  const scheduler = createYieldScheduler({ signal: abort, safetyEvery: 8 });
  try {
    for (const event of candidates.sort(newestFirst)) {
      await scheduler.maybeYield();
      if (abort.aborted) break;
      const pubkey = event.pubkey;
      if (Object.hasOwn(out, pubkey)) continue;
      if (!verifyEventCached(event)) continue;
      const follows: string[] = [];
      for (const tag of event.tags) {
        const pk = tag[0] === 'p' ? tag[1]?.toLowerCase() : undefined;
        if (pk && HEX64.test(pk)) follows.push(pk);
      }
      out[pubkey] = follows;
    }
  } finally {
    scheduler.dispose();
  }
  // A cut-short batch must not reach computeFofSet's cache as if complete.
  if (abort.aborted) throw abortError();
  return out;
}
