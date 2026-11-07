// Relay reads for one author's public feed on their profile page: kind-1
// notes, NIP-22 comments (kind 1111 — some clients reply to notes with them,
// #1337) and NIP-68 / NIP-71 picture and video events. The live
// subscription fetches the newest page; older pages come from a bounded,
// abortable `until` query. Every filter carries a `limit`.
import type { Event, Filter } from 'nostr-tools';
import { pool, trackRelays } from './nostrPool';
import { querySyncAbortable } from './relayQuery';
import { PROFILE_FEED_KINDS } from '../utils/noteMedia';
import { COMMENT_KIND } from '../utils/nip22';

export type AuthorFeedEvent = Pick<
  Event,
  'id' | 'pubkey' | 'kind' | 'created_at' | 'content' | 'tags'
>;

export const AUTHOR_FEED_PAGE_SIZE = 30;
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
export function subscribeAuthorFeed(input: {
  authorPubkey: string;
  relays: string[];
  limit?: number;
  onEvent: (event: AuthorFeedEvent) => void;
  onEose?: () => void;
  /** Every relay closed the subscription (failed / unreachable) before any
   *  event arrived: "couldn't ask", which is not the same as "no posts". */
  onUnavailable?: () => void;
}): () => void {
  trackRelays(input.relays);
  let eoseFired = false;
  let gotEvent = false;
  const sub = pool.subscribeMany(
    input.relays,
    feedFilter(input.authorPubkey, input.limit ?? AUTHOR_FEED_PAGE_SIZE),
    {
      onevent: (ev: Event) => {
        if (ev.pubkey !== input.authorPubkey || !AUTHOR_FEED_KINDS.includes(ev.kind)) return;
        gotEvent = true;
        input.onEvent(toFeedEvent(ev));
      },
      oneose: () => {
        if (eoseFired) return;
        eoseFired = true;
        input.onEose?.();
      },
      // A live subscription only closes when every relay has closed it: a
      // relay that answered stays open. Closing early with nothing received
      // means no relay was reachable. A close we asked for isn't reported.
      onclose: () => {
        if (!closedByUs && !gotEvent) input.onUnavailable?.();
      },
    },
  );
  let closedByUs = false;
  return () => {
    closedByUs = true;
    try {
      sub.close();
    } catch {
      // best-effort — the sub may already be closed
    }
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
