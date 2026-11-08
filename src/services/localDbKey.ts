import * as SecureStore from 'expo-secure-store';
import { bytesToHex } from '@noble/hashes/utils.js';

// 256-bit symmetric key that encrypts the local SQLCipher database at
// rest (#695 / #690). The DB holds private DMs (decrypted NIP-17 rumors)
// AND public nostr events we cache for offline paint — geo-caches, NIP-52
// events, places. Encrypting the public rows too costs little and keeps
// device-level metadata private (which caches you've viewed reveals where
// you've been looking). The key lives in expo-secure-store — the OS
// keystore (Android Keystore / iOS Keychain), hardware-backed where the
// device supports it — so the DB file on disk is ciphertext and this key
// only ever sits in RAM at runtime. It's the only piece small enough to
// belong in the keystore; the bulk data lives in the encrypted DB file.
const LOCAL_DB_KEY_STORE_KEY = 'local_db_key_v1';
const LOCAL_DB_KEY_BYTES = 32;
const HEX_64 = /^[0-9a-f]{64}$/i;

// AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: never included in iCloud / device-
// migration backups, readable only after first unlock post-reboot. Mirrors
// walletStorageService / identitiesStore — the DB key is at least as
// sensitive as a wallet credential, so it gets the same hardening.
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

let keyPromise: Promise<string> | null = null;

function generateKey(): string {
  const bytes = new Uint8Array(LOCAL_DB_KEY_BYTES);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function resolveKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(LOCAL_DB_KEY_STORE_KEY);
  // Validate before trusting it: a corrupted / wrong-length value would
  // make SQLCipher fail to open with a cryptic error. Regenerate +
  // overwrite instead (pattern mirrors identitiesStore's hex guard).
  // SAFETY (#710 L1): regenerating on a corrupt key is only safe while the DB
  // holds rebuildable-from-relays *cache* data. Before recovery-critical rows
  // (transactions / swaps, #695) land, revisit — a regenerated key would
  // orphan data that can't be re-fetched.
  if (existing && HEX_64.test(existing)) return existing;
  const key = generateKey();
  await SecureStore.setItemAsync(LOCAL_DB_KEY_STORE_KEY, key, SECURE_OPTIONS);
  return key;
}

/**
 * The DB encryption key as 64-char hex, generating + persisting a fresh
 * random one on first call. Idempotent — later calls return the same key
 * so the encrypted DB opens consistently across launches.
 *
 * Single-flight: concurrent first-run callers share one generation so two
 * racing calls can't each mint + persist a different key (last write wins)
 * and leave the DB unopenable with the other. On failure the cached
 * promise is cleared so a transient SecureStore / IO error can be retried
 * rather than wedging every future call on the same rejection.
 */
export function getOrCreateLocalDbKey(): Promise<string> {
  if (!keyPromise) {
    keyPromise = resolveKey().catch((e) => {
      keyPromise = null;
      throw e;
    });
  }
  return keyPromise;
}

/**
 * Whether a usable DB key is already stored. Never creates one: lets the
 * launch-time DB pre-open skip installs that have never opened the DB (fresh,
 * or wiped on logout), so it can't mint a key + file before sign-in.
 */
export async function hasLocalDbKey(): Promise<boolean> {
  if (keyPromise) return true;
  const existing = await SecureStore.getItemAsync(LOCAL_DB_KEY_STORE_KEY);
  return !!existing && HEX_64.test(existing);
}

/**
 * Delete the DB key on logout / account wipe. The encrypted DB file is
 * unreadable without it and must be deleted alongside this (#690) — a
 * lone key or a lone ciphertext file is useless, but don't leave either
 * lying around.
 */
export async function clearLocalDbKey(): Promise<void> {
  keyPromise = null;
  await SecureStore.deleteItemAsync(LOCAL_DB_KEY_STORE_KEY);
}
