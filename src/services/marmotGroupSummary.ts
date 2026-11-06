// A loaded Marmot group as the app sees it: the plain summary every screen,
// hook and the 1:1 choice (marmotDmChoice) read. Pure over the group's state.

import { getGroupMembers, type MarmotGroup } from '@internet-privacy/marmot-ts';

export interface MarmotGroupSummary {
  /** App group id: `marmot:<mls group id hex>`. */
  id: string;
  name: string;
  description: string;
  /** Members other than the viewer. */
  memberPubkeys: string[];
  adminPubkeys: string[];
  /** White Noise DM convention: two members, empty name. */
  isDm: boolean;
  /** Relays the group's kind-445 traffic is published to. */
  relays: string[];
  /** When this device first saw the group (ms) — MLS carries no creation time. */
  createdAt: number;
  /** Newest authenticated activity (ms), if any — ranks 1:1s (marmotDmChoice). */
  activityAt?: number;
}

type SummarisedGroup = Pick<MarmotGroup, 'groupData' | 'state' | 'relays' | 'idStr'>;

export function summariseGroup(
  g: SummarisedGroup,
  ctx: {
    /** The app id for `g` (`toAppGroupId`). */
    id: string;
    viewer: string;
    firstSeen: ReadonlyMap<string, number>;
    /** Newest authenticated activity per MLS group id (ms) — GroupActivity. */
    activity: ReadonlyMap<string, number>;
  },
): MarmotGroupSummary {
  const view = g.groupData;
  const me = ctx.viewer.toLowerCase();
  const members = getGroupMembers(g.state).map((p) => p.toLowerCase());
  const name = view?.name ?? '';
  return {
    id: ctx.id,
    name,
    description: view?.description ?? '',
    memberPubkeys: members.filter((p) => p !== me),
    adminPubkeys: (view?.adminPubkeys ?? []).map((p) => p.toLowerCase()),
    // White Noise DM: unnamed, two ACCOUNTS — `members` is distinct pubkeys,
    // so a contact on several devices (3+ leaves) is still a DM. ≤2 so a DM
    // mid-creation (just us, invite not yet committed) never flashes up as
    // a 1-member group.
    isDm: name === '' && members.length <= 2,
    relays: g.relays ?? [],
    createdAt: ctx.firstSeen.get(g.idStr) ?? Date.now(),
    activityAt: ctx.activity.get(g.idStr),
  };
}
