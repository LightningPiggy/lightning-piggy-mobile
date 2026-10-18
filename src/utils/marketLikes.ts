import { enabledAppRelays } from '../services/appRelayPrefs';
// Market listing likes (#1541) — pure helpers, no I/O.
//
// A "like" is a public NIP-25 reaction (kind 7) on a kind-30402 listing,
// targeted by the listing's addressable coordinate (`a` tag) so it survives
// the seller editing the listing. "Unlike" is a NIP-09 deletion (kind 5) of
// the liker's own reaction. These helpers turn raw relay events into a like
// count, the viewer's own active like, and the viewer's liked listings.
import type { Event } from 'nostr-tools';
import { MARKET_RELAYS } from './marketListingsQuery';

export const LISTING_KIND = 30402;
export const LIKE_CONTENT = '+';

/** Upper bound for reactions read per listing / per "Liked items" fetch. */
export const LIKES_QUERY_LIMIT = 500;
/** Ids per deletion `#e` filter (relays reject very long tag arrays). */
export const DELETION_ID_CHUNK = 100;
/** Liked listings resolved per visit to the Liked items screen. */
export const MAX_LIKED_ITEMS = 100;

/**
 * Reaction content that counts as a like. NIP-25: `+` (or empty) is a like,
 * `-` a dislike, and an emoji is its own reaction — other clients commonly
 * "like" with a heart or a thumbs-up, so those count too. Anything else (😂,
 * 🔥, a custom `:shortcode:`) is a reaction, not a like.
 */
const LIKE_GLYPHS = new Set([
  '',
  '+',
  '❤️',
  '❤',
  '♥️',
  '♥',
  '💜',
  '🧡',
  '💖',
  '💗',
  '😍',
  '👍',
  '🤙',
]);

export function isLikeContent(content: string): boolean {
  // Strip skin-tone modifiers so 👍🏽 counts like 👍.
  return LIKE_GLYPHS.has(content.trim().replace(/[\u{1F3FB}-\u{1F3FF}]/gu, ''));
}

/** `30402:<pubkey>:<d>` for a kind-30402 listing event; null for anything else. */
export function listingCoordinate(event: Pick<Event, 'kind' | 'pubkey' | 'tags'>): string | null {
  if (event.kind !== LISTING_KIND) return null;
  const d = event.tags.find((t) => t[0] === 'd')?.[1];
  return d ? `${LISTING_KIND}:${event.pubkey}:${d}` : null;
}

/** Relay hint for a listing reference: where marketplace listings are read from. */
export const listingRelayHint = () => enabledAppRelays('market', MARKET_RELAYS)[0];

const tagValues = (event: Pick<Event, 'tags'>, name: string) =>
  event.tags.filter((t) => t[0] === name && typeof t[1] === 'string').map((t) => t[1]);

/**
 * Ids of reactions retracted by their OWN author. NIP-09 is only honoured
 * when the deletion's author matches the deleted event's — a relay can't
 * enforce that, so a third party's kind-5 must not hide someone's like.
 */
export function retractedReactionIds(
  reactions: readonly Pick<Event, 'id' | 'pubkey'>[],
  deletions: readonly Pick<Event, 'kind' | 'pubkey' | 'tags'>[],
): Set<string> {
  const authorById = new Map(reactions.map((r) => [r.id, r.pubkey]));
  const retracted = new Set<string>();
  for (const deletion of deletions) {
    if (deletion.kind !== 5) continue;
    for (const id of tagValues(deletion, 'e')) {
      if (authorById.get(id) === deletion.pubkey) retracted.add(id);
    }
  }
  return retracted;
}

/** Newest first; equal timestamps break to the lower id (NIP-01). */
const newerFirst = (a: Pick<Event, 'created_at' | 'id'>, b: Pick<Event, 'created_at' | 'id'>) =>
  b.created_at - a.created_at || a.id.localeCompare(b.id);

function activeLikes(
  reactions: readonly Event[],
  deletions: readonly Event[],
  coordinate: string,
): Event[] {
  const retracted = retractedReactionIds(reactions, deletions);
  return reactions
    .filter(
      (r) =>
        r.kind === 7 &&
        !retracted.has(r.id) &&
        isLikeContent(r.content) &&
        tagValues(r, 'a').includes(coordinate),
    )
    .sort(newerFirst);
}

export interface ListingLikes {
  /** People with an active like — one per pubkey, however many they sent. */
  count: number;
  /** The viewer's newest active like (the one Unlike retracts), if any. */
  myReactionId: string | null;
  /** All of the viewer's active likes — Unlike retracts every one. */
  myReactionIds: string[];
}

/** Count the likes on one listing coordinate from raw kind-7 + kind-5 events. */
export function aggregateListingLikes(
  reactions: readonly Event[],
  deletions: readonly Event[],
  coordinate: string,
  viewer: string | null,
): ListingLikes {
  const likes = activeLikes(reactions, deletions, coordinate);
  const likers = new Set(likes.map((r) => r.pubkey));
  const mine = viewer ? likes.filter((r) => r.pubkey === viewer).map((r) => r.id) : [];
  return { count: likers.size, myReactionId: mine[0] ?? null, myReactionIds: mine };
}

export interface LikedListingRef {
  coordinate: string;
  kind: number;
  pubkey: string;
  identifier: string;
  /** When the viewer (last) liked it — the list is ordered by this, newest first. */
  likedAt: number;
}

/** Split `30402:<64-hex pubkey>:<d>`; the `d` itself may contain colons. */
export function parseListingCoordinate(
  coordinate: string,
): { kind: number; pubkey: string; identifier: string } | null {
  const match = /^(\d+):([0-9a-f]{64}):(.+)$/s.exec(coordinate);
  if (!match || Number(match[1]) !== LISTING_KIND) return null;
  return { kind: LISTING_KIND, pubkey: match[2], identifier: match[3] };
}

/**
 * The viewer's liked listings: their own kind-7 likes on kind-30402
 * coordinates, minus the ones they retracted, newest like first, one entry
 * per listing, capped at MAX_LIKED_ITEMS.
 */
export function deriveLikedListings(
  reactions: readonly Event[],
  deletions: readonly Event[],
  viewer: string,
): LikedListingRef[] {
  const retracted = retractedReactionIds(reactions, deletions);
  const byCoordinate = new Map<string, LikedListingRef>();
  for (const r of [...reactions].sort(newerFirst)) {
    if (r.kind !== 7 || r.pubkey !== viewer || retracted.has(r.id)) continue;
    if (!isLikeContent(r.content) || !tagValues(r, 'k').includes(String(LISTING_KIND))) continue;
    for (const coordinate of tagValues(r, 'a')) {
      const parsed = parseListingCoordinate(coordinate);
      if (!parsed || byCoordinate.has(coordinate)) continue;
      byCoordinate.set(coordinate, { coordinate, ...parsed, likedAt: r.created_at });
    }
  }
  return [...byCoordinate.values()].slice(0, MAX_LIKED_ITEMS);
}

/** Split ids into relay-sized chunks for `#e` deletion lookups. */
export function chunkIds(ids: readonly string[], size = DELETION_ID_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}
