// Is a Marmot invitation (Welcome) to a 1:1 or to a group?
//
// Every Welcome waits for Accept / Decline (marmotPendingInvitations), and
// the alert and the Messages row used to call every one a "group invitation"
// — including a 1:1, and the Welcomes a contact's other devices send when
// they add a new install of ours to an existing 1:1. A contact on several
// devices (two Lightning Piggy installs, White Noise…) sends those often.
//
// The Welcome's group says which it is before joining. A 1:1 is recognised
// by how both Lightning Piggy and White Noise create one: unnamed, with
// EXACTLY the two people as admins, and no other member account (the roster
// is read by decrypting the Welcome in memory — marmotInvitationPreview). A
// group whose creator is its sole admin, has a third admin, or has any third
// member stays a group; so does anything we can't place (no preview, no
// roster, or our own key unknown). Counted in accounts, never devices — like
// the session's isDm for a joined chat.

import { t } from '../i18n';

export interface InvitedGroup {
  name: string;
  adminPubkeys?: readonly string[];
}

/**
 * A Welcome to a 1:1 with `sender`: unnamed, admins exactly {sender, me},
 * and at most two member accounts. An unknown member count is not a 1:1:
 * an unnamed group with those two admins can still hold other members.
 */
export function isDirectInvite(
  group: InvitedGroup | null | undefined,
  sender: string,
  me?: string,
  memberCount?: number,
): boolean {
  if (!group || !me || group.name.trim() !== '') return false;
  if (memberCount === undefined || memberCount > 2) return false;
  const admins = new Set((group.adminPubkeys ?? []).map((p) => p.toLowerCase()));
  const pair = new Set([sender.toLowerCase(), me.toLowerCase()]);
  return pair.size === 2 && admins.size === 2 && [...pair].every((p) => admins.has(p));
}

/**
 * The alert for a new invitation: a 1:1 reads as a message from that person.
 * Invitations keep the copy given here (notificationService doesn't swap in
 * generic text for them), so the sender's name only shows when lock-screen
 * content is allowed.
 */
export function invitationAlert(direct: boolean, senderName: string, showContent: boolean) {
  return direct
    ? {
        kind: 'dm' as const,
        title: showContent ? senderName : t('marmotInvitation.direct'),
        body: showContent
          ? t('marmotInvitation.directNotification')
          : t('marmotInvitation.tapToAccept'),
      }
    : {
        kind: 'group' as const,
        title: t('marmotInvitation.notification'),
        body: t('marmotInvitation.notification'),
      };
}
