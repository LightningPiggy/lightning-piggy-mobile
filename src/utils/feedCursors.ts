// Paging cursors for a profile feed read from two relay sets (#1390): the
// viewer's read relays and the author's own write relays. Each set pages
// from ITS OWN oldest event and ends on its own. One shared cursor would skip
// posts: if the viewer's relays only have a post from t=100 while the
// author's relays returned t=971–1000, paging both from `until: 100` would
// never ask the author's relays for 101–970.

export type FeedSource = 'viewer' | 'outbox';

export interface SourceCursor {
  /** Oldest `created_at` seen from this source (live or paged); null before any. */
  oldest: number | null;
  /** A complete page from this source had nothing older: it's at its end. */
  ended: boolean;
}

export type FeedCursors = Record<FeedSource, SourceCursor>;

const SOURCES: readonly FeedSource[] = ['viewer', 'outbox'];

export const newFeedCursors = (): FeedCursors => ({
  viewer: { oldest: null, ended: false },
  outbox: { oldest: null, ended: false },
});

/** Note an event from `source`. True when it gave that source its first cursor
 * (so paging it just became possible). */
export function noteFeedEvent(
  cursors: FeedCursors,
  source: FeedSource,
  createdAt: number,
): boolean {
  const cursor = cursors[source];
  const opened = cursor.oldest === null;
  if (cursor.oldest === null || createdAt < cursor.oldest) cursor.oldest = createdAt;
  return opened;
}

/** Re-open every source (pull-to-refresh): their ends may have been outages. */
export function reopenFeedCursors(cursors: FeedCursors): void {
  for (const source of SOURCES) cursors[source].ended = false;
}

/** Sources that can page now: relays known, a cursor, not at their end. */
export function pageableSources(
  cursors: FeedCursors,
  hasRelays: (source: FeedSource) => boolean,
): FeedSource[] {
  return SOURCES.filter((s) => hasRelays(s) && cursors[s].oldest !== null && !cursors[s].ended);
}

/** Whether any source has a cursor (anything was loaded at all). */
export const hasAnyCursor = (cursors: FeedCursors): boolean =>
  SOURCES.some((s) => cursors[s].oldest !== null);

/** A full page entirely at the cursor's second (`until` is inclusive): step past it. */
export function isStuckPage(
  events: readonly { created_at: number }[],
  until: number,
  pageSize: number,
): boolean {
  return events.length >= pageSize && events.every((e) => e.created_at >= until);
}

/**
 * Fold a page that `source` returned when paged from `pagedFrom` (its cursor
 * then): moves the cursor; a complete page with nothing older than that ends
 * the source. An incomplete page (timeout, failed relay) never ends it.
 */
export function applyFeedPage(
  cursor: SourceCursor,
  pagedFrom: number,
  page: { events: readonly { created_at: number }[]; complete: boolean },
): void {
  let older = false;
  for (const { created_at } of page.events) {
    if (created_at < pagedFrom) older = true;
    if (cursor.oldest === null || created_at < cursor.oldest) cursor.oldest = created_at;
  }
  if (page.complete && !older) cursor.ended = true;
}
