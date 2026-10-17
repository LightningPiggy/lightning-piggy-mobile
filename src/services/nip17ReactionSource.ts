// Reactions in a 1:1 NIP-17 chat (#1319, #1321): kind-7 / kind-5 rumors
// gift-wrapped to the peer and ourselves, never published publicly. They
// arrive through the normal DM ingest, which stores them as wireKind 7 / 5
// rows; this source reads those rows back and sends new ones.
//
// Earlier Lightning Piggy builds published DM reactions publicly. Our own are
// still read (by author, so no private message id goes to a relay) and show
// after the stored ones; retracting one also sends a public kind 5, asking
// relays to delete it. The peer's old public reactions are not read: finding
// them would mean asking relays about this chat's message ids.
//
// Same shape as the Marmot source, so useConversationReactions can use either.

import {
  deleteLocalDmRow,
  getConversationReactionRows,
  LOCAL_DM_ID_PREFIX,
  subscribeDmStorage,
  upsertDmMessages,
  type DmMessageRow,
} from './dmDb';
import { directMessageRumorEventId } from './dmRumorId';
import { readOwnLegacyDmReactions } from './legacyDmReactions';
import {
  buildChatReactionDeletionRumor,
  buildChatReactionRumor,
  CHAT_DELETION_KIND,
  CHAT_REACTION_KIND,
  eTagTargets,
  isChatReactionKind,
  serializeChatReactionRumor,
  storedChatReactionEvent,
  type ChatReactionEvent,
} from '../utils/nip17Reactions';

export interface ChatRumor {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

export interface Nip17ReactionDeps {
  myPubkey: string;
  peerPubkey: string;
  /** Gift-wrap `rumor` to the peer (and our own inbox). True once a relay accepted it. */
  sendRumor: (rumor: ChatRumor) => Promise<boolean>;
  /** Our own public DM reactions from earlier builds, their public retractions,
   * and the public retraction we send when removing one. */
  publicReactions: {
    fetchOwnDmReactions: () => Promise<ChatReactionEvent[]>;
    fetchReactionDeletions: (
      ids: string[],
    ) => Promise<{ id: string; pubkey: string; created_at: number; tags: string[][] }[]>;
    deleteReaction: (reactionEventId: string) => Promise<boolean>;
  };
}

export interface Nip17ReactionSource {
  fetchReactionsForMessages: (targetEventIds: string[]) => Promise<ChatReactionEvent[]>;
  fetchReactionDeletions: (reactionEventIds: string[]) => Promise<ChatReactionEvent[]>;
  publishReaction: (input: {
    emoji: string;
    targetEventId: string;
    targetAuthorPubkey: string;
    targetEventKind?: number;
  }) => Promise<string | null>;
  deleteReaction: (reactionEventId: string) => Promise<boolean>;
  /** Wrapped reactions / retractions stored after subscribing, then our older
   * public ones as the relays answer. Returns unsubscribe. */
  subscribe: (onEvent: (event: ChatReactionEvent) => void) => () => void;
}

const isLocalRow = (row: DmMessageRow) => row.eventId.startsWith(LOCAL_DM_ID_PREFIX);

/** The reaction backend for `myPubkey`'s NIP-17 chat with `peerPubkey`. */
export function nip17ReactionSource(deps: Nip17ReactionDeps): Nip17ReactionSource {
  const me = deps.myPubkey.toLowerCase();
  const peer = deps.peerPubkey.toLowerCase();
  // Only the two chat members can react in a 1:1 chat. Anything else is a
  // stranger who learned a message id; ignore it.
  const isMember = (pubkey: string) => {
    const p = pubkey.toLowerCase();
    return p === me || p === peer;
  };
  // Our reaction ids that came from public relays: retracting one also needs
  // a public kind 5, or the leaked event stays up.
  const publicIds = new Set<string>();
  // The open thread's live listeners. Older public reactions arrive through
  // them, so a slow or dead relay never holds back the stored ones.
  const listeners = new Set<(event: ChatReactionEvent) => void>();
  const emit = (event: ChatReactionEvent) => {
    for (const listener of listeners) listener(event);
  };

  const toEvents = (rows: DmMessageRow[]) =>
    rows
      .map(storedChatReactionEvent)
      .filter((e): e is ChatReactionEvent => !!e && isMember(e.pubkey));
  // Reads merge into what the thread already shows, so a store failure
  // degrades to nothing new rather than rejecting.
  const storedEvents = async (kind: number): Promise<ChatReactionEvent[]> =>
    toEvents(await getConversationReactionRows(me, peer).catch(() => [])).filter(
      (e) => e.kind === kind,
    );

  // Our own public reactions, read once per account per session (shared by
  // every thread). Never rejects: null means the read failed.
  const ownPublicReactions = () =>
    readOwnLegacyDmReactions(me, deps.publicReactions.fetchOwnDmReactions);
  // A reaction of ours stored in this chat was gift-wrapped by this build,
  // so it was never public. Public ones from older builds aren't stored.
  const isStoredOwnReaction = async (id: string) =>
    (await storedEvents(CHAT_REACTION_KIND)).some((e) => e.id === id && e.pubkey === me);

  // Store our own reaction / retraction before sending it, so it survives a
  // restart even if the relay echo of our self-copy never arrives. The echo
  // replaces this `local-` row (same rumor id) when it does.
  const send = async (rumor: ChatRumor): Promise<string | null> => {
    const rumorId = directMessageRumorEventId(rumor);
    const localId = `${LOCAL_DM_ID_PREFIX}${rumorId}`;
    await upsertDmMessages([
      {
        owner: me,
        eventId: localId,
        conversation: peer,
        createdAt: rumor.created_at,
        sender: me,
        content: serializeChatReactionRumor(rumor),
        fromMe: true,
        wireKind: rumor.kind,
        rumorId,
      },
    ]);
    let sent = false;
    try {
      sent = await deps.sendRumor(rumor);
    } catch {
      sent = false;
    }
    if (!sent) {
      await deleteLocalDmRow(me, localId).catch(() => undefined);
      return null;
    }
    return rumorId;
  };

  return {
    fetchReactionsForMessages: async (ids) => {
      if (ids.length === 0) return [];
      const wanted = new Set(ids.map((id) => id.toLowerCase()));
      // NIP-25: the target is the last `e` tag.
      const targets = (e: ChatReactionEvent) => {
        const ids = eTagTargets(e);
        return ids.length > 0 && wanted.has(ids[ids.length - 1]);
      };
      void ownPublicReactions().then(async (all) => {
        const reactions = (all ?? []).filter(targets);
        if (reactions.length === 0) return;
        for (const e of reactions) publicIds.add(e.id.toLowerCase());
        const retractions = await deps.publicReactions
          .fetchReactionDeletions(reactions.map((e) => e.id))
          .catch(() => []);
        for (const e of reactions) emit(e);
        for (const e of retractions) {
          if (e.pubkey.toLowerCase() === me) emit({ ...e, kind: CHAT_DELETION_KIND, content: '' });
        }
      });
      return (await storedEvents(CHAT_REACTION_KIND)).filter(targets);
    },
    fetchReactionDeletions: async (ids) => {
      if (ids.length === 0) return [];
      const wanted = new Set(ids.map((id) => id.toLowerCase()));
      return (await storedEvents(CHAT_DELETION_KIND)).filter((e) =>
        eTagTargets(e).some((t) => wanted.has(t)),
      );
    },
    publishReaction: (input) =>
      send(buildChatReactionRumor({ myPubkey: me, peerPubkey: peer, ...input })).catch(() => null),
    deleteReaction: async (reactionEventId) => {
      const id = reactionEventId.toLowerCase();
      const storedOwn = isStoredOwnReaction(id);
      const wrapped = await send(
        buildChatReactionDeletionRumor({ myPubkey: me, peerPubkey: peer, reactionEventId: id }),
      ).catch(() => null);
      if (!publicIds.has(id) && (await storedOwn)) return wrapped !== null;
      // A reaction shown from the thread's cache may be removed before the
      // read of our older public ones has finished: wait for it before
      // deciding it was never public. (A public kind 5 for a wrapped
      // reaction would publish its private id, so only a confirmed one.)
      if (!publicIds.has(id)) {
        const own = await ownPublicReactions();
        // Can't tell whether it was public: report a failure so it can be
        // retried, rather than leave a public reaction behind.
        if (own === null) return false;
        if (own.some((e) => e.id.toLowerCase() === id)) publicIds.add(id);
      }
      if (!publicIds.has(id)) return wrapped !== null;
      // An older public reaction: it only counts as removed once relays have
      // been asked to delete it too, so a failure can be retried.
      const removed = await deps.publicReactions.deleteReaction(id).catch(() => false);
      return removed && wrapped !== null;
    },
    subscribe: (onEvent) => {
      let active = true;
      const emitted = new Set<string>();
      // Relay-delivered rows only: an optimistic `local-` row may still be
      // rolled back if its send fails, and the hook already shows it.
      const read = async () =>
        toEvents((await getConversationReactionRows(me, peer)).filter((r) => !isLocalRow(r)));
      // Rows already stored are the fetch's job; only later commits are live.
      let chain = read()
        .then((events) => {
          for (const e of events) emitted.add(e.id);
        })
        .catch(() => undefined);
      // One pending rescan at most: a burst of commits shares it.
      let rescanQueued = false;
      listeners.add(onEvent);
      const unsubscribe = subscribeDmStorage((owner, rows) => {
        if (owner !== me || rescanQueued) return;
        const relevant = rows.some(
          (r) => r.conversation === peer && isChatReactionKind(r.wireKind) && !isLocalRow(r),
        );
        if (!relevant) return;
        rescanQueued = true;
        chain = chain
          .then(async () => {
            rescanQueued = false;
            if (!active) return;
            for (const e of await read()) {
              if (emitted.has(e.id)) continue;
              emitted.add(e.id);
              if (active) onEvent(e);
            }
          })
          .catch(() => undefined);
      });
      return () => {
        active = false;
        listeners.delete(onEvent);
        unsubscribe();
      };
    },
  };
}
