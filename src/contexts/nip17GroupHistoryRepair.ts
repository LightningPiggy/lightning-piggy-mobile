import AsyncStorage from '@react-native-async-storage/async-storage';
import { loadGroups } from '../services/groupsStorageService';
import {
  loadGroupMessages,
  removeGroupMessagesWhere,
} from '../services/groupMessagesStorageService';
import { importRepairedDmMessage, type DmMessageRow } from '../services/dmDb';
import { classifyRumor, rumorEventId, textForRumor, type DecodedRumor } from '../utils/nip17Unwrap';
import { createYieldScheduler, NIP17_LOOP_YIELD_EVERY } from './nostrDecryptPacing';
import { notifyDmMessage, notifyGroupMessage } from './nostrEventBus';

export const nip17GroupHistoryRepairKey = (owner: string): string =>
  `nip17_group_history_repaired_v1_${owner}`;
export const GROUP_HISTORY_REPAIR_BATCH = 20;

/** Legacy group logs kept display text, not rumor tags. Never infer a routing
 * decision from text or the current roster: require the authenticated rumor.
 * Write the DM first, then remove its group copy, then flag completion. A crash
 * between stores is safe to retry; the SQL import deduplicates wrap AND rumor ids.
 */
export async function repairNip17GroupHistory(
  owner: string,
  resolveRumors: (ids: string[]) => Promise<Map<string, DecodedRumor>>,
  shouldAbort: () => boolean = () => false,
  onRepaired: (row: DmMessageRow) => void = () => {},
): Promise<boolean> {
  if ((await AsyncStorage.getItem(nip17GroupHistoryRepairKey(owner))) === '1') return true;
  const scheduler = createYieldScheduler({ safetyEvery: NIP17_LOOP_YIELD_EVERY, coldStart: true });
  let complete = true;
  try {
    for (const group of await loadGroups(owner, { strict: true })) {
      await scheduler.maybeYield();
      if (shouldAbort()) return false;
      // Marmot has a separate wire identity and storage policy. Larger rooms
      // cannot be the two-person collision this migration repairs.
      const others = new Set(group.memberPubkeys.map((pk) => pk.toLowerCase()));
      others.delete(owner.toLowerCase());
      if (group.protocol === 'marmot' || group.id.startsWith('marmot:') || others.size !== 1)
        continue;
      const messages = (await loadGroupMessages(owner, group.id, { strict: true })).filter((m) =>
        /^[0-9a-f]{64}$/.test(m.id),
      );
      for (let i = 0; i < messages.length; i += GROUP_HISTORY_REPAIR_BATCH) {
        if (shouldAbort()) return false;
        const batch = messages.slice(i, i + GROUP_HISTORY_REPAIR_BATCH);
        const rumors = await resolveRumors(batch.map((m) => m.id));
        const removed = new Set<string>();
        for (const message of batch) {
          await scheduler.maybeYield();
          if (shouldAbort()) return false;
          const rumor = rumors.get(message.id);
          if (!rumor) {
            complete = false; // offline / signer denial: retain history and retry later
            continue;
          }
          const cls = classifyRumor(rumor, owner);
          if (
            cls?.type !== 'dm' ||
            (rumor.kind !== 14 && rumor.kind !== 15) ||
            !others.has(cls.partnerPubkey) ||
            rumor.pubkey.toLowerCase() !== message.senderPubkey.toLowerCase()
          )
            continue;
          const row: DmMessageRow = {
            owner,
            eventId: message.id,
            rumorId: rumorEventId(rumor),
            conversation: cls.partnerPubkey,
            createdAt: rumor.created_at,
            sender: rumor.pubkey.toLowerCase(),
            content: textForRumor(rumor),
            fromMe: cls.fromMe,
            wireKind: rumor.kind,
          };
          await importRepairedDmMessage(row);
          if (shouldAbort()) return false;
          onRepaired(row);
          removed.add(message.id);
          notifyDmMessage(cls.partnerPubkey);
        }
        if (removed.size) {
          if (shouldAbort()) return false;
          await removeGroupMessagesWhere(owner, group.id, (m) => removed.has(m.id), {
            strict: true,
          });
          // Rebuild the preview/mention rollup from the repaired log, too.
          await AsyncStorage.removeItem(`nostr_group_activity_${owner}`);
          notifyGroupMessage(group.id);
        }
      }
    }
    if (shouldAbort()) return false;
    if (complete) await AsyncStorage.setItem(nip17GroupHistoryRepairKey(owner), '1');
    return complete;
  } finally {
    scheduler.dispose();
  }
}
