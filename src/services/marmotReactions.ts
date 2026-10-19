// Reactions in a Marmot 1:1 chat, the way White Noise does them: a kind-7
// event (`content` = the emoji, one `e` tag → the message id) and a kind-5
// with an `e` tag to retract it — sent INSIDE the MLS group rather than
// published to public relays. MLS delivers each event once, so a thread reads
// them back from the groups' durable history (which includes our own).
//
// Exposes the same shape as the NIP-25 relay functions so the conversation's
// reactions hook can use either backend unchanged.

import {
  buildMarmotRumor,
  subscribeMarmotSession,
  type MarmotRumor,
  type MarmotSession,
} from './marmotSession';
import { marmotSendError } from './marmotSend';
import { ReactionPublishError } from '../utils/reactions';

const REACTION_KIND = 7;
const DELETION_KIND = 5;
/** How long a thread opened during cold start waits for Marmot to come up. */
const SESSION_WAIT_MS = 60_000;

export interface MarmotReactionSource {
  fetchReactionsForMessages: (targetEventIds: string[]) => Promise<MarmotRumor[]>;
  fetchReactionDeletions: (reactionEventIds: string[]) => Promise<MarmotRumor[]>;
  publishReaction: (input: { emoji: string; targetEventId: string }) => Promise<string | null>;
  deleteReaction: (reactionEventId: string) => Promise<boolean>;
  /** Reactions / retractions arriving live in this chat. Returns unsubscribe. */
  subscribe: (onEvent: (rumor: MarmotRumor) => void) => () => void;
}

/** The signed-in account's session — waiting for it if Marmot is still
 * starting (it comes up a few seconds after cold start). */
function sessionFor(pubkey: string): Promise<MarmotSession> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    let done = false;
    const timer = setTimeout(() => {
      done = true;
      unsubscribe?.();
      reject(new Error('Marmot is not running'));
    }, SESSION_WAIT_MS);
    unsubscribe = subscribeMarmotSession((s) => {
      if (done || !s || s.pubkey !== pubkey) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe?.());
      resolve(s);
    });
    if (done) unsubscribe();
  });
}

const eTargets = (r: MarmotRumor) =>
  r.tags.filter((t) => t[0] === 'e' && typeof t[1] === 'string').map((t) => t[1].toLowerCase());

/** The reaction backend for `myPubkey`'s Marmot DM(s) with `peer`. */
export function marmotReactionSource(
  myPubkey: string,
  peer: string,
  groupId?: string,
): MarmotReactionSource {
  const p = peer.toLowerCase();
  const groupsFor = (session: MarmotSession) =>
    groupId ? Promise.resolve([groupId]) : session.dmGroupIdsWith(p);

  // Every event of `kind` across all DM groups with the peer, filtered to
  // those whose `e` tag names one of `ids` (the history store can't filter
  // by tag itself).
  const eventsReferencing = async (kind: number, ids: string[]) => {
    if (ids.length === 0) return [];
    const wanted = new Set(ids.map((id) => id.toLowerCase()));
    const session = await sessionFor(myPubkey);
    const out: MarmotRumor[] = [];
    for (const groupId of await groupsFor(session)) {
      for (const r of await session.queryHistory(groupId, [kind])) {
        if (eTargets(r).some((t) => wanted.has(t))) out.push(r);
      }
    }
    return out;
  };

  // Send into the group the referenced event lives in: a reaction to a
  // message from an older DM must land beside it, where White Noise can
  // match it. Falls back to the newest DM.
  const sendReferencing = async (kind: number, content: string, targetId: string) => {
    const session = await sessionFor(myPubkey);
    let home = groupId;
    if (!home) {
      const groups = await groupsFor(session);
      home = groups[0];
      for (const dmGroupId of groups) {
        if ((await session.queryHistory(dmGroupId)).some((r) => r.id === targetId)) {
          home = dmGroupId;
          break;
        }
      }
    }
    if (!home) throw new Error('No Marmot chat with this person yet');
    const rumor = buildMarmotRumor(myPubkey, { kind, content, tags: [['e', targetId]] });
    const byRelay = await session.sendRumor(home, rumor);
    return Object.values(byRelay).some(Boolean) ? rumor.id : null;
  };

  return {
    fetchReactionsForMessages: (ids) => eventsReferencing(REACTION_KIND, ids),
    fetchReactionDeletions: (ids) => eventsReferencing(DELETION_KIND, ids),
    // A send that throws (group still applying a change, session restarting,
    // MLS error) carries its real reason to the alert — the same wording a
    // text send in that group shows. Only "no relay accepted it" stays null.
    publishReaction: ({ emoji, targetEventId }) =>
      sendReferencing(REACTION_KIND, emoji, targetEventId).catch((e: unknown) => {
        if (__DEV__) console.warn('[Marmot] reaction send failed:', e);
        throw new ReactionPublishError(marmotSendError(e));
      }),
    deleteReaction: async (reactionEventId) =>
      (await sendReferencing(DELETION_KIND, '', reactionEventId).catch(() => null)) !== null,
    // Follows the active session, so a thread opened during cold start (or
    // kept open across a session restart) still gets live reactions.
    subscribe: (onEvent) => {
      let detach: (() => void) | undefined;
      const unsubscribeSession = subscribeMarmotSession((session) => {
        detach?.();
        detach = undefined;
        if (!session || session.pubkey !== myPubkey) return;
        detach = session.subscribe({
          onMessage: ({ group, rumor }) => {
            if (rumor.kind !== REACTION_KIND && rumor.kind !== DELETION_KIND) return;
            if (groupId ? group.id === groupId : group.isDm && group.memberPubkeys[0] === p) {
              onEvent(rumor);
            }
          },
        });
      });
      return () => {
        unsubscribeSession();
        detach?.();
      };
    },
  };
}
