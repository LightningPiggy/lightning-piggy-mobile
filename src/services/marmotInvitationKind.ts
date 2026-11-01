// Is a Marmot invitation (Welcome) to a 1:1 or to a group?
//
// Every Welcome waits for Accept / Decline (marmotPendingInvitations), and
// the alert and the Messages row used to call every one a "group invitation"
// — including a 1:1, and the Welcomes a contact's other devices send when
// they add a new install of ours to an existing 1:1. A contact on several
// devices (two Lightning Piggy installs, White Noise…) sends those often.
//
// The Welcome's group says which it is before joining: a 1:1 is unnamed and
// its admins are just the two people (Lightning Piggy and White Noise both
// make both people admins) — the same "two accounts, no name" rule the
// session uses for a joined chat (MarmotGroupSummary.isDm), counted in
// accounts, never devices.

import { t } from '../i18n';

export interface InvitedGroup {
  name: string;
  adminPubkeys?: readonly string[];
}

/** A Welcome to a 1:1 with `sender`. `me` unknown: at most one other admin. */
export function isDirectInvite(
  group: InvitedGroup | null | undefined,
  sender: string,
  me?: string,
): boolean {
  if (!group || group.name.trim() !== '') return false;
  const others = new Set((group.adminPubkeys ?? []).map((p) => p.toLowerCase()));
  others.delete(sender.toLowerCase());
  if (me) others.delete(me.toLowerCase());
  return others.size <= (me ? 0 : 1);
}

/** The alert for a new invitation: a 1:1 reads as a message from that person. */
export function invitationAlert(direct: boolean, senderName: string) {
  return direct
    ? {
        kind: 'dm' as const,
        title: senderName,
        body: t('marmotInvitation.directNotification'),
      }
    : {
        kind: 'group' as const,
        title: t('marmotInvitation.notification'),
        body: t('marmotInvitation.notification'),
      };
}
