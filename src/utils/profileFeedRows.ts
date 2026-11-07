// Pure shaping of a profile's feed into list rows for the profile page's
// single virtualised list: one row per post, three media tiles per grid row,
// two products per grid row, or one status row (loading / empty). Kept out
// of the screen so the tab → rows logic is unit-testable.
import { extractNoteMedia, type NoteMediaItem } from './noteMedia';
import { isReply, type ReplyTarget } from './nip10';
import { dedupeReplyEchoes, isNoteOrNoteComment, noteReplyTarget } from './noteReplies';
import type { AuthorFeedEvent } from '../services/authorFeedService';
import type { MarketProduct } from '../data/marketProducts';

export type ProfileTab = 'posts' | 'media' | 'shop';
/** Posts tab filter: top-level posts only (default), or posts and replies. */
export type PostsMode = 'posts' | 'all';

export const MEDIA_COLUMNS = 3;
export const PRODUCT_COLUMNS = 2;

export interface MediaTile {
  key: string;
  eventId: string;
  /** The tile's event author — decides auto-load vs tap-to-load (#1338). */
  authorPubkey: string;
  item: NoteMediaItem;
}

export type ProfileStatus =
  | 'loading'
  | 'emptyPosts'
  | 'onlyReplies'
  | 'emptyMedia'
  | 'emptyShop'
  | 'shopUnavailable'
  | 'feedUnavailable';

export type ProfileRow =
  | {
      type: 'post';
      key: string;
      event: AuthorFeedEvent;
      /** Set for replies in "Posts & replies" mode: what it replies to. */
      reply: ReplyTarget | null;
    }
  | { type: 'media'; key: string; tiles: MediaTile[] }
  | { type: 'products'; key: string; products: MarketProduct[] }
  | { type: 'status'; key: string; status: ProfileStatus };

/** Newest first; ties break on id so the order is stable across renders. */
export function sortFeed(events: Iterable<AuthorFeedEvent>): AuthorFeedEvent[] {
  return [...events].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
}

/** Every media item in a (sorted) feed, as grid tiles, de-duplicated by URL. */
export function collectMediaTiles(events: readonly AuthorFeedEvent[]): MediaTile[] {
  const tiles: MediaTile[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const item of extractNoteMedia(event)) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      tiles.push({
        key: `${event.id}:${item.url}`,
        eventId: event.id,
        authorPubkey: event.pubkey,
        item,
      });
    }
  }
  return tiles;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

export interface ProfileRowsInput {
  tab: ProfileTab;
  /** Posts tab filter; defaults to top-level posts only. */
  postsMode?: PostsMode;
  feed: readonly AuthorFeedEvent[];
  feedLoading: boolean;
  /** No relay answered the feed query (all failed / none replied in time). */
  feedUnavailable?: boolean;
  products: readonly MarketProduct[];
  productsLoading: boolean;
  /** The seller snapshot couldn't be completed (relays failed / timed out). */
  productsIncomplete?: boolean;
}

export function buildProfileRows(input: ProfileRowsInput): ProfileRow[] {
  const status = (s: ProfileStatus): ProfileRow[] => [
    { type: 'status', key: `status-${s}`, status: s },
  ];
  if (input.tab === 'shop') {
    if (input.products.length === 0)
      return status(
        input.productsLoading
          ? 'loading'
          : input.productsIncomplete
            ? 'shopUnavailable'
            : 'emptyShop',
      );
    return chunk(input.products, PRODUCT_COLUMNS).map((products) => ({
      type: 'products',
      key: `products-${products[0].id}`,
      products,
    }));
  }
  if (input.tab === 'media') {
    const tiles = collectMediaTiles(input.feed);
    if (tiles.length === 0)
      return status(
        input.feedLoading ? 'loading' : input.feedUnavailable ? 'feedUnavailable' : 'emptyMedia',
      );
    return chunk(tiles, MEDIA_COLUMNS).map((row) => ({
      type: 'media',
      key: `media-${row[0].key}`,
      tiles: row,
    }));
  }
  const all = input.postsMode === 'all';
  // Notes, plus NIP-22 comments replying inside a note's thread (#1337) —
  // always replies, so only under "Posts & replies".
  const notes = input.feed.filter(isNoteOrNoteComment);
  const posts = all ? dedupeReplyEchoes(notes) : notes.filter((e) => e.kind === 1 && !isReply(e));
  if (posts.length === 0) {
    if (input.feedLoading) return status('loading');
    // No relay answered: "couldn't load", never a false "no posts yet".
    if (input.feedUnavailable && notes.length === 0) return status('feedUnavailable');
    // Only replies loaded so far — point at the other mode.
    return status(notes.length > 0 ? 'onlyReplies' : 'emptyPosts');
  }
  return posts.map((event) => ({
    type: 'post',
    key: event.id,
    event,
    reply: all ? noteReplyTarget(event) : null,
  }));
}

export interface AutoPageInput {
  focused: boolean;
  tab: ProfileTab;
  postsMode: PostsMode;
  loading: boolean;
  loadingMore: boolean;
  reachedEnd: boolean;
  feedSize: number;
  topLevelCount: number;
  /** Auto pages already fetched for this person + filter. */
  autoPages: number;
}

/** "Posts" auto-pages past replies until it has this many posts… */
export const MIN_TOP_LEVEL_POSTS = 10;
/** …or has fetched this many extra pages for this person + filter. */
export const MAX_AUTO_PAGES = 4;

/**
 * Whether the Posts tab should fetch another page on its own: only while
 * focused, in "Posts" mode, idle, not at the end, short of top-level posts,
 * and within the per-person budget.
 */
export function shouldAutoPage(i: AutoPageInput): boolean {
  return (
    i.focused &&
    i.tab === 'posts' &&
    i.postsMode === 'posts' &&
    !i.loading &&
    !i.loadingMore &&
    !i.reachedEnd &&
    i.feedSize > 0 &&
    i.topLevelCount < MIN_TOP_LEVEL_POSTS &&
    i.autoPages < MAX_AUTO_PAGES
  );
}

/** Top-level posts in a (sorted) feed — what "Posts" mode can show. */
export function countTopLevelPosts(feed: readonly AuthorFeedEvent[]): number {
  let n = 0;
  for (const e of feed) if (e.kind === 1 && !isReply(e)) n++;
  return n;
}
