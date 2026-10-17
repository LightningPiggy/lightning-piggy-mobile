import { ingestNip171Ticket, isNip171GroupIdentity } from '../services/nip171Groups';
import { isNip171GroupRumor, NIP171_TICKET_KIND } from '../utils/nip171';
import type { DecodedRumor } from '../utils/nip17Unwrap';

/**
 * A rumor in our own NIP-17 inbox that belongs to NIP-171 rather than to a
 * 1:1 chat: a group's epoch ticket (stored as the group's keys), a group
 * message that reached us directly, or a 1:1 rumor with a group identity
 * (our own join / leave request's self-copy). True = handled; the caller
 * shows nothing for it.
 */
export async function routeNip171Rumor(rumor: DecodedRumor, owner: string): Promise<boolean> {
  if (rumor.kind === NIP171_TICKET_KIND) {
    await ingestNip171Ticket(owner, rumor);
    return true;
  }
  if (isNip171GroupRumor(rumor)) return true;
  const me = owner.toLowerCase();
  const sender = rumor.pubkey?.toLowerCase() ?? '';
  const tags = Array.isArray(rumor.tags) ? rumor.tags : [];
  const partner =
    sender === me
      ? tags.find((t) => t[0] === 'p' && t[1]?.toLowerCase() !== me)?.[1]?.toLowerCase()
      : sender;
  return !!partner && isNip171GroupIdentity(owner, partner);
}

/** The same test without side effects, for paths that only notify. */
export function isNip171InboxRumor(rumor: DecodedRumor): boolean {
  return rumor.kind === NIP171_TICKET_KIND || isNip171GroupRumor(rumor);
}
