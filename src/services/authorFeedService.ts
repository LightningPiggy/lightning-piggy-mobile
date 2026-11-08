// Relay reads for one author's public feed on their profile page: kind-1
// notes, NIP-22 comments (kind 1111 — some clients reply to notes with them,
// #1337) and NIP-68 / NIP-71 picture and video events. The live
// subscription fetches the newest page; older pages come from a bounded,
// abortable `until` query. Every filter carries a `limit`.
import type { Event, Filter } from 'nostr-tools';
import { AUTHOR_FEED_PAGE_SIZE, OUTBOX_FEED_EVENT_BUDGET_FACTOR } from './authorFeedLimits';
import {
  authorWriteRelays,
  leaseOutboxRelays,
  quarantineOutboxRelay,
  whenOwnRelaysHydrated,
  withoutRelays,
} from './authorOutboxRelays';
import { pool, trackRelays } from './nostrPool';
import { recordRelayFailure, relayKey, selectHealthyRelays } from './relayHealth';
import { querySyncAbortable } from './relayQuery';
import { PROFILE_FEED_KINDS } from '../utils/noteMedia';
import { COMMENT_KIND } from '../utils/nip22';

export type AuthorFeedEvent = Pick<
  Event,
  'id' | 'pubkey' | 'kind' | 'created_at' | 'content' | 'tags'
>;

// The feed's bounds live in ./authorFeedLimits (shared with the outbox budgets).
export { AUTHOR_FEED_PAGE_SIZE, OUTBOX_FEED_EVENT_BUDGET_FACTOR };
const PAGE_TIMEOUT_MS = 6000;

const toFeedEvent = (ev: Event): AuthorFeedEvent => ({
  id: ev.id,
  pubkey: ev.pubkey,
  kind: ev.kind,
  created_at: ev.created_at,
  content: ev.content,
  tags: ev.tags,
});

/** Whether the shared pool reports every relay as connected. */
function allConnected(relays: readonly string[]): boolean {
  const status = pool.listConnectionStatus();
  const norm = (u: string) => u.replace(/\/+$/, '').toLowerCase();
  const connected = new Set([...status.entries()].filter(([, ok]) => ok).map(([url]) => norm(url)));
  return relays.every((r) => connected.has(norm(r)));
}

/**
 * One filter for every kind, so a page's `until` cursor covers them all
 * alike. Comments that aren't note replies (product / Piglet comments) come
 * back too; the hook keeps them for paging and hides them from the feed.
 */
export const AUTHOR_FEED_KINDS = [...PROFILE_FEED_KINDS, COMMENT_KIND];

const feedFilter = (authorPubkey: string, limit: number, until?: number): Filter => ({
  kinds: AUTHOR_FEED_KINDS,
  authors: [authorPubkey],
  limit,
  ...(until !== undefined ? { until } : {}),
});

/**
 * Live subscription for the newest `limit` feed events. `onEose` fires once,
 * after every relay has sent its stored events; the sub stays open for new
 * posts until the returned closer runs. The shared pool verifies signatures
 * for these kinds, and the author is re-checked here (relays can ignore
 * `authors`).
 */
/**
 * How long a relay may stay silent before the SDK fakes EOSE for it. The feed
 * is a live subscription, so this only stops a silent relay ever counting as
 * an answer ("No posts yet"): effectively, only a relay's real EOSE does.
 */
export const AUTHOR_FEED_EOSE_WAIT_MS = 10 * 60_000;

export function subscribeAuthorFeed(input: {
  authorPubkey: string;
  relays: string[];
  limit?: number;
  /** `relay`: the relay it came from. */
  onEvent: (event: AuthorFeedEvent, relay: string) => void;
  /** Every relay has sent its stored events (or failed). */
  onEose?: () => void;
  /** The first relay really answered (a real EOSE, not a failure), even if
   *  others are still silent: "no posts" is now a real answer. */
  onAnswered?: () => void;
  /** Every relay closed the subscription (failed / unreachable) before any
   *  event arrived: "couldn't ask", which is not the same as "no posts". */
  onUnavailable?: () => void;
  /** Hardening for relays the viewer didn't choose: a relay that sends more
   *  events than this has its subscription closed and is reported through
   *  `onFlood`. Counted in `alreadyHaveEvent`, which nostr-tools calls BEFORE
   *  parsing and verifying, so off-filter events (other authors, which the
   *  SDK drops before `onevent`) count too, and the excess is skipped unverified. */
  maxEventsPerRelay?: number;
  onFlood?: (relay: string) => void;
}): () => void {
  trackRelays(input.relays);
  // One per relay (deduped on the normalised URL, original spelling kept),
  // and never a relay parked as dead (#1326): the pool's own health filter
  // always keeps a single-relay request, so apply it to the whole set here.
  const byKey = new Map<string, string>();
  for (const url of input.relays) {
    const key = relayKey(url); // the breaker's own key; never throws
    if (!byKey.has(key)) byKey.set(key, url);
  }
  const relays = selectHealthyRelays([...byKey.values()]);
  let gotEvent = false;
  let answered = false;
  let eoseCount = 0;
  let closedCount = 0;
  let closedByUs = false;
  const filter = feedFilter(input.authorPubkey, input.limit ?? AUTHOR_FEED_PAGE_SIZE);
  // Monotonic, like the SDK's own timer: a wall-clock change can't skew it.
  const startedAt = performance.now();
  // One subscription per relay (still one REQ per relay on the wire), so a
  // relay that really answered can be told apart while another stays silent:
  // the pool only reports EOSE once EVERY relay has sent one.
  // Closed (by us or by the relay): nostr-tools' closers aren't idempotent —
  // a second close drives the relay's operation count negative.
  const done: boolean[] = relays.map(() => false);
  const closeSub = (i: number) => {
    if (done[i]) return;
    done[i] = true;
    try {
      subs[i].close();
    } catch {
      // best-effort
    }
  };
  const budget = input.maxEventsPerRelay;
  const subs = relays.map((relay, i) => {
    let eose = false;
    let closed = false;
    let received = 0;
    let flooded = false;
    const countEvent = () => {
      if (flooded) return true;
      if (++received <= budget!) return false;
      flooded = true;
      // Out of the SDK's message handler before closing.
      void Promise.resolve().then(() => {
        closeSub(i);
        input.onFlood?.(relay);
      });
      return true; // skip it: never parsed or verified
    };
    return pool.subscribeMany([relay], filter, {
      ...(budget !== undefined ? { alreadyHaveEvent: countEvent } : {}),
      onevent: (ev: Event) => {
        if (ev.pubkey !== input.authorPubkey || !AUTHOR_FEED_KINDS.includes(ev.kind)) return;
        gotEvent = true;
        input.onEvent(toFeedEvent(ev), relay);
      },
      oneose: () => {
        if (eose) return;
        eose = true;
        // The pool reports a relay that FAILED as EOSE and closes it in the
        // same synchronous call; a relay that really answered and later
        // dropped closes in a later tick. Only the latter is an answer. And
        // once maxWait has run out, the SDK fakes EOSE for a silent relay:
        // no answer either.
        const timedOut = performance.now() - startedAt >= AUTHOR_FEED_EOSE_WAIT_MS;
        queueMicrotask(() => {
          if (timedOut || closed || closedByUs || answered) return;
          answered = true;
          input.onAnswered?.();
        });
        if (++eoseCount === relays.length) input.onEose?.();
      },
      // A live subscription only closes when the relay closes it: one that
      // answered stays open. Every relay closing early with nothing received
      // means none was reachable. A close we asked for isn't reported.
      onclose: () => {
        done[i] = true;
        if (closed) return;
        closed = true;
        if (++closedCount < relays.length) return;
        if (!closedByUs && !gotEvent && !answered) input.onUnavailable?.();
      },
      // Only a relay's real EOSE counts as an answer: without this the SDK
      // fakes one after 4.4 s for a connected relay that never replies.
      maxWait: AUTHOR_FEED_EOSE_WAIT_MS,
    });
  });
  return () => {
    closedByUs = true;
    subs.forEach((_, i) => closeSub(i));
  };
}

export interface AuthorFeedPage {
  /** Events at or before `until`, newest first. */
  events: AuthorFeedEvent[];
  /**
   * True when every relay answered (EOSE) before the timeout. An empty page
   * only means "no older posts" when it's complete — a timeout can't tell.
   */
  complete: boolean;
}

/**
 * One older page, bounded by `limit` and a timeout. Rejects when every relay
 * failed to connect, so the caller can keep "Load more" retryable.
 */
export async function fetchAuthorFeedPage(input: {
  authorPubkey: string;
  relays: string[];
  until: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<AuthorFeedPage> {
  if (input.relays.length === 0) return { events: [], complete: false };
  trackRelays(input.relays);
  const startedAt = Date.now();
  const events = await querySyncAbortable(
    pool,
    input.relays,
    feedFilter(input.authorPubkey, input.limit ?? AUTHOR_FEED_PAGE_SIZE, input.until),
    { maxWait: PAGE_TIMEOUT_MS, signal: input.signal, rejectOnAllRelaysFailure: true },
  );
  return {
    events: events
      .filter((ev) => ev.pubkey === input.authorPubkey && AUTHOR_FEED_KINDS.includes(ev.kind))
      .map(toFeedEvent)
      .sort((a, b) => b.created_at - a.created_at),
    // Resolved before the timeout (aggregate EOSE) AND every relay is still
    // connected — the pool counts a failed connection towards EOSE, so a fast
    // failure on the one relay holding older posts must not read as "end".
    complete:
      !input.signal?.aborted &&
      Date.now() - startedAt < PAGE_TIMEOUT_MS - 50 &&
      allConnected(input.relays),
  };
}

/**
 * The same live feed on the AUTHOR's own write relays (#1390), for people who
 * publish where the viewer doesn't read. Never delays the main feed: the
 * caller subscribes `currentRelays` first, and this resolves the author's
 * relays (cached, or one bounded lookup) in the background, then subscribes
 * only the ones not already in `currentRelays` — at most
 * MAX_AUTHOR_OUTBOX_RELAYS, within the app-wide lease ceiling. The author's
 * pubkey goes only to the author's relays. Each relay has its own lease and
 * an event budget: one that floods is closed, released, quarantined and
 * reported unhealthy. `onRelays` reports the relays subscribed (again when
 * one is dropped), so older pages read them too. The returned closer ends
 * the subscriptions and releases the leases (and any socket they opened).
 */
export function subscribeAuthorOutboxFeed(input: {
  authorPubkey: string;
  currentRelays: string[];
  /** The viewer's other relays (e.g. their DM inbox relays): never leased either. */
  excludeRelays?: readonly string[];
  viewerPubkey?: string | null;
  limit?: number;
  /** `relay`: which of the author's relays it came from (each pages on its own). */
  onEvent: (event: AuthorFeedEvent, relay: string) => void;
  onAnswered?: () => void;
  onRelays?: (relays: string[]) => void;
}): () => void {
  let closed = false;
  const open = new Map<string, () => void>();
  const limit = input.limit ?? AUTHOR_FEED_PAGE_SIZE;
  // Closing early also cancels an uncached relay-list lookup.
  const lookup = new AbortController();
  void authorWriteRelays(input.authorPubkey, {
    viewerPubkey: input.viewerPubkey,
    lookupRelays: input.currentRelays,
    signal: lookup.signal,
  }).then((write) => {
    if (closed) return;
    // Nothing is leased before the viewer's own relays are known: a profile
    // opened at cold start subscribes its author relays once they are (the
    // viewer-relay sub is untouched meanwhile).
    stopWaiting = whenOwnRelaysHydrated(() => {
      if (!closed) armAuthorRelays(write);
    });
  });
  let stopWaiting: (() => void) | undefined;
  const armAuthorRelays = (write: readonly string[]) => {
    for (const url of withoutRelays(write, [
      ...input.currentRelays,
      ...(input.excludeRelays ?? []),
    ])) {
      // Drop this relay: its sub, its lease, and from the relays older pages ask.
      const drop = () => {
        open.get(url)?.();
        open.delete(url);
        if (!closed) input.onRelays?.([...open.keys()]);
      };
      // Revoked when its socket blows the frame budget (authorOutboxRelays).
      const lease = leaseOutboxRelays([url], drop);
      if (lease.relays.length === 0) {
        lease.release();
        continue;
      }
      const unsubscribe = subscribeAuthorFeed({
        authorPubkey: input.authorPubkey,
        relays: lease.relays,
        limit,
        onEvent: (event) => input.onEvent(event, url),
        onAnswered: input.onAnswered,
        // Fast path: counted per subscription before parse / verify.
        maxEventsPerRelay: OUTBOX_FEED_EVENT_BUDGET_FACTOR * limit,
        onFlood: () => {
          quarantineOutboxRelay(url);
          recordRelayFailure(url);
          drop();
        },
      });
      open.set(url, () => {
        unsubscribe();
        lease.release();
      });
    }
    if (open.size > 0) input.onRelays?.([...open.keys()]);
  };
  return () => {
    closed = true;
    lookup.abort();
    stopWaiting?.();
    for (const close of open.values()) close();
    open.clear();
  };
}
