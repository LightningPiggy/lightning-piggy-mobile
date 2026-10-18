// Pure logic for Market PRODUCT COMMENTS (NIP-22 kind 1111), ported from the
// Lightning Piggy companion website (RobotechyShop/robotechy-website,
// src/lib/productComments.ts).
//
// Comments are rooted on the kind-30402 PRODUCT via the NIP-22 upper/lower tag
// split:
//   • UPPERCASE A/I/E + K/P = the thread ROOT (the product) — on every comment
//     at any depth. Filtering on `#A` returns the WHOLE conversation.
//   • lowercase a/i/e + k/p = the immediate PARENT (the comment replied to, or
//     the root itself for a top-level comment).
// For an addressable product the coordinate is the BARE `30402:<merchant>:<d>`
// (note: NO leading `a:` here — that prefix is only used for the review `d`
// tag; see productReviews.ts).
//
// No React, no I/O — unit-testable in isolation (coverage scope: src/utils).
import type { Event as NostrEvent, Filter } from 'nostr-tools';

/** NIP-22 comment event kind. */
export const COMMENT_KIND = 1111;
/** Single source of truth for the comment query limit (tab count + section). */
export const DEFAULT_COMMENTS_LIMIT = 500;

/** A comment thread root: a Nostr event (e.g. the product) or an external URL. */
export type CommentRoot = NostrEvent | URL;

// --- NIP-01 kind classification (inlined; LP doesn't depend on Nostrify) ----
/** Addressable (parameterised replaceable): 30000 <= kind < 40000. */
export function isAddressableKind(kind: number): boolean {
  return kind >= 30000 && kind < 40000;
}
/** Replaceable: kind 0, kind 3, or 10000 <= kind < 20000. */
export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** First value of the named tag on an event, or undefined. */
export function getTagValue(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find(([name]) => name === tagName)?.[1];
}

/** The event's `d` tag value (empty string when absent). */
export function dTagOf(event: NostrEvent): string {
  return getTagValue(event, 'd') ?? '';
}

/** Bare addressable coordinate `<kind>:<pubkey>:<d>` (e.g. `30402:<m>:<d>`). */
export function addressableCoord(event: NostrEvent): string {
  return `${event.kind}:${event.pubkey}:${dTagOf(event)}`;
}

/**
 * Stable identity for a root, used as the query-cache key — the coordinate for
 * addressable/replaceable roots (survives listing edits that change the event
 * id), the id for a regular event, the href for a URL.
 */
export function commentRootRef(root: CommentRoot): string {
  if (root instanceof URL) return root.toString();
  if (isAddressableKind(root.kind)) return addressableCoord(root);
  if (isReplaceableKind(root.kind)) return `${root.kind}:${root.pubkey}:`;
  return root.id;
}

/** Relay filter fetching the whole conversation rooted on `root`. */
export function commentFilterForRoot(root: CommentRoot, limit?: number): Filter {
  const filter: Filter = { kinds: [COMMENT_KIND] };
  if (root instanceof URL) {
    filter['#I'] = [root.toString()];
  } else if (isAddressableKind(root.kind)) {
    filter['#A'] = [addressableCoord(root)];
  } else if (isReplaceableKind(root.kind)) {
    filter['#A'] = [`${root.kind}:${root.pubkey}:`];
  } else {
    filter['#E'] = [root.id];
  }
  if (typeof limit === 'number') filter.limit = limit;
  return filter;
}

/**
 * Whether a comment's UPPERCASE root tag is this root — the client-side twin
 * of {@link commentFilterForRoot}. The relay filter is only a request; an
 * event a relay returns for another root must be dropped before it's stored.
 */
export function belongsToRoot(comment: NostrEvent, root: CommentRoot): boolean {
  // The `kinds` filter is only a request too — a same-`A` event of another
  // kind is not a comment.
  if (comment.kind !== COMMENT_KIND) return false;
  if (root instanceof URL) return getTagValue(comment, 'I') === root.toString();
  if (isAddressableKind(root.kind)) return getTagValue(comment, 'A') === addressableCoord(root);
  if (isReplaceableKind(root.kind))
    return getTagValue(comment, 'A') === `${root.kind}:${root.pubkey}:`;
  return getTagValue(comment, 'E') === root.id;
}

/** Whether a comment's LOWERCASE parent tag points directly at the root. */
export function isTopLevelComment(comment: NostrEvent, root: CommentRoot): boolean {
  if (root instanceof URL) return getTagValue(comment, 'i') === root.toString();
  if (isAddressableKind(root.kind)) return getTagValue(comment, 'a') === addressableCoord(root);
  if (isReplaceableKind(root.kind))
    return getTagValue(comment, 'a') === `${root.kind}:${root.pubkey}:`;
  return getTagValue(comment, 'e') === root.id;
}

/**
 * Build the NIP-22 tags for a new comment. `reply` is the parent comment when
 * replying; omit it for a top-level comment on the root.
 */
export function buildCommentTags(root: CommentRoot, reply?: CommentRoot): string[][] {
  const tags: string[][] = [];

  // Root scope (UPPERCASE).
  if (root instanceof URL) {
    // NIP-22 scopes a URL comment with an external identity: the `K`/`k` tag is
    // the external-id KIND from NIP-73, which for any URL is the literal string
    // `"web"` (NOT the hostname). See NIP-22 "comment on a website's url" and
    // the NIP-73 supported-IDs table (URLs → `k` = "web").
    tags.push(['I', root.toString()], ['K', 'web']);
  } else if (isAddressableKind(root.kind)) {
    tags.push(['A', addressableCoord(root)], ['K', root.kind.toString()], ['P', root.pubkey]);
  } else if (isReplaceableKind(root.kind)) {
    tags.push(
      ['A', `${root.kind}:${root.pubkey}:`],
      ['K', root.kind.toString()],
      ['P', root.pubkey],
    );
  } else {
    tags.push(['E', root.id], ['K', root.kind.toString()], ['P', root.pubkey]);
  }

  // Immediate parent (lowercase): the reply target, or the root when top-level.
  const parent = reply ?? root;
  if (parent instanceof URL) {
    tags.push(['i', parent.toString()], ['k', 'web']);
  } else if (isAddressableKind(parent.kind)) {
    tags.push(['a', addressableCoord(parent)], ['k', parent.kind.toString()], ['p', parent.pubkey]);
  } else if (isReplaceableKind(parent.kind)) {
    tags.push(
      ['a', `${parent.kind}:${parent.pubkey}:`],
      ['k', parent.kind.toString()],
      ['p', parent.pubkey],
    );
  } else {
    tags.push(['e', parent.id], ['k', parent.kind.toString()], ['p', parent.pubkey]);
  }
  return tags;
}

/** Top-level comments for a root, newest-first. */
export function topLevelComments(events: NostrEvent[], root: CommentRoot): NostrEvent[] {
  return events
    .filter((c) => isTopLevelComment(c, root))
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/** Direct replies to a parent comment (lowercase `e` === parentId), oldest-first. */
export function directReplies(events: NostrEvent[], parentId: string): NostrEvent[] {
  return events
    .filter((c) => getTagValue(c, 'e') === parentId)
    .sort((a, b) => (a.created_at ?? 0) - (b.created_at ?? 0));
}

/** Flatten visible comments, retaining edit ancestry without changing signed tags. */
export function threadedComments(
  events: NostrEvent[],
  root: CommentRoot,
  ancestry: NostrEvent[] = events,
): { comment: NostrEvent; depth: number }[] {
  const byId = new Map(ancestry.map((event) => [event.id, event]));
  const replacements = new Map<string, NostrEvent>();
  for (const event of [...ancestry].sort(
    (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
  )) {
    const previous = getTagValue(event, 'edit');
    if (
      previous &&
      belongsToRoot(event, root) &&
      (!byId.has(previous) || byId.get(previous)?.pubkey === event.pubkey)
    )
      replacements.set(previous, event);
  }
  const visible = new Set(events.map((event) => event.id));
  const children = new Map<string, NostrEvent[]>();
  const roots: NostrEvent[] = [];
  for (const event of events) {
    if (!belongsToRoot(event, root)) continue;
    let parent = getTagValue(event, 'e');
    const visited = new Set<string>();
    while (parent && replacements.has(parent) && !visited.has(parent)) {
      visited.add(parent);
      const replacement = replacements.get(parent)!;
      // A missing original cannot authenticate the edit. The reply's signed
      // parent-author tag must agree before attaching it to a replacement.
      if (getTagValue(event, 'p') !== replacement.pubkey) break;
      parent = replacement.id;
    }
    if (isTopLevelComment(event, root) || !parent || !visible.has(parent)) roots.push(event);
    else children.set(parent, [...(children.get(parent) ?? []), event]);
  }
  const out: { comment: NostrEvent; depth: number }[] = [];
  const seen = new Set<string>();
  const pending = roots
    .sort((a, b) => b.created_at - a.created_at)
    .map((comment) => ({ comment, depth: 0 }))
    .reverse();
  const drain = () => {
    while (pending.length) {
      const row = pending.pop()!;
      if (seen.has(row.comment.id)) continue;
      seen.add(row.comment.id);
      out.push(row);
      const replies = (children.get(row.comment.id) ?? []).sort(
        (a, b) => a.created_at - b.created_at,
      );
      for (const comment of [...replies].reverse()) pending.push({ comment, depth: row.depth + 1 });
    }
  };
  drain();
  // Malformed cycles must neither loop forever nor hide otherwise valid rows.
  for (const comment of events) {
    if (!seen.has(comment.id) && belongsToRoot(comment, root)) {
      pending.push({ comment, depth: 0 });
      drain();
    }
  }
  return out;
}
