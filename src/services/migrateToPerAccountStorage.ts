// One-time migration: copies legacy global AsyncStorage values to
// `${baseKey}_${activePubkey}` so the rest of the app can switch to
// the per-account namespace without losing the existing user's data.
//
// Self-contained on purpose — delete this file (and the call site in
// NostrContext) in 6 months once every install has run it. The flag
// key (`per_account_storage_migrated_v1`) intentionally lives outside
// the per-account namespace; running this twice MUST be a no-op.
//
// Behaviour summary:
//   - Runs only when an active pubkey exists. No-op for fresh installs.
//   - For each base key, copies legacy -> namespaced ONLY if (a) the
//     namespaced key is empty and (b) the legacy key has a value.
//     Skips if the namespaced key is already populated (idempotent).
//   - Does NOT delete the legacy key. The downgrade story for at least
//     one release is "old build reads the legacy global, sees the same
//     values it expected" — so keep the global copies around. The one
//     exception is the legacy `wallet_list`: once it is a pure duplicate of
//     a signed-in account's list, walletStorageService's
//     `pruneMigratedLegacyWalletList` deletes it (#1746).

import AsyncStorage from '@react-native-async-storage/async-storage';
import { PER_ACCOUNT_STORAGE_BASES, perAccountKey } from './perAccountStorage';

const MIGRATION_DONE_KEY = 'per_account_storage_migrated_v1';

export interface MigrationResult {
  ranSteps: number;
  copiedKeys: string[];
  alreadyDone: boolean;
}

// Run the migration for `activePubkey`. Safe to call on every cold
// start — guarded by the persisted `MIGRATION_DONE_KEY` flag. The
// second call (and every call after) returns `{ ranSteps: 0, ... }`
// without doing any work.
export async function migrateToPerAccountStorage(activePubkey: string): Promise<MigrationResult> {
  if (!activePubkey) return { ranSteps: 0, copiedKeys: [], alreadyDone: true };

  // Idempotency gate — we mark the migration done after a successful
  // pass so the next cold start short-circuits. If a partial pass
  // crashes between the per-key copies and the flag write, the next
  // start re-runs the per-key copies; each one is independently safe
  // (only writes the namespaced key when it's currently empty).
  const done = await AsyncStorage.getItem(MIGRATION_DONE_KEY);
  if (done === 'true') return { ranSteps: 0, copiedKeys: [], alreadyDone: true };

  const copiedKeys: string[] = [];
  for (const base of PER_ACCOUNT_STORAGE_BASES) {
    const namespacedKey = perAccountKey(base, activePubkey);
    // Skip if the namespaced key already has data — the user may have
    // ALREADY been on a multi-account-aware build (e.g. downgrade then
    // re-upgrade), in which case the namespaced value is the source of
    // truth and the legacy global is stale.
    const existingNamespaced = await AsyncStorage.getItem(namespacedKey);
    if (existingNamespaced !== null) continue;

    const legacy = await AsyncStorage.getItem(base);
    if (legacy === null) continue;

    await AsyncStorage.setItem(namespacedKey, legacy);
    copiedKeys.push(`${base} -> ${namespacedKey}`);
  }

  await AsyncStorage.setItem(MIGRATION_DONE_KEY, 'true');
  return { ranSteps: copiedKeys.length, copiedKeys, alreadyDone: false };
}

/**
 * True once the migration has completed on this device: per-account storage
 * is then the source of truth and a legacy global value (e.g. `wallet_list`)
 * may be a stale copy of some account's data. Rejects on a storage error.
 */
export async function hasMigratedToPerAccountStorage(): Promise<boolean> {
  return (await AsyncStorage.getItem(MIGRATION_DONE_KEY)) === 'true';
}

// Test/debug helper: drop the migration flag so the next call re-runs
// the migration. NOT exposed in production UI.
export async function __resetMigrationForTests(): Promise<void> {
  await AsyncStorage.removeItem(MIGRATION_DONE_KEY);
}
