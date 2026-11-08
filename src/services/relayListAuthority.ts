import type { Event, Filter } from 'nostr-tools';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { isRelayUrl } from '../utils/relayListEvents';
import { normalizeRelayUrl } from '../utils/relayListKey';
import { pool, trackRelays } from './nostrPool';
import { relayAllowsKind } from './relayKindPolicy';

/** The reason nostr-tools gives a one-shot REQ that a relay finished with EOSE. */
export const EOSE_REASON = 'closed automatically on eose';

/** Canonical relay URL (lower-case host, no default port, no trailing slash),
 * so two spellings of one relay can't count as two answers. */
const norm = (url: string) => normalizeRelayUrl(url).replace(/\/+$/, '');

/** Newest event per NIP-01 (latest created_at; ties: lowest id), by this author and kind. */
export function newestReplaceable(events: Event[], pubkey: string, kind: number): Event | null {
  let best: Event | null = null;
  for (const e of events) {
    if (e.pubkey !== pubkey || e.kind !== kind) continue;
    if (
      !best ||
      e.created_at > best.created_at ||
      (e.created_at === best.created_at && e.id < best.id)
    )
      best = e;
  }
  return best;
}

export interface PerRelayQueryResult {
  events: Event[];
  /** Relays that served their stored history to a clean EOSE before the deadline. */
  eosed: string[];
}
export type PerRelayQuery = (
  relays: string[],
  filter: Filter,
  deadlineMs: number,
) => Promise<PerRelayQueryResult>;

/**
 * One REQ per relay, so we know exactly which relays FINISHED. nostr-tools
 * synthesises an EOSE when its own timer fires, so our deadline runs first:
 * a relay that hasn't answered by then counts as "didn't answer", never as
 * "has nothing". Relay AUTH is off (`noAuth`): this runs unasked in the
 * background, so it must never open a signer prompt — a relay that wants
 * AUTH just hasn't answered cleanly.
 */
export const queryEachRelay: PerRelayQuery = async (relays, filter, deadlineMs) => {
  trackRelays(relays);
  const events: Event[] = [];
  const eosed: string[] = [];
  await Promise.all(
    relays.map(
      (url) =>
        new Promise<void>((resolve) => {
          let done = false;
          let sub: { close(): void } | undefined;
          const finish = (completed: boolean) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (completed) eosed.push(url);
            sub?.close();
            resolve();
          };
          const timer = setTimeout(() => finish(false), deadlineMs);
          try {
            sub = pool.subscribeEose([url], filter, {
              maxWait: deadlineMs + 2_000,
              noAuth: true,
              onevent: (event) => events.push(event),
              // Only a clean EOSE counts: CLOSED (auth-required, rate-limited,
              // error), a dropped socket or a skipped relay does not.
              onclose: (reasons) =>
                finish(reasons.length > 0 && reasons.every((r) => r === EOSE_REASON)),
            });
            if (done) sub.close();
          } catch {
            finish(false);
          }
        }),
    ),
  );
  return { events, eosed };
};

export type OwnListLookup =
  | { status: 'found'; event: Event }
  /** Every relay that could hold the list answered cleanly, with nothing. */
  | { status: 'absent' }
  /** A relay that matters didn't answer cleanly: never treat this as "no list". */
  | { status: 'unknown' };

export interface OwnListSources {
  /** The user's NIP-65 write relays, where other clients publish their lists. All must answer. */
  required: string[];
  /** Relay-list indexers: all must answer, and at least one must store the kind. */
  indexers: string[];
  /** Also asked (e.g. app defaults), best-effort: a list found there still counts. */
  bestEffort: string[];
}

/**
 * Look up the user's own replaceable list (e.g. kind 10050) and say whether
 * its ABSENCE is authoritative: publishing over a list another app put
 * somewhere would silently replace it. Absent means zero events from every
 * relay asked AND a clean EOSE from every relevant relay — all the user's
 * write relays and all the indexers (at least one indexer, and at least two
 * relays in all). A timeout, CLOSED (auth-required, rate-limit, error) or a
 * skipped relay among them makes it unknown. Relays that don't store the
 * kind are left out: they can't hold it, so they can't vouch for its absence.
 *
 * Test accounts in relay lockdown only ever publish to the LAN test relay,
 * so there that relay alone is asked and authoritative.
 */
export async function lookupOwnList(
  pubkey: string,
  kind: number,
  sources: OwnListSources,
  opts: { deadlineMs?: number; query?: PerRelayQuery } = {},
): Promise<OwnListLookup> {
  const query = opts.query ?? queryEachRelay;
  const deadlineMs = opts.deadlineMs ?? 6_000;
  const filter = { kinds: [kind], authors: [pubkey], limit: 1 } as Filter;
  const storing = async (urls: string[]) => {
    // Validate the URL as given: canonicalising would turn https:// into wss://.
    const candidates = [...new Set(urls.filter(isRelayUrl).map(norm))];
    const allowed = await Promise.all(candidates.map((url) => relayAllowsKind(url, kind)));
    return candidates.filter((_, i) => allowed[i]);
  };
  const locked = isTestRelayLockdown(pubkey);
  let relevant: string[];
  let indexers: string[] = [];
  let lookup: string[];
  if (locked) relevant = lookup = [norm(TEST_RELAY_URL)];
  else {
    indexers = await storing(sources.indexers);
    relevant = [...new Set([...(await storing(sources.required)), ...indexers])];
    lookup = [...new Set([...relevant, ...(await storing(sources.bestEffort))])];
  }
  if (lookup.length === 0) return { status: 'unknown' };
  let result: PerRelayQueryResult;
  try {
    result = await query(lookup, filter, deadlineMs);
  } catch {
    return { status: 'unknown' };
  }
  const event = newestReplaceable(result.events, pubkey, kind);
  if (event) return { status: 'found', event };
  // Only relays we asked count.
  const asked = new Set(lookup);
  const eosed = new Set(result.eosed.map(norm).filter((url) => asked.has(url)));
  const allRelevantAnswered = relevant.every((url) => eosed.has(url));
  if (locked) return allRelevantAnswered ? { status: 'absent' } : { status: 'unknown' };
  return allRelevantAnswered && indexers.length > 0 && eosed.size >= 2
    ? { status: 'absent' }
    : { status: 'unknown' };
}
