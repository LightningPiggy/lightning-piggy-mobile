// What the session does when a group stops being ours on this device.
//
// marmot-ts reports four ways out, and they differ in what stays on disk:
// - `left` / `destroyed`: group.destroy() has already wiped the group's stored
//   state (state row, fork-history tree, message history).
// - `removed`: someone else removed us. Only a `<gid>/removed` marker is
//   written; the group stays stored (status "removed") and a winning fork can
//   restore membership on reconverge().
// - `disbanded`: the group keeps its state too (save() is a no-op from then on).
// So only the first two may undo a save retry's write-back (#1754).

import { bytesToHex } from '@noble/hashes/utils.js';

import { forgetMarmotDeletionsForGroup } from './marmotDeletionStore';
import { toAppGroupId } from './marmotGroupIds';
import type { MarmotStateSaves } from './marmotStateSaves';

export const GROUP_EXIT_EVENTS = ['left', 'removed', 'destroyed', 'disbanded'] as const;
export type GroupExitEvent = (typeof GROUP_EXIT_EVENTS)[number];

/** True when marmot-ts has deleted the group's stored state for this event. */
export const exitWipesState = (evt: GroupExitEvent): boolean =>
  evt === 'left' || evt === 'destroyed';

export interface GroupExitDeps {
  pubkey: string;
  pushRegistration: { forgetGroup(groupIdHex: string): void };
  stateSaves: Pick<MarmotStateSaves, 'forget'>;
  welcomePayloads: { drop(groupId: string, opts: { outbox?: boolean }): Promise<void> };
  changed: () => void;
}

interface GroupExitSource {
  on(evt: GroupExitEvent, listener: (id: Uint8Array, ...rest: unknown[]) => void): unknown;
}

/** Forget a group's per-device state on each way out of it. */
export function handleGroupExits(groups: GroupExitSource, deps: GroupExitDeps): void {
  for (const evt of GROUP_EXIT_EVENTS) {
    groups.on(evt, (id) => {
      const idHex = bytesToHex(id);
      // We're out of it: forget what we published there (MIP-05 state), its
      // pending save retry, queued Welcomes and "delete for everyone" tombstones.
      deps.pushRegistration.forgetGroup(idHex);
      void deps.stateSaves.forget(idHex, { wiped: exitWipesState(evt) });
      void deps.welcomePayloads.drop(idHex, { outbox: true }).catch(() => undefined);
      void forgetMarmotDeletionsForGroup(deps.pubkey, toAppGroupId(idHex)).catch(() => undefined);
      deps.changed();
    });
  }
}
