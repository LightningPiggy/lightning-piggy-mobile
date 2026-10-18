import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SignerType } from '../types/nostr';
import type { DmMessageRow } from '../services/dmDb';
import { pool, trackRelays } from '../services/nostrPool';
import { querySyncAbortable } from '../services/relayQuery';
import * as amberService from '../services/amberService';
import * as nostrConnectService from '../services/nostrConnectService';
import { unwrapWrapNsec, unwrapWrapViaNip44, type DecodedRumor } from '../utils/nip17Unwrap';
import { createYieldScheduler, NIP17_LOOP_YIELD_EVERY } from './nostrDecryptPacing';
import { getMemoisedSecretKey } from './nostrSecretKeyCache';
import { nip17GroupHistoryRepairKey, repairNip17GroupHistory } from './nip17GroupHistoryRepair';

const runs = new Map<string, Promise<boolean>>();
const failedAt = new Map<string, number>();

/** Single flight per account. Failed/incomplete runs retry after a minute on
 * the next subscription arm. Persisted completion avoids later relay reads.
 */
export function ensureNip17GroupHistoryRepaired(
  owner: string,
  signer: SignerType,
  relays: string[],
  signal: AbortSignal,
  onRepaired?: (row: DmMessageRow) => void,
): Promise<boolean> {
  const existing = runs.get(owner);
  if (existing) return existing;
  if (Date.now() - (failedAt.get(owner) ?? -Infinity) < 60_000) return Promise.resolve(false);
  const run = repairNip17GroupHistory(
    owner,
    async (ids) => {
      trackRelays(relays);
      const wraps = await querySyncAbortable(
        pool,
        relays,
        { kinds: [1059], ids, '#p': [owner], limit: ids.length },
        { maxWait: 8000, signal },
      );
      const rumors = new Map<string, DecodedRumor>();
      const key = signer === 'nsec' ? await getMemoisedSecretKey(owner) : null;
      const scheduler = createYieldScheduler({
        signal,
        safetyEvery: NIP17_LOOP_YIELD_EVERY,
        coldStart: true,
      });
      try {
        for (const wrap of wraps) {
          await scheduler.maybeYield();
          if (signal.aborted) break;
          // Do not solicit interactive Amber permissions for a background repair.
          const rumor =
            signer === 'nsec'
              ? key && unwrapWrapNsec(wrap, key)
              : await unwrapWrapViaNip44(wrap, (ct, cp) =>
                  signer === 'amber'
                    ? amberService.requestNip44DecryptSilent(ct, cp, owner)
                    : nostrConnectService.requestNip44Decrypt(ct, cp, owner),
                );
          if (rumor) rumors.set(wrap.id, rumor);
        }
      } finally {
        scheduler.dispose();
      }
      return rumors;
    },
    () => signal.aborted,
    onRepaired,
  )
    .catch((error) => {
      if (__DEV__) console.warn('[DmStore] group history repair deferred:', error);
      return false;
    })
    .then((ok) => {
      if (!ok) {
        runs.delete(owner);
        failedAt.set(owner, Date.now());
      }
      return ok;
    });
  runs.set(owner, run);
  return run;
}

/** Logout waits for any writes before wiping stores/flag. */
export async function forgetNip17GroupHistoryRepair(owner: string): Promise<void> {
  await runs.get(owner);
  runs.delete(owner);
  failedAt.delete(owner);
  await AsyncStorage.removeItem(nip17GroupHistoryRepairKey(owner));
}
