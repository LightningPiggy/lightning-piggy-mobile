import { getConversationForRumorIds } from '../services/dmDb';
import { eTagTargets, isChatReactionKind } from '../utils/nip17Reactions';
import type { DecodedRumor } from '../utils/nip17Unwrap';

type Partnership = { partnerPubkey: string; fromMe: boolean } | null;

/**
 * Which chat our own wrapped reaction / retraction belongs to (#1321).
 * Lightning Piggy tags the peer, but another client on the same account may
 * send only NIP-09's `e` / `k` (a retraction) or tag only us (a reaction to
 * our own message). Those are placed by the message or reaction they name;
 * anything else keeps `partnerFromRumor`'s answer.
 */
export async function placeOwnChatReaction(
  rumor: DecodedRumor,
  owner: string,
  partnership: Partnership,
): Promise<Partnership> {
  const me = owner.toLowerCase();
  if (!isChatReactionKind(rumor.kind) || rumor.pubkey?.toLowerCase() !== me) return partnership;
  if (partnership && partnership.partnerPubkey !== me) return partnership;
  const conversation = await getConversationForRumorIds(me, eTagTargets(rumor)).catch(() => null);
  return conversation ? { partnerPubkey: conversation, fromMe: true } : partnership;
}
