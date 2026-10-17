import type { Group } from '../types/groups';
import { DM_PROTOCOL_LABEL, type DmProtocol } from './dmProtocol';

/** A group's transport: a 1:1 protocol, or NIP-171 (groups only). */
export type GroupProtocol = DmProtocol | 'nip171';

export const GROUP_PROTOCOL_LABEL: Record<GroupProtocol, string> = {
  ...DM_PROTOCOL_LABEL,
  nip171: 'NIP-171',
};

/** A group's transport, fixed at creation: Marmot (MLS) groups carry
 * `protocol: 'marmot'`, NIP-171 groups `'nip171'`; an absent field means a
 * NIP-17 group. Shared by the Messages-list row tag and the group chat header
 * so the two always agree. */
export function groupDmProtocol(group: Pick<Group, 'protocol'>): GroupProtocol {
  return group.protocol ?? 'nip17';
}
