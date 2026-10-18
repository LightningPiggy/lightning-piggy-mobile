import { forgetNip17GroupHistoryRepair } from './nip17GroupHistoryRepairRunner';
import { File, Paths } from 'expo-file-system';
import { deleteInstallationSignatureKey } from '../services/marmotSignatureKey';
import { deleteDmMessagesForOwner } from '../services/dmDb';
import { deleteNip171ForOwner } from '../services/nip171Store';
import { forgetNip171Account } from '../services/nip171Groups';
import { forgetRepliedPartners } from '../services/dmRepliedPartners';
import { perAccountKey } from '../services/perAccountStorage';
import {
  AMBER_NIP17_CACHE_KEY_BASE,
  NSEC_NIP17_CACHE_KEY_BASE,
  AMBER_NIP17_SKIP_KEY_BASE,
  NSEC_NIP17_SKIP_KEY_BASE,
  NIP46_NIP17_SKIP_KEY_BASE,
  wrapCacheFileName,
} from './nostrDmCache';
import { forgetDmStoreMigration, pendingDmStoreMigration } from './dmStoreMigrationRunner';
import { deleteMarmotStateForOwner } from '../services/marmotStore';
import { forgetMarmotDeletionsForOwner } from '../services/marmotDeletionStore';
import { quiesceMarmotSession } from '../services/marmotSession';
import { retireMarmotPushForAccount } from '../services/marmotPushRegistration';
import { forgetOwnLegacyDmReactions } from '../services/legacyDmReactions';

/**
 * Per-account DM-store wipe, called from NostrContext's `wipeAccountCaches`
 * on sign-out / identity removal. Decrypted DM content must not survive a
 * wipe (#689 review / #690):
 *
 *  - the file-backed NIP-17 wrap caches (legacy pre-#848 installs that
 *    haven't migrated yet) and the #743/#746 skip-set files — the skip-set
 *    holds only wrap ids, but leaving it would leak across account switches
 *    and silently suppress wraps for the next signed-in user;
 *  - this owner's rows in the encrypted DB (#848). Best-effort like the file
 *    deletes — a DB-open failure must not wedge the logout flow, and the rows
 *    are SQLCipher-encrypted at rest regardless. When the LAST identity signs
 *    out, NostrContext additionally deletes the DB file + keystore key via
 *    `wipeLocalDmStore`;
 *  - the in-session migration memo, so a re-login re-checks the per-account
 *    flag (NostrContext removes the AsyncStorage flag itself);
 *  - the session read of our legacy public DM reactions and its "none"
 *    marker, so a re-login reads them again.
 */
export async function wipeDmStoresForAccount(pubkey: string): Promise<void> {
  for (const base of [
    AMBER_NIP17_CACHE_KEY_BASE,
    NSEC_NIP17_CACHE_KEY_BASE,
    AMBER_NIP17_SKIP_KEY_BASE,
    NSEC_NIP17_SKIP_KEY_BASE,
    NIP46_NIP17_SKIP_KEY_BASE,
  ]) {
    for (const key of [
      perAccountKey(base, pubkey),
      // Pre-#288 UNSUFFIXED remnant (N9, #850) — a wrap-cache/skip file
      // written before per-account keys. Not attributable to an owner, so
      // any account's wipe removes it (content is re-fetchable from relays).
      base,
    ]) {
      try {
        const f = new File(Paths.document, wrapCacheFileName(key));
        if (f.exists) f.delete();
      } catch {
        // best-effort — non-fatal
      }
    }
  }
  // Await any in-flight migration first — wiping under it would let a late
  // upsert resurrect rows and re-set the migration flag after removal (N4).
  await pendingDmStoreMigration(pubkey)?.catch(() => {});
  await forgetNip17GroupHistoryRepair(pubkey).catch(() => {});
  forgetRepliedPartners(pubkey);
  try {
    await deleteDmMessagesForOwner(pubkey);
  } catch (e) {
    if (__DEV__) console.warn('[DmStore] per-owner DB wipe failed:', e);
  }
  // Independent of the DM rows: this account's Marmot MLS state (group
  // secrets, key-package private keys) must go even if the row wipe failed.
  try {
    // A stopped session's queued push-state writes must not land after this.
    await quiesceMarmotSession(pubkey);
    await deleteMarmotStateForOwner(pubkey);
    await forgetMarmotDeletionsForOwner(pubkey);
  } catch (e) {
    if (__DEV__) console.warn('[Marmot] per-owner state wipe failed:', e);
  }
  // NIP-171 group tickets hold epoch private keys: wipe them independently.
  await deleteNip171ForOwner(pubkey).catch((e) => {
    if (__DEV__) console.warn('[NIP-171] per-owner ticket wipe failed:', e);
  });
  // ...and the copies held in memory, plus the per-account group records.
  await forgetNip171Account(pubkey).catch(() => undefined);
  await deleteInstallationSignatureKey(pubkey);
  // Independent of the wipe above: its groups still hold this device's push
  // token (the signer is gone, so no signed removals) — delete the token at
  // Apple/Google instead (retried at next start if that fails).
  const retired = await retireMarmotPushForAccount(pubkey).catch(() => false);
  if (!retired && __DEV__)
    console.warn('[Account] push retirement incomplete (token deletion is retried at next start)');
  forgetDmStoreMigration(pubkey);
  await forgetOwnLegacyDmReactions(pubkey);
}
