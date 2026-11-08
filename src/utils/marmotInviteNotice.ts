import { t } from '../i18n';
import type { InviteStatus } from '../services/marmotWelcomePayloads';
import type { SignerType } from '../types/nostr';

/** The people an invite didn't reach yet (MarmotSession's InviteOutcome). */
export interface UndeliveredInvites {
  undelivered: readonly string[];
  /** Of those, the ones who publish no inbox relays yet (#1402). */
  waitingForRelays: readonly string[];
  /** …and the ones whose invitation our signer declined or didn't answer. */
  needsSigner?: readonly string[];
}

/**
 * Amber / NIP-46: queued invitations are only signed from a send in the chat,
 * never in the background (#1402) — so their copy can't promise
 * "automatically". Local keys sign silently and are retried in the background.
 */
export const isRemoteSigner = (signerType: SignerType | null | undefined): boolean =>
  signerType === 'amber' || signerType === 'nip46';

/** `key`, or its `…Remote` variant for a remote signer. */
const forSigner = (key: string, remoteSigner: boolean) => (remoteSigner ? `${key}Remote` : key);

/** The members-sheet line for a member whose invitation hasn't arrived. */
export function inviteStatusTextKey(status: InviteStatus, remoteSigner: boolean): string {
  // Only a remote signer can decline or go quiet: one wording.
  if (status === 'needsSigner') return 'groupMembersSheet.inviteNeedsSigner';
  return forSigner(
    status === 'waitingForRelays'
      ? 'groupMembersSheet.inviteWaitingForRelays'
      : 'groupMembersSheet.invitePending',
    remoteSigner,
  );
}

/**
 * The "not delivered yet" notice after creating a chat or adding members, or
 * null when everyone was reached. People waiting on their own inbox relays
 * are named apart from the rest: their invitation goes out once they publish
 * some, the others' on the next retry — automatic with a local key, the next
 * send in the chat with a remote signer.
 */
export function undeliveredInviteNotice(
  outcome: UndeliveredInvites,
  nameOf: (pubkey: string) => string,
  remoteSigner = false,
): { title: string; body: string } | null {
  if (outcome.undelivered.length === 0) return null;
  const waiting = new Set(outcome.waitingForRelays);
  const signer = new Set(outcome.needsSigner ?? []);
  const names = (people: readonly string[]) => people.map(nameOf).join(', ');
  const signed = outcome.undelivered.filter((p) => signer.has(p));
  const relays = outcome.undelivered.filter((p) => waiting.has(p) && !signer.has(p));
  const others = outcome.undelivered.filter((p) => !waiting.has(p) && !signer.has(p));
  const body = [
    signed.length > 0 ? t('marmotInvite.needsSignerBody', { names: names(signed) }) : null,
    others.length > 0
      ? t(forSigner('marmotInvite.notReachedBody', remoteSigner), { names: names(others) })
      : null,
    relays.length > 0
      ? t(
          forSigner(
            relays.length === 1
              ? 'marmotInvite.waitingForRelaysBodyOne'
              : 'marmotInvite.waitingForRelaysBodyOther',
            remoteSigner,
          ),
          { names: names(relays) },
        )
      : null,
  ]
    .filter(Boolean)
    .join(' ');
  return { title: t('marmotInvite.notReachedTitle'), body };
}
