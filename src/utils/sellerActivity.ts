import type { Event, Filter } from 'nostr-tools';
import { getTagValue } from './productComments';

export const ACTIVITY_WINDOW = 30 * 86400;
export const ACTIVITY_LIMIT = 200;
export const COORD_CHUNK = 25;
export interface ActivityCursor {
  lastSeen: number;
  seen: string[];
  strangers: Record<string, number>;
}
/** Corrupt or future-dated storage must not permanently silence activity. */
export function parseActivityCursor(raw: string | null, now: number): ActivityCursor {
  try {
    const value = raw ? JSON.parse(raw) : null;
    if (
      value &&
      Number.isFinite(value.lastSeen) &&
      Array.isArray(value.seen) &&
      value.strangers &&
      typeof value.strangers === 'object'
    ) {
      return {
        lastSeen: Math.min(now, Math.max(0, value.lastSeen)),
        seen: value.seen.filter((id: unknown): id is string => typeof id === 'string').slice(-4000),
        strangers: Object.fromEntries(
          Object.entries(value.strangers)
            .filter(
              (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= 0,
            )
            .slice(-500),
        ),
      };
    }
  } catch {
    /* Reset an unreadable cursor; history still deduplicates IDs. */
  }
  return { lastSeen: now - ACTIVITY_WINDOW, seen: [], strangers: {} };
}

export const activitySince = (lastSeen: number, now: number) =>
  Math.max(now - ACTIVITY_WINDOW, lastSeen - 120);

export function activityFilters(
  coords: string[],
  parentIds: string[],
  since: number,
  owner?: string,
): Filter[] {
  const filters: Filter[] = [];
  for (let i = 0; i < coords.length; i += COORD_CHUNK) {
    const chunk = coords.slice(i, i + COORD_CHUNK);
    filters.push(
      { kinds: [1111], '#A': chunk, since, limit: ACTIVITY_LIMIT },
      { kinds: [31555], '#d': chunk.map((c) => `a:${c}`), since, limit: ACTIVITY_LIMIT },
    );
  }
  for (let i = 0; i < parentIds.length; i += COORD_CHUNK)
    filters.push({
      kinds: [1111],
      '#e': parentIds.slice(i, i + COORD_CHUNK),
      since,
      limit: ACTIVITY_LIMIT,
    });
  if (owner)
    filters.push({
      kinds: [1111],
      '#p': [owner],
      '#K': ['30402'],
      '#k': ['1111'],
      since,
      limit: ACTIVITY_LIMIT,
    });
  return filters;
}

/** Validate relay scope locally. A p-tag alone is never proof of a reply. */
export function activityTarget(
  event: Event,
  owner: string,
  coords: ReadonlySet<string>,
  parents: ReadonlyMap<string, Event>,
): { coord: string; tab: 'comments' | 'reviews'; reply: boolean; sellerReply: boolean } | null {
  if (event.pubkey === owner) return null;
  if (event.kind === 31555) {
    const d = getTagValue(event, 'd');
    const coord = d?.startsWith('a:') ? d.slice(2) : '';
    return coords.has(coord) ? { coord, tab: 'reviews', reply: false, sellerReply: false } : null;
  }
  if (event.kind !== 1111 || getTagValue(event, 'K') !== '30402') return null;
  const coord = getTagValue(event, 'A');
  if (!coord || !/^30402:[a-f0-9]{64}:.+$/i.test(coord)) return null;
  const parent = parents.get(getTagValue(event, 'e') ?? '');
  const reply = !!parent && parent.pubkey === owner && getTagValue(parent, 'A') === coord;
  if (!coords.has(coord) && !reply) return null;
  return {
    coord,
    tab: 'comments',
    reply,
    sellerReply: reply && coord.split(':')[1] === event.pubkey,
  };
}

/** Stage only the event ID and quota delta until delivery has completed. */
export function stageActivity(
  cursor: ActivityCursor,
  seen: Set<string>,
  event: Event,
  coord: string,
  friend: boolean,
  now: number,
): { accepted: boolean; commit: (consumeQuota?: boolean) => void } {
  if (
    event.created_at < activitySince(cursor.lastSeen, now) ||
    event.created_at > now + 120 ||
    seen.has(event.id)
  )
    return { accepted: false, commit: () => {} };
  const day = Math.floor(now / 86400);
  const key = `${day}:${coord}`;
  const count = cursor.strangers[key] ?? 0;
  const accepted = friend || count < 20;
  return {
    accepted,
    commit: (consumeQuota = true) => {
      if (seen.has(event.id)) return;
      seen.add(event.id);
      cursor.seen.push(event.id);
      if (cursor.seen.length > 4000) seen.delete(cursor.seen.shift()!);
      if (consumeQuota && !friend && accepted) cursor.strangers[key] = count + 1;
      const keys = Object.keys(cursor.strangers);
      const current = keys.filter((k) => k.startsWith(`${day}:`));
      const retained = new Set(current.slice(-500));
      for (const k of keys) if (!retained.has(k)) delete cursor.strangers[k];
    },
  };
}

/** Mutates the bounded cursor only once per id; overlapping since windows are safe. */
export function acceptActivity(
  cursor: ActivityCursor,
  event: Event,
  coord: string,
  friend: boolean,
  now: number,
): boolean {
  const staged = stageActivity(cursor, new Set(cursor.seen), event, coord, friend, now);
  staged.commit();
  return staged.accepted;
}
