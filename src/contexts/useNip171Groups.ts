import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolveReadRelays } from '../services/backgroundDmReadRelays';
import {
  forgetNip171Group,
  loadNip171Groups,
  nip171GroupsFor,
  subscribeNip171Groups,
} from '../services/nip171Groups';
import { startNip171Session } from '../services/nip171Session';
import { getMemoisedSecretKey } from './nostrSecretKeyCache';
import { repairMisfiledNip171Tickets } from './nip171TicketRepair';
import type { Group } from '../types/groups';
import { nip171GroupPubkey } from '../utils/nip171';

/** Session start delay after sign-in: group delivery is not urgent, and cold
 * start is already relay-heavy (#1631). */
const SESSION_DELAY_MS = 3000;
/** The one-off ticket repair waits longer still, for relays to settle. */
const REPAIR_DELAY_MS = 20_000;

export interface Nip171GroupsApi {
  groups: Group[];
  /**
   * Leave a group: ask its owner to remove us (a NIP-17 `-` to the group
   * identity, per the draft) and forget its keys here. `sendLeaveRequest`
   * sends that DM; a failure to send still forgets the group locally.
   */
  leave: (
    groupId: string,
    sendLeaveRequest: (groupPubkey: string) => Promise<void>,
  ) => Promise<void>;
}

/** GroupsContext's NIP-171 half (member side): the groups our tickets name,
 * plus the live session that receives their messages. */
export function useNip171Groups(pubkey: string | null): Nip171GroupsApi {
  const [groups, setGroups] = useState<Group[]>([]);

  useEffect(() => {
    // An account switch must never show the previous account's groups.
    setGroups(pubkey ? nip171GroupsFor(pubkey) : []);
    if (!pubkey) return;
    let cancelled = false;
    let stop: (() => void) | null = null;
    let repairTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (!cancelled) setGroups(nip171GroupsFor(pubkey));
    };
    const unsubscribe = subscribeNip171Groups((owner) => {
      if (owner === pubkey) refresh();
    });
    const timer = setTimeout(() => {
      void loadNip171Groups(pubkey)
        .then(async () => {
          refresh();
          const relays = await resolveReadRelays(pubkey);
          if (__DEV__) {
            console.log(`[NIP-171] loaded ${nip171GroupsFor(pubkey).length} group(s)`);
          }
          if (cancelled) return;
          stop = startNip171Session(pubkey, relays);
          // Tickets an earlier build filed as 1:1 DMs (local keys only).
          repairTimer = setTimeout(() => {
            void getMemoisedSecretKey(pubkey).then(
              (secretKey) => {
                if (secretKey && !cancelled) {
                  return repairMisfiledNip171Tickets(pubkey, secretKey, relays);
                }
              },
              () => undefined,
            );
          }, REPAIR_DELAY_MS);
        })
        .catch((e) => {
          if (__DEV__) console.warn('[NIP-171] groups load failed:', e);
        });
    }, SESSION_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (repairTimer) clearTimeout(repairTimer);
      unsubscribe();
      stop?.();
    };
  }, [pubkey]);

  const leave = useCallback<Nip171GroupsApi['leave']>(
    async (groupId, sendLeaveRequest) => {
      const groupPubkey = nip171GroupPubkey(groupId);
      if (!pubkey || !groupPubkey) return;
      await sendLeaveRequest(groupPubkey).catch(() => undefined);
      await forgetNip171Group(pubkey, groupPubkey);
    },
    [pubkey],
  );

  return useMemo(() => ({ groups, leave }), [groups, leave]);
}
