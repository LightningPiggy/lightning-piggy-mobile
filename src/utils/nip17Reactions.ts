/**
 * Reactions inside a NIP-17 chat (#1319, #1321). They travel the way the
 * messages do: a kind-7 rumor (NIP-25 tags) or a kind-5 retraction (NIP-09),
 * gift-wrapped to every chat member and to ourselves. Nothing is published
 * publicly, because a public kind 7 would put the private rumor id, the
 * chat partner's pubkey and the time on any relay. Amethyst and Anagram
 * (https://anagram.chat) use the same wrapped kinds.
 *
 * Decrypted reaction rumors are stored in the encrypted DM store like any
 * other rumor, keyed by wrap id, with `wireKind` 7 / 5 and `content` holding
 * {@link serializeChatReactionRumor}'s JSON. They never render as bubbles,
 * inbox previews or notifications. The thread's reactions hook reads them back
 * through {@link storedChatReactionEvent}.
 */

export const CHAT_REACTION_KIND = 7;
export const CHAT_DELETION_KIND = 5;

/** Rumor kinds that annotate another message rather than being one. */
export function isChatReactionKind(kind: number | undefined): boolean {
  return kind === CHAT_REACTION_KIND || kind === CHAT_DELETION_KIND;
}

// Tags a reaction / retraction needs to be read back. Everything else
// (client tags, relay hints beyond the id) is dropped before storage.
const KEPT_TAGS = new Set(['e', 'p', 'k', 'a', 'emoji']);

interface RumorLike {
  kind: number;
  content: string;
  tags: string[][];
}

/** Canonical stored `content` for a kind-7 / kind-5 rumor. */
export function serializeChatReactionRumor(rumor: RumorLike): string {
  const tags = rumor.tags
    .filter((t) => Array.isArray(t) && typeof t[0] === 'string' && KEPT_TAGS.has(t[0]))
    .map((t) => t.filter((v): v is string => typeof v === 'string'));
  return JSON.stringify({ content: typeof rumor.content === 'string' ? rumor.content : '', tags });
}

/** A stored reaction row in the NIP-25 / NIP-09 event shape. */
export interface ChatReactionEvent {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}

/**
 * Rebuild the event from a stored row, or null when the row isn't a
 * reaction / retraction, has no rumor id, or its content doesn't parse.
 * `id` is the inner rumor id: the id a later kind 5 names when it retracts
 * this reaction.
 */
export function storedChatReactionEvent(row: {
  wireKind: number;
  content: string;
  sender: string;
  createdAt: number;
  rumorId?: string;
}): ChatReactionEvent | null {
  if (!isChatReactionKind(row.wireKind) || !row.rumorId) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { content, tags } = parsed as { content?: unknown; tags?: unknown };
  if (typeof content !== 'string' || !Array.isArray(tags)) return null;
  const cleanTags = tags.filter(
    (t): t is string[] => Array.isArray(t) && t.every((v) => typeof v === 'string'),
  );
  return {
    id: row.rumorId.toLowerCase(),
    pubkey: row.sender.toLowerCase(),
    kind: row.wireKind,
    content,
    created_at: row.createdAt,
    tags: cleanTags,
  };
}

/** Ids an event's `e` tags point at, lowercased. */
export function eTagTargets(event: { tags: string[][] }): string[] {
  return event.tags
    .filter((t) => t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0)
    .map((t) => t[1].toLowerCase());
}

/**
 * The kind-7 rumor for reacting to a message in a 1:1 NIP-17 chat. Tags follow
 * NIP-25 (`e` target, `p` target author, `k` target kind). The peer is also
 * `p`-tagged when we react to our own message, so our other devices can tell
 * which chat the reaction belongs to.
 */
export function buildChatReactionRumor(input: {
  myPubkey: string;
  peerPubkey: string;
  emoji: string;
  targetEventId: string;
  targetAuthorPubkey: string;
  targetEventKind?: number;
  createdAt?: number;
}): { kind: 7; pubkey: string; created_at: number; tags: string[][]; content: string } {
  const author = input.targetAuthorPubkey.toLowerCase();
  const peer = input.peerPubkey.toLowerCase();
  const tags: string[][] = [
    ['e', input.targetEventId.toLowerCase()],
    ['p', author],
  ];
  if (peer !== author) tags.push(['p', peer]);
  tags.push(['k', String(input.targetEventKind ?? 14)]);
  return {
    kind: CHAT_REACTION_KIND,
    pubkey: input.myPubkey.toLowerCase(),
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags,
    content: input.emoji,
  };
}

/**
 * The kind-5 rumor retracting one of our reactions. Amethyst and Anagram send
 * `e` + `k`; the `p` tag places it in the right chat on our other devices.
 */
export function buildChatReactionDeletionRumor(input: {
  myPubkey: string;
  peerPubkey: string;
  reactionEventId: string;
  createdAt?: number;
}): { kind: 5; pubkey: string; created_at: number; tags: string[][]; content: string } {
  return {
    kind: CHAT_DELETION_KIND,
    pubkey: input.myPubkey.toLowerCase(),
    created_at: input.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ['e', input.reactionEventId.toLowerCase()],
      ['k', String(CHAT_REACTION_KIND)],
      ['p', input.peerPubkey.toLowerCase()],
    ],
    content: '',
  };
}
