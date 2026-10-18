import {
  classifyRumor,
  subjectFromRumor,
  textForRumor,
  type DecodedRumor,
} from '../utils/nip17Unwrap';
import {
  findGroupForParticipants,
  reconcileSyntheticGroup,
} from '../services/groupRoutingRegistry';
import { isSyntheticGroupId, syntheticGroupIdForParticipants } from '../utils/syntheticGroupId';
import { appendGroupMessage, type GroupMessage } from '../services/groupMessagesStorageService';
import { notifyGroupMessage } from './nostrEventBus';
import type { Group } from '../types/groups';

/**
 * Outcome of attempting to route a kind-14 rumor as a group message.
 *
 * The 1:1 fallthrough path uses `partnerFromRumor`, which for a
 * multi-recipient rumor would arbitrarily pick the FIRST p tag and
 * mis-catalogue the rumor as a 1:1 DM with that pubkey. Callers must
 * therefore distinguish "not a group" (safe to fall through to DM)
 * from "group-shaped, no local match" (must NOT fall through). An unknown
 * two-party chat awaiting trust uses DM follow-gate deferral but carries
 * its original rumor so hydration replay can retry group routing.
 */
export type GroupRouteResult =
  // appended; carries the group + message so the LIVE caller can fire an
  // OS notification (#279). Only live deliveries notify — see nostrLiveDmSub.
  | { kind: 'routed'; group: Group; message: GroupMessage }
  | { kind: 'group-no-match' } // group-shaped but no matching local group
  | { kind: 'not-group'; deferredGroupRumor?: DecodedRumor }; // DM fallthrough, or pending trust

/**
 * Try to route a decoded kind-14 rumor as a group message.
 *
 * Side-effects on `routed`:
 *  - Appends to groupMessagesStorageService keyed by group.id
 *  - Fires the in-process group-message listener so an open thread
 *    refreshes immediately
 */
export async function tryRouteGroupRumor(
  rumor: DecodedRumor,
  viewerPubkey: string,
  wrapId: string,
  shouldAbort: () => boolean = () => false,
  passesFollowGate: (pk: string) => boolean = () => false,
): Promise<GroupRouteResult> {
  const cls = classifyRumor(rumor, viewerPubkey);
  if (!cls || cls.type === 'order') return { kind: 'not-group' };
  // Two-party specialized rumors stay on their DM handlers, except files
  // explicitly addressed to a named room via subject. Subjectless files
  // remain DMs even when a room has the same participants.
  const isTwoParty = cls.type === 'dm' || cls.otherParticipants.size === 1;
  const isGroupFile = rumor.kind === 15 && cls.type === 'group';
  if (isTwoParty && rumor.kind !== 14 && !isGroupFile) return { kind: 'not-group' };
  // An unmarked two-party rumor is a direct message even if a named
  // group has the same members. Our group sends include subject on EVERY
  // text/file rumor; membership alone cannot disambiguate these two UIs.
  if (cls.type === 'dm') return { kind: 'not-group', deferredGroupRumor: rumor };
  const otherParticipants = cls.otherParticipants;
  let group = findGroupForParticipants(otherParticipants, viewerPubkey);
  // A subject names a room; it does not authenticate an unknown peer.
  // Before promoting a two-party DM, preserve the receive caller's follow
  // policy. Known rooms retain membership as their trust signal. Returning
  // not-group lets the caller apply its usual drop/defer/skip-set behavior.
  // Preserve marked rumors so follow hydration can retry group routing.
  if (!group && isTwoParty && !passesFollowGate(Array.from(otherParticipants)[0])) {
    return {
      kind: 'not-group',
      deferredGroupRumor: rumor,
    };
  }
  if (shouldAbort()) return { kind: 'group-no-match' };
  // Always run the synthetic-reconcile path when the matched group is
  // synthetic (no kind-30200 backing it) — that's the only way later
  // `subject`-tag renames from foreign clients propagate to the local
  // group name. Per NIP-17 latest-wins, every kind-14 with a `subject`
  // for an existing room can update its name; without this branch the
  // first sender's subject would stick forever.
  const isSynthetic = group ? isSyntheticGroupId(group.id) : false;
  if (!group || isSynthetic) {
    // No matching kind-30200-backed local group, OR matched a synthetic
    // group that may need a name refresh. Try the NIP-17 spec-aligned
    // fallback: foreign clients (Amethyst / Quartz, 0xchat) don't
    // publish kind-30200; they advertise the group name via the
    // kind-14 `subject` tag, and the room identity is the participant
    // set. Materialise / update a synthetic group keyed off a
    // deterministic SHA-256 of the sorted pubkey-set so subsequent
    // messages from the same room land in the same local thread, and
    // so the same id is computed across all peers / sessions.
    //
    // We require a `subject` to take this fallback — kind-14s without
    // one are either (a) LP-native groups whose kind-30200 hasn't
    // landed yet (existing drop-then-refresh behaviour is correct), or
    // (b) malformed / spam (no semantic name to attach to anyway).
    const subject = subjectFromRumor(rumor);
    if (subject) {
      // NIP-17 room key = pubkey + p tags = sender + every p-tag
      // (viewer included). `participantsFromRumor` returns exactly
      // that set; it's what `classifyRumor` derived `otherParticipants`
      // from minus the viewer, so re-include the viewer here.
      const fullRoom = new Set<string>(otherParticipants);
      fullRoom.add(viewerPubkey.toLowerCase());
      const synthId = syntheticGroupIdForParticipants(fullRoom);
      // memberPubkeys excludes the viewer by LP convention (see Group
      // type docstring + reconcileFromGroupStateEvent).
      const synthetic = await reconcileSyntheticGroup(
        {
          groupId: synthId,
          name: subject,
          memberPubkeys: Array.from(otherParticipants),
          createdAtSec: rumor.created_at,
        },
        viewerPubkey,
      );
      if (synthetic) {
        group = synthetic;
      }
    }
  }
  if (!group) {
    // Still no match (no subject, or GroupsContext hasn't registered
    // its reconciler yet — typically only during cold boot / logout).
    // Drop on the floor: these wraps are NOT written into the
    // persistent NIP-17 wrap cache (the caller's `continue` happens
    // before the cache write), so retry only happens via a relay
    // re-fetch on the next force-refresh. Caveat: NIP-59 wraps use
    // randomised `created_at` so non-force refreshes (which apply a
    // `since:` filter) may miss them. Buffering pending-group-wraps
    // for replay after a 30200 lands is tracked as a follow-up.
    if (__DEV__) {
      const all = Array.from(otherParticipants);
      const fp = all
        .slice(0, 3)
        .map((p) => p.slice(0, 8))
        .join(',');
      console.log(
        `[Nostr] dropped group-shaped rumor (no matching group): participants=[${fp}${all.length > 3 ? ',...' : ''}] sender=${rumor.pubkey.slice(0, 8)}`,
      );
    }
    return { kind: 'group-no-match' };
  }
  if (shouldAbort()) return { kind: 'group-no-match' };
  const message: GroupMessage = {
    id: wrapId,
    senderPubkey: rumor.pubkey.toLowerCase(),
    text: textForRumor(rumor),
    wireKind: rumor.kind,
    createdAt: rumor.created_at,
  };
  try {
    await appendGroupMessage(viewerPubkey, group.id, message);
    if (shouldAbort()) return { kind: 'group-no-match' };
    notifyGroupMessage(group.id, message);
  } catch (e) {
    if (__DEV__) console.warn('[Nostr] appendGroupMessage failed:', e);
    // Storage write failed — don't fall through to the DM path either,
    // it's still a group rumor. Same caveat as the no-match branch
    // above: this wrap is not in the persistent NIP-17 cache, so retry
    // requires a relay re-fetch. A force-refresh from the next focus
    // tick is the practical recovery path; no automatic replay today.
    return { kind: 'group-no-match' };
  }
  return { kind: 'routed', group, message };
}
