/**
 * NIP-25 reaction utilities — pure helpers for building reaction events
 * and reducing incoming kind-7 events into per-target state.
 *
 * Spec: https://github.com/nostr-protocol/nips/blob/master/25.md
 *  - kind 7 event with `content` = the reaction text (single emoji, "+" /
 *    "-" for like/dislike, or a NIP-30 custom-emoji shortcode wrapped in
 *    colons).
 *  - tags MUST include the `e` tag of the target event id and the `p` tag
 *    of the target event author.
 *  - For NIP-17 wrapped DMs, the target id is the inner kind-14 rumor's
 *    id (computed locally after decryption), NOT the kind-1059 wrap id —
 *    the wrap id differs per recipient and isn't a shared identifier.
 *
 * NIP-09 deletion (kind 5) is the canonical "undo" path — we publish a
 * kind-5 event tagging the original kind-7 to retract it.
 */

/** Canonical emoji bar shown in the message-actions sheet. The order is
 * fixed (not data-driven) so the row layout never reflows between renders.
 * "+" maps to a thumbs-up by spec but we ship the emoji directly so the
 * peer renders the same glyph regardless of whether their client maps "+".
 */
export const QUICK_REACTIONS: readonly string[] = ['👍', '❤️', '😄', '😮', '😢', '🙏'];

/** The "more" grid behind the quick row — any of these (and any emoji a peer
 * sends, e.g. from White Noise's full picker) renders as a pill. */
export const MORE_REACTIONS: readonly string[] = [
  '😂', '🤣', '😍', '🥰', '😘', '😊', '😉', '😎', '🤔', '🤗',
  '😅', '😭', '😡', '🤯', '🥳', '😴', '🙄', '😬', '🤝', '👏',
  '🙌', '💪', '👌', '✌️', '🤞', '👀', '🔥', '✨', '💯', '🎉',
  '⚡', '🐷', '🌟', '💜', '💔', '✅', '❌', '🚀', '🍕', '☕',
]; // prettier-ignore

/**
 * A reaction send that failed for a reason the user can act on (e.g. a
 * Marmot group still applying a membership change). `message` is already
 * user-facing, so the reaction-failed alert shows it instead of the generic
 * "check your relays" body.
 */
export class ReactionPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReactionPublishError';
  }
}

/**
 * A reaction that went out but no relay acknowledged in time (#1656): it may
 * still land. `confirmed` resolves true once a relay is seen holding it, or
 * false once it's definitely lost — never rejects. Until then the pill shows
 * as pending, with no failure alert.
 */
export interface PendingReactionPublish {
  id: string;
  confirmed: Promise<boolean>;
}

/** What a backend's `publishReaction` resolves with: the event id (sent),
 * `null` (every relay refused it), or a still-unconfirmed send. */
export type ReactionPublishOutcome = string | null | PendingReactionPublish;

export const isPendingReactionPublish = (
  outcome: ReactionPublishOutcome,
): outcome is PendingReactionPublish => typeof outcome === 'object' && outcome !== null;

/**
 * The unsigned event body for a NIP-25 reaction. Caller hands this to
 * `signEvent` (NostrContext) and then `publishSignedEvent`.
 */
export interface ReactionEventInput {
  kind: 7;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Build a NIP-25 reaction event for a specific message.
 *
 * @param emoji - the reaction glyph; stored verbatim in `content`.
 * @param targetEventId - the target message's event id (rumor id for NIP-17
 *   DMs; raw event id for NIP-04 / public kind-1).
 * @param targetAuthorPubkey - the target message's author pubkey, lowercase
 *   hex. Goes in the `p` tag per spec.
 * @param targetEventKind - optional kind hint for the target. Useful for
 *   NIP-25 receivers that filter by `k` tag (e.g. only show DM reactions).
 *   For DMs we tag the inner rumor kind (14) rather than the wrap kind so
 *   the receiver can identify which message was reacted to.
 */
export function buildReactionEvent(
  emoji: string,
  targetEventId: string,
  targetAuthorPubkey: string,
  targetEventKind?: number,
  /**
   * For an addressable target (e.g. a kind-30402 Market listing): its
   * `<kind>:<pubkey>:<d>` coordinate goes in an `a` tag so the like survives
   * the listing being edited (a new revision = a new event id). `relayHint`
   * is added to the `e` and `a` tags, per NIP-25. Never used for DMs — DM
   * reactions are not public and target the rumor id only.
   */
  address?: { coordinate: string; relayHint?: string },
): ReactionEventInput {
  const hint = address?.relayHint;
  const tags: string[][] = [
    hint ? ['e', targetEventId, hint] : ['e', targetEventId],
    ['p', targetAuthorPubkey.toLowerCase()],
  ];
  if (address) {
    tags.push(hint ? ['a', address.coordinate, hint] : ['a', address.coordinate]);
  }
  if (typeof targetEventKind === 'number') {
    tags.push(['k', String(targetEventKind)]);
  }
  return {
    kind: 7,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: emoji,
  };
}

/**
 * Build a NIP-09 deletion event that retracts a previously-published
 * reaction. The original reaction's id goes in an `e` tag and we add a
 * `k=7` tag so receivers can filter deletion events by what they delete.
 */
export function buildReactionDeletionEvent(reactionEventId: string): {
  kind: 5;
  created_at: number;
  tags: string[][];
  content: string;
} {
  return {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['e', reactionEventId],
      ['k', '7'],
    ],
    content: '',
  };
}

/**
 * A reaction event reduced to just the fields we care about for state
 * reconciliation. The reducer only needs the reaction id (for dedup +
 * eventual NIP-09 lookup), the reactor's pubkey (so we can detect "the
 * viewer's own reaction" and toggle it), the emoji, the timestamp, and
 * which message it targets. Everything else is wire detail.
 */
export interface ReactionRecord {
  id: string;
  reactorPubkey: string;
  emoji: string;
  createdAt: number;
  targetEventId: string;
}

/**
 * The aggregated view of all reactions for a single message. `byEmoji`
 * maps each unique reaction glyph to the list of reactor pubkeys (lower-
 * case hex). `myReactions` maps each emoji the viewer has used to the
 * id of their kind-7 event — needed so we can publish a NIP-09 deletion
 * when the viewer taps to toggle off.
 *
 * Derived counts come straight from `byEmoji[emoji].length` so renderers
 * never need to track count fields separately. Map of arrays rather than
 * a `Set` so the order of reactors stays stable (oldest-first); the UI
 * renders chronologically.
 */
export interface MessageReactionState {
  byEmoji: Record<string, string[]>;
  myReactions: Record<string, string>;
  /** The viewer's reactions still being sent or confirmed (emoji → true). */
  pending?: Record<string, true>;
}

/** Empty reaction state — useful so consumers can `?? EMPTY_REACTION_STATE`
 * without having to construct a record literal at every call site. */
export const EMPTY_REACTION_STATE: MessageReactionState = Object.freeze({
  byEmoji: {},
  myReactions: {},
});

/**
 * Prefix stamped on an OPTIMISTIC reaction record's id — the placeholder we
 * render immediately on tap, before `publishReaction` returns the real
 * kind-7 event id. A record still carrying this prefix has NOT been acked by
 * a relay, so its id is meaningless off-device: a NIP-09 delete against it is
 * a no-op. Callers use `isOptimisticReactionId` to detect that case and defer
 * the retraction until the real id is known.
 */
export const OPTIMISTIC_REACTION_PREFIX = 'local-react-';

/** Mint a process-unique optimistic reaction id. `seq` guarantees uniqueness
 * even when two taps land in the same millisecond (so the cancel/ack bookkeeping
 * can key on it reliably). */
export function makeOptimisticReactionId(seq: number): string {
  return `${OPTIMISTIC_REACTION_PREFIX}${Date.now()}-${seq}`;
}

/** True when `id` is an un-acked optimistic placeholder (see the prefix doc). */
export function isOptimisticReactionId(id: string): boolean {
  return id.startsWith(OPTIMISTIC_REACTION_PREFIX);
}

/**
 * Normalize a NIP-25 reaction glyph for display + bucketing. Per spec an
 * empty content and "+" both mean "like" and "-" means "dislike". Clients
 * that send the bare "+"/"" like would otherwise render as a literal "+"
 * pill and bucket separately from a peer who sent "👍". Map them to the
 * intended glyph so semantically-equal reactions collapse into one pill.
 */
export function normalizeReactionEmoji(content: string): string {
  if (content.length === 0 || content === '+') return '👍';
  if (content === '-') return '👎';
  return content;
}

/**
 * Extract a `ReactionRecord` from a raw kind-7 event payload, or return
 * null if the event is malformed. We accept a loose `event` shape rather
 * than the nostr-tools `Event` type so unit tests can hand us literals.
 */
export function parseReactionEvent(event: {
  id: string;
  pubkey: string;
  kind: number;
  content: string;
  created_at: number;
  tags: string[][];
}): ReactionRecord | null {
  if (event.kind !== 7) return null;
  if (typeof event.content !== 'string') return null;
  const emoji = normalizeReactionEmoji(event.content);
  // Per spec, the e tag pointing at the target SHOULD be the LAST e tag.
  // If absent, drop the event — without a target there's nothing to render.
  let targetEventId: string | null = null;
  for (let i = event.tags.length - 1; i >= 0; i--) {
    const t = event.tags[i];
    if (t[0] === 'e' && typeof t[1] === 'string' && t[1].length > 0) {
      targetEventId = t[1].toLowerCase();
      break;
    }
  }
  if (!targetEventId) return null;
  if (typeof event.pubkey !== 'string' || event.pubkey.length === 0) return null;
  return {
    id: event.id,
    reactorPubkey: event.pubkey.toLowerCase(),
    emoji,
    createdAt: event.created_at,
    targetEventId,
  };
}

/**
 * Fold a list of `ReactionRecord`s into a `targetEventId → MessageReactionState`
 * map. The reducer is the single source of truth for reaction display
 * state across the conversation.
 *
 * Dedup rules:
 *  - If the same reactor pubkey publishes the same emoji multiple times
 *    against the same message, only the LATEST (highest created_at) is
 *    kept — represents their current "vote". Older duplicates are dropped.
 *    On an equal `created_at` (double-taps / spammy clients share the same
 *    second) the higher event `id` wins, so the merge is deterministic
 *    regardless of delivery order.
 *  - Different emojis from the same reactor coexist (a person can react
 *    with both ❤️ and 🔥).
 *  - `viewerPubkey` is matched lowercase; the matching reaction's id is
 *    written to `myReactions[emoji]` so the UI can NIP-09 it later.
 */
export function reduceReactions(
  records: ReactionRecord[],
  viewerPubkey: string | null,
): Map<string, MessageReactionState> {
  // Per-(target, emoji, reactor) latest-wins index built before final
  // assembly so out-of-order arrivals (a relay returns a newer event in a
  // later batch) collapse cleanly.
  type Latest = { record: ReactionRecord };
  const latestByKey = new Map<string, Latest>();
  for (const r of records) {
    const key = `${r.targetEventId}|${r.emoji}|${r.reactorPubkey}`;
    const prev = latestByKey.get(key);
    if (
      !prev ||
      r.createdAt > prev.record.createdAt ||
      // Deterministic tie-break on equal timestamps: higher id wins so the
      // survivor doesn't depend on input/delivery order.
      (r.createdAt === prev.record.createdAt && r.id > prev.record.id)
    ) {
      latestByKey.set(key, { record: r });
    }
  }

  const me = viewerPubkey ? viewerPubkey.toLowerCase() : null;
  const out = new Map<string, MessageReactionState>();
  // Stable ordering: the renderer wants oldest-first within each emoji so
  // the count grows in the same direction the relay delivered. Sort the
  // surviving records once, then bucket.
  const sorted = [...latestByKey.values()]
    .map((l) => l.record)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const r of sorted) {
    let state = out.get(r.targetEventId);
    if (!state) {
      state = { byEmoji: {}, myReactions: {} };
      out.set(r.targetEventId, state);
    }
    if (!state.byEmoji[r.emoji]) state.byEmoji[r.emoji] = [];
    state.byEmoji[r.emoji].push(r.reactorPubkey);
    if (me && r.reactorPubkey === me) {
      // Latest wins, but the latest-wins pass above already dedupes per
      // (target, emoji, reactor) so there's only one record here.
      state.myReactions[r.emoji] = r.id;
    }
  }
  return out;
}

/**
 * Apply a NIP-09 deletion to an existing reaction record list. Returns a
 * new list with any record whose id matches `deletedId` (and whose
 * reactor matches `byPubkey`, per NIP-09's "only the original author can
 * delete" rule) removed.
 *
 * Kept separate from `reduceReactions` so callers can apply deletions
 * incrementally as they stream in without re-reducing the whole list.
 */
export function applyReactionDeletion(
  records: ReactionRecord[],
  deletedId: string,
  byPubkey: string,
): ReactionRecord[] {
  const author = byPubkey.toLowerCase();
  return records.filter((r) => !(r.id === deletedId && r.reactorPubkey === author));
}

/**
 * Flag the viewer's reactions that aren't confirmed yet — still in flight
 * (optimistic id) or sent but awaiting a relay copy (`confirming`) — so the
 * pill can show them as pending (#1656). Mutates and returns `byTarget`
 * (callers pass a freshly reduced map).
 */
export function markPendingReactions(
  byTarget: Map<string, MessageReactionState>,
  confirming: ReadonlySet<string>,
): Map<string, MessageReactionState> {
  for (const [target, state] of byTarget) {
    let pending: Record<string, true> | undefined;
    for (const [emoji, id] of Object.entries(state.myReactions)) {
      if (isOptimisticReactionId(id) || confirming.has(id)) (pending ??= {})[emoji] = true;
    }
    if (pending) byTarget.set(target, { ...state, pending });
  }
  return byTarget;
}
