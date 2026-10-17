import { deleteDmMessagesByIds, selectDmEventIdsOfKind } from '../services/dmDb';
import { ingestNip171Ticket } from '../services/nip171Groups';
import { pool, type RawGiftWrapEvent } from '../services/nostrService';
import { querySyncAbortable } from '../services/relayQuery';
import { NIP171_TICKET_KIND } from '../utils/nip171';
import { unwrapWrapNsec } from '../utils/nip17Unwrap';

const repaired = new Set<string>();

/**
 * Before NIP-171 support, a group's `kind:1014` ticket was filed as a 1:1 DM
 * row with the group identity ("Unsupported message type"), and the DM
 * store's decrypt-once gate never reads that wrap again. Re-fetch those
 * wraps by id, take their tickets, and remove the stray rows. Once per
 * account per app session; local keys only (a remote signer would prompt).
 */
export async function repairMisfiledNip171Tickets(
  owner: string,
  secretKey: Uint8Array,
  relays: string[],
): Promise<number> {
  if (repaired.has(owner)) return 0;
  repaired.add(owner);
  try {
    const ids = await selectDmEventIdsOfKind(owner, NIP171_TICKET_KIND);
    if (ids.length === 0 || relays.length === 0) {
      // Nothing to do yet (the store migration may not have run): let a
      // later mount or account switch try again.
      repaired.delete(owner);
      return 0;
    }
    const wraps = (await querySyncAbortable(
      pool,
      relays,
      { kinds: [1059], ids, limit: ids.length },
      { maxWait: 6000 },
    )) as RawGiftWrapEvent[];
    const wanted = new Set(ids);
    const recovered: string[] = [];
    for (const wrap of wraps) {
      if (!wanted.has(wrap.id)) continue;
      const rumor = unwrapWrapNsec(wrap, secretKey);
      if (rumor && (await ingestNip171Ticket(owner, rumor))) recovered.push(wrap.id);
    }
    if (__DEV__) {
      console.log(`[NIP-171] ticket repair: rows=${ids.length} recovered=${recovered.length}`);
    }
    // Only rows whose ticket we now hold: a wrap the relays didn't return
    // this time (busy, or a relay offline) is retried on the next launch.
    if (recovered.length) await deleteDmMessagesByIds(owner, recovered);
    return recovered.length;
  } catch (e) {
    repaired.delete(owner);
    if (__DEV__) console.warn('[NIP-171] ticket repair failed:', e);
    return 0;
  }
}
