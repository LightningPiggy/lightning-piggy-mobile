// Paging cursors for a profile feed read from several sources (#1390): the
// viewer's read relays (one source) and EACH of the author's own write relays
// (one source per relay). Each source pages from ITS OWN oldest event and
// ends on its own. A shared cursor would skip posts: if one source only has a
// post from t=100 while another returned t=971–1000, paging both from
// `until: 100` would never ask the second for 101–970.

/** A source: `VIEWER_SOURCE`, or `outboxSource(relay)` for one author relay. */
export type FeedSource = string;

export const VIEWER_SOURCE: FeedSource = 'viewer';
export const outboxSource = (relay: string): FeedSource => `outbox:${relay}`;

export interface SourceCursor {
  /** Oldest `created_at` seen from this source (live or paged); null before any. */
  oldest: number | null;
  /** A complete page from this source had nothing older: it's at its end. */
  ended: boolean;
}

export type FeedCursors = Map<FeedSource, SourceCursor>;

export const newFeedCursors = (): FeedCursors => new Map();

/** The cursor for `source`, created empty on first use. */
export function cursorOf(cursors: FeedCursors, source: FeedSource): SourceCursor {
  let cursor = cursors.get(source);
  if (!cursor) {
    cursor = { oldest: null, ended: false };
    cursors.set(source, cursor);
  }
  return cursor;
}

/** Note an event from `source`. True when paging that source just became
 * possible: its first cursor, or an event OLDER than an ended source's cursor
 * (a late backfill — there is more to page after all). */
export function noteFeedEvent(
  cursors: FeedCursors,
  source: FeedSource,
  createdAt: number,
): boolean {
  const cursor = cursorOf(cursors, source);
  if (cursor.oldest === null) {
    cursor.oldest = createdAt;
    return true;
  }
  if (createdAt >= cursor.oldest) return false;
  cursor.oldest = createdAt;
  if (!cursor.ended) return false;
  cursor.ended = false;
  return true;
}

/** Re-open `sources` (all when omitted): their ends may have been outages, or
 * they're relays found again. True when one of them can page now. */
export function reopenFeedCursors(cursors: FeedCursors, sources?: readonly FeedSource[]): boolean {
  let pageable = false;
  for (const source of sources ?? [...cursors.keys()]) {
    const cursor = cursorOf(cursors, source);
    cursor.ended = false;
    if (cursor.oldest !== null) pageable = true;
  }
  return pageable;
}

/** Of `candidates` (the sources with relays now), those that can page: a cursor, not at their end. */
export function pageableSources(
  cursors: FeedCursors,
  candidates: readonly FeedSource[],
): FeedSource[] {
  return candidates.filter((s) => {
    const cursor = cursors.get(s);
    return cursor !== undefined && cursor.oldest !== null && !cursor.ended;
  });
}

/** Whether any source has a cursor (anything was loaded at all). */
export const hasAnyCursor = (cursors: FeedCursors): boolean =>
  [...cursors.values()].some((c) => c.oldest !== null);

/** A full page entirely at the cursor's second (`until` is inclusive): step past it. */
export function isStuckPage(
  events: readonly { created_at: number }[],
  until: number,
  pageSize: number,
): boolean {
  return events.length >= pageSize && events.every((e) => e.created_at >= until);
}

/**
 * Fold a page that a source returned when paged from `pagedFrom` (its cursor
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
