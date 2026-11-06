// Sending "Edit" and "Delete for everyone" for your own messages in a Marmot
// chat, in exactly the shape White Noise (MDK 0.12 `AppMessageIntent`) sends
// them, so White Noise applies ours:
//
//  - Edit: kind 1009, `content` = the new text (trimmed, never empty), one
//    `["e", <original id>]` tag. No edit window or edit count limit
//    (spec: foundation/application-messages.md). Competing edits order by
//    `created_at`, so each edit is stamped after the previous one.
//  - Delete for everyone: kind 4891 `{"v":1,"action":"remove"}` when we're a
//    group admin AND the target is a kind-9 chat message we still hold (MDK
//    `delete_message`: "Remove a whole chat with kind 4891 when an eligible
//    admin, including one's own chat"). Otherwise kind 5 with an empty
//    content and one `e` tag. Both members of a 1:1 are admins, hence 4891 there.
//
// After a relay accepts it, the event is run through the session's listeners
// (`deliverOwn`) so it lands via the SAME inbound code that applies White
// Noise's edits/deletes: ledgers, encrypted dm_messages / group_messages
// storage, previews, the "Edited" mark. It's also in the MLS history, so the
// startup replay re-applies it idempotently and can't resurrect or revert.

import {
  MARMOT_CHAT_KIND,
  buildMarmotRumor,
  type MarmotRumor,
  type MarmotSession,
} from './marmotSession';
import { MARMOT_ADMIN_REMOVE_KIND, MARMOT_DELETE_KIND } from './marmotDeletions';
import { MARMOT_EDIT_KIND } from './marmotEdits';
import {
  marmotSendError,
  MarmotUserFacingError,
  requireMarmotSession,
  type MarmotDraft,
} from './marmotSend';
import { t } from '../i18n';

/** Where the message lives: a 1:1 chat with `peer`, or a Marmot group. */
export type MarmotActionTarget = { peer: string } | { groupId: string };

export type MarmotMessageAction =
  | { type: 'edit'; text: string; previousEditedAt?: number }
  | { type: 'delete' };

/** The kind-1009 edit replacing message `targetId`'s text, or null when the
 * new text is empty (an edit can't blank a message — delete it instead).
 * `created_at` is later than any edit already applied, so it always wins. */
export function marmotEditDraft(
  targetId: string,
  text: string,
  previousEditedAt = 0,
  nowSec = Math.floor(Date.now() / 1000),
): MarmotDraft | null {
  const content = text.trim();
  if (content === '') return null;
  return {
    kind: MARMOT_EDIT_KIND,
    content,
    tags: [['e', targetId.toLowerCase()]],
    created_at: Math.max(nowSec, previousEditedAt + 1),
  };
}

/** Kind 4891 (admin removal) or kind 5 (author retraction) — MDK's rule. */
export function marmotDeleteKind(isAdmin: boolean, targetKind: number | undefined): number {
  return isAdmin && targetKind === MARMOT_CHAT_KIND ? MARMOT_ADMIN_REMOVE_KIND : MARMOT_DELETE_KIND;
}

/** The delete-for-everyone event for message `targetId`. */
export function marmotDeleteDraft(targetId: string, kind: number): MarmotDraft {
  return {
    kind,
    content: kind === MARMOT_ADMIN_REMOVE_KIND ? '{"v":1,"action":"remove"}' : '',
    tags: [['e', targetId.toLowerCase()]],
  };
}

/** The group the message lives in. A 1:1 can span several DM groups (a peer
 * who lost their MLS state starts a new one); the event must land beside its
 * target or White Noise can't match it. Falls back to the newest. */
async function groupHolding(
  session: MarmotSession,
  target: MarmotActionTarget,
  targetId: string,
): Promise<{ groupId: string; targetRumor?: MarmotRumor }> {
  const candidates =
    'groupId' in target ? [target.groupId] : await session.dmGroupIdsWith(target.peer);
  if (candidates.length === 0) throw new MarmotUserFacingError(t('messageEdit.noChat'));
  const id = targetId.toLowerCase();
  for (const groupId of candidates) {
    const targetRumor = (await session.queryHistory(groupId)).find((r) => r.id === id);
    if (targetRumor) return { groupId, targetRumor };
  }
  return { groupId: candidates[0] };
}

/**
 * Edit or delete-for-everyone `myPubkey`'s own message `targetId`. Resolves
 * `{ success: true }` once a relay accepts it and it's applied locally; on
 * failure nothing is applied (and nothing replays later).
 */
export async function sendMarmotMessageAction(
  myPubkey: string,
  target: MarmotActionTarget,
  targetId: string,
  action: MarmotMessageAction,
): Promise<{ success: boolean; error?: string }> {
  let sent: { groupId: string; rumor: MarmotRumor } | null = null;
  let session: MarmotSession | null = null;
  try {
    session = requireMarmotSession(myPubkey);
    const { groupId, targetRumor } = await groupHolding(session, target, targetId);
    // Own messages only — never send a retraction for someone else's.
    if (targetRumor && targetRumor.pubkey.toLowerCase() !== myPubkey.toLowerCase()) {
      throw new MarmotUserFacingError(t('messageEdit.notYours'));
    }
    let draft: MarmotDraft | null;
    if (action.type === 'edit') {
      draft = marmotEditDraft(targetId, action.text, action.previousEditedAt);
      if (!draft) throw new MarmotUserFacingError(t('messageEdit.emptyEdit'));
    } else {
      const me = myPubkey.toLowerCase();
      const isAdmin = !!session.getGroup(groupId)?.adminPubkeys.some((a) => a === me);
      draft = marmotDeleteDraft(targetId, marmotDeleteKind(isAdmin, targetRumor?.kind));
    }
    const rumor = buildMarmotRumor(myPubkey, draft);
    sent = { groupId, rumor };
    const byRelay = await session.sendRumor(groupId, rumor);
    if (!Object.values(byRelay).some(Boolean))
      throw new MarmotUserFacingError(t('messageEdit.noRelay'));
    session.deliverOwn(groupId, rumor);
    return { success: true };
  } catch (e) {
    if (session && sent) await session.forgetRumor(sent.groupId, sent.rumor.id).catch(() => {});
    return { success: false, error: marmotSendError(e) };
  }
}
