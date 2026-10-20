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
import {
  ReactionPublishError,
  type ReactionPublishOutcome,
  type ReactionSettlement,
} from '../utils/reactions';
import type { MarmotLookup, MarmotSendReceipt } from './marmotSendReceipt';

const REACTION_KIND = 7;
const DELETION_KIND = 5;
/** How long a thread opened during cold start waits for Marmot to come up. */
const SESSION_WAIT_MS = 60_000;
/** When to look for an unacknowledged reaction on the relays (#1656). */
const CONFIRM_DELAYS_MS = [3_000, 10_000, 30_000];
/** Our own retractions not (yet) confirmed. marmot-ts saves a send into the
 * history before publishing; history reads and replays skip these, so a chat
 * reopened meanwhile can't apply a retraction that may never have gone out
 * (and would hide the pill for good). A failed one stays here: a read that
 * started before its cleanup may still return it. Only confirmation removes
 * an id. Bounded. */
const unconfirmedDeletions = new Set<string>();
const MAX_UNCONFIRMED_DELETIONS = 500;
function markUnconfirmedDeletion(id: string): void {
  unconfirmedDeletions.add(id);
  if (unconfirmedDeletions.size > MAX_UNCONFIRMED_DELETIONS) {
    unconfirmedDeletions.delete(unconfirmedDeletions.values().next().value!);
  }
}
/** Confirmed own retractions, told straight to every open reaction view.
 * Not via the session: MLS never echoes our sends, and its delivery is
 * deduplicated by id, so a startup replay that met the retraction while it
 * was still hidden would swallow a later re-delivery. */
type ConfirmedRetraction = { groupId: string; peer: string; rumor: MarmotRumor };
const confirmedRetractionListeners = new Set<(e: ConfirmedRetraction) => void>();
/** Ids already used by a send. The id hashes a 1-second created_at, so a
 * quick add → remove → add would rebuild the same event; each attempt gets
 * its own id instead, and an older attempt's outcome (or its history
 * cleanup) can never apply to a newer one. Bounded. */
const issuedRumorIds = new Set<string>();
const MAX_ISSUED_IDS = 500;

function uniqueRumor(myPubkey: string, kind: number, content: string, targetId: string) {
  const now = Math.floor(Date.now() / 1000);
  let rumor = buildMarmotRumor(myPubkey, { kind, content, tags: [['e', targetId]] });
  for (let bump = 1; issuedRumorIds.has(rumor.id); bump++) {
    rumor = buildMarmotRumor(myPubkey, {
      kind,
      content,
      tags: [['e', targetId]],
      created_at: now + bump,
    });
  }
  issuedRumorIds.add(rumor.id);
  if (issuedRumorIds.size > MAX_ISSUED_IDS) {
    issuedRumorIds.delete(issuedRumorIds.values().next().value!);
  }
  return rumor;
}

export interface MarmotReactionSource {
  fetchReactionsForMessages: (targetEventIds: string[]) => Promise<MarmotRumor[]>;
  fetchReactionDeletions: (reactionEventIds: string[]) => Promise<MarmotRumor[]>;
  publishReaction: (input: {
    emoji: string;
    targetEventId: string;
  }) => Promise<ReactionPublishOutcome>;
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
        if (unconfirmedDeletions.has(r.id)) continue;
        if (eTargets(r).some((t) => wanted.has(t))) out.push(r);
      }
    }
    return out;
  };

  // Send into the group the referenced event lives in: a reaction to a
  // message from an older DM must land beside it, where White Noise can
  // match it. Falls back to the newest DM.
  const sendReferencing = async (
    kind: number,
    content: string,
    targetId: string,
    onBuilt?: (rumorId: string) => void,
  ) => {
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
    const rumor = uniqueRumor(myPubkey, kind, content, targetId);
    onBuilt?.(rumor.id);
    let receipt: MarmotSendReceipt | undefined;
    const byRelay = await session.sendRumor(home, rumor, { onSent: (r) => (receipt = r) });
    const group = home;
    return {
      id: rumor.id,
      accepted: Object.values(byRelay).some(Boolean),
      receipt,
      // marmot-ts saves a sent event into the group's history before
      // publishing; one that never landed must not reappear on reopen.
      forget: () => session.forgetRumor(group, rumor.id).catch(() => undefined),
      // Every open view of this chat applies a confirmed one (a reopened one too).
      deliver: () =>
        confirmedRetractionListeners.forEach((l) => l({ groupId: group, peer: p, rumor })),
    };
  };

  // No relay acknowledged it, but one didn't explicitly refuse it either: the
  // event may still be stored. Look for it a few times; it's lost only if the
  // last look completed without finding it. A look no relay answered proves
  // nothing, so the reaction is kept (it's in the group history) rather than
  // failed falsely.
  const settleLater = async (
    sent: Awaited<ReturnType<typeof sendReferencing>>,
  ): Promise<ReactionSettlement> => {
    let last: MarmotLookup = 'unknown';
    for (const delay of CONFIRM_DELAYS_MS) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      last = await sent.receipt!.lookup();
      if (last === 'found') return 'sent';
    }
    if (last === 'unknown') return 'unknown';
    await sent.forget();
    return 'lost';
  };

  return {
    fetchReactionsForMessages: (ids) => eventsReferencing(REACTION_KIND, ids),
    fetchReactionDeletions: (ids) => eventsReferencing(DELETION_KIND, ids),
    // A send that throws (group still applying a change, session restarting,
    // MLS error) carries its real reason to the alert — the same wording a
    // text send in that group shows. A relay timeout isn't a failure (#1656):
    // the reaction stays pending until it's found on a relay or given up on.
    publishReaction: async ({ emoji, targetEventId }) => {
      let sent;
      try {
        sent = await sendReferencing(REACTION_KIND, emoji, targetEventId);
      } catch (e) {
        if (__DEV__) console.warn('[Marmot] reaction send failed:', e);
        throw new ReactionPublishError(marmotSendError(e));
      }
      if (sent.accepted) return sent.id;
      if (sent.receipt?.indeterminate) return { id: sent.id, settled: settleLater(sent) };
      // Every relay refused it. Settled as lost through the same shared path,
      // so a chat reopened meanwhile (which read it from history) drops it too.
      await sent.forget();
      return { id: sent.id, settled: Promise.resolve<ReactionSettlement>('lost') };
    },
    // An unacknowledged retraction is confirmed the same way. Only a confirmed
    // one counts: an inconclusive one is reported failed (the pill comes back,
    // so the user can retry) and dropped locally so it can't hide it later.
    deleteReaction: async (reactionEventId) => {
      let rumorId: string | undefined;
      let confirmed = false;
      try {
        const sent = await sendReferencing(DELETION_KIND, '', reactionEventId, (id) => {
          rumorId = id;
          markUnconfirmedDeletion(id);
        }).catch(() => null);
        if (!sent) return false;
        const outcome = sent.accepted
          ? 'sent'
          : sent.receipt?.indeterminate
            ? await settleLater(sent)
            : 'lost';
        confirmed = outcome === 'sent';
        if (confirmed) {
          unconfirmedDeletions.delete(sent.id);
          sent.deliver();
        } else await sent.forget();
        return confirmed;
      } finally {
        // Sent but its outcome never established (e.g. the send threw):
        // keep it excluded rather than risk applying it later.
        if (rumorId && confirmed) unconfirmedDeletions.delete(rumorId);
      }
    },
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
            // A startup replay can surface our own retraction before it's
            // confirmed; it arrives via the listener below once it is.
            if (unconfirmedDeletions.has(rumor.id)) return;
            if (groupId ? group.id === groupId : group.isDm && group.memberPubkeys[0] === p) {
              onEvent(rumor);
            }
          },
        });
      });
      const onConfirmed = (e: ConfirmedRetraction) => {
        if (e.rumor.pubkey !== myPubkey) return;
        if (groupId ? e.groupId === groupId : !!p && e.peer === p) onEvent(e.rumor);
      };
      confirmedRetractionListeners.add(onConfirmed);
      return () => {
        unsubscribeSession();
        detach?.();
        confirmedRetractionListeners.delete(onConfirmed);
      };
    },
  };
}
