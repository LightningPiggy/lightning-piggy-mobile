import { useCallback } from 'react';
import { InteractionManager } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as nostrConnectService from '../services/nostrConnectService';
import { migrateToPerAccountStorage } from '../services/migrateToPerAccountStorage';
import { syncBackgroundDmWatchFromPreference } from '../services/backgroundDmService';
import {
  PUBKEY_KEY,
  SIGNER_TYPE_KEY,
  NIP46_CONNECTION_KEY,
  LEGACY_IDENTITY_SECURE_OPTIONS,
} from './nostrAuthKeys';
import { isValidNip46Connection } from '../utils/nip46Connection';
import type { SignerType, Nip46Connection } from '../types/nostr';

/**
 * NIP-46 ("Nostr Connect" / bunker) login, extracted from NostrContext (#283)
 * to keep that over-cap file from growing. The QR scan + ack handshake happens
 * in NostrLoginSheet (it owns the per-app keypair, the URI build, and the
 * await-for-bunker round-trip); by the time this runs, `nostrConnectService`
 * already holds a live BunkerSigner and the connection is ready to persist.
 *
 * Mirrors `loginWithAmber`'s shape — same post-login background refresh +
 * per-account migration — so the auto-login effect resumes it on next cold
 * start. It does NOT route through `persistActiveIdentityKeys` / the
 * multi-account registry: that layer's `StoredSignerType` only models
 * nsec/amber (a keyless bunker connection doesn't fit the inline-nsec slot),
 * so the NIP-46 session persists via its own SecureStore keys
 * (`PUBKEY_KEY` + `NIP46_CONNECTION_KEY` + `SIGNER_TYPE_KEY`).
 */
/**
 * Restore a persisted NIP-46 session on cold start: read the stored connection
 * from SecureStore, re-assert it as the active BunkerSigner, and return the
 * logged-in pubkey (or null if there's nothing to restore / the blob is
 * corrupt). Called from NostrContext's auto-login effect — the counterpart to
 * the SecureStore writes `useNip46Login` makes on sign-in.
 *
 * `storedConn` lets cold start pass a connection it already read alongside
 * the other identity slots; when omitted, it's read here.
 */
export async function restoreNip46Session(storedConn?: string | null): Promise<string | null> {
  const storedConnRaw =
    storedConn === undefined ? await SecureStore.getItemAsync(NIP46_CONNECTION_KEY) : storedConn;
  if (!storedConnRaw) {
    // signer-type says nip46 but the connection object is gone (partial wipe)
    // — clear the stale slot so we don't repeat this no-op on every cold start.
    await SecureStore.deleteItemAsync(SIGNER_TYPE_KEY);
    return null;
  }
  try {
    const parsed = JSON.parse(storedConnRaw) as unknown;
    // Validate shape before trusting it — a partially-written or wrong-shape
    // blob (e.g. `{}`) is JSON-parsable but would install a connection with
    // undefined signer/relay fields and return `undefined` as the pubkey.
    // Treat it exactly like a corrupt blob (self-heal in the catch below).
    if (!isValidNip46Connection(parsed)) {
      throw new Error('stored NIP-46 connection has an invalid shape');
    }
    const conn = parsed;
    await nostrConnectService.setActiveConnection(conn);
    // `conn.userPubkey` is the source of truth (Copilot review): if the legacy
    // PUBKEY_KEY slot ever diverged (partial write, migration, manual edit),
    // the bunker would sign as conn.userPubkey while state pointed elsewhere.
    return conn.userPubkey;
  } catch (e) {
    if (__DEV__) console.warn('[Nostr] NIP-46 connection hydrate failed:', e);
    // Corrupt blob — clear the nip46 slots so a bad SecureStore state
    // self-heals on next cold start rather than looping the same bad hydrate.
    await SecureStore.deleteItemAsync(NIP46_CONNECTION_KEY);
    await SecureStore.deleteItemAsync(SIGNER_TYPE_KEY);
    await nostrConnectService.setActiveConnection(null).catch(() => {});
    return null;
  }
}

export interface UseNip46LoginDeps {
  setIsLoggingIn: (v: boolean) => void;
  setPubkey: (v: string | null) => void;
  setSignerType: (v: SignerType | null) => void;
  setIsLoggedIn: (v: boolean) => void;
  loadRelays: (pk: string) => Promise<string[]>;
  loadProfile: (pk: string, relays: string[]) => Promise<unknown>;
  loadContacts: (pk: string, relays: string[]) => Promise<unknown>;
  loadContactsFromCache: (pk: string) => Promise<unknown>;
  hydrateDmInboxFromCache: (pk: string) => Promise<unknown>;
}

export function useNip46Login(deps: UseNip46LoginDeps) {
  const {
    setIsLoggingIn,
    setPubkey,
    setSignerType,
    setIsLoggedIn,
    loadRelays,
    loadProfile,
    loadContacts,
    loadContactsFromCache,
    hydrateDmInboxFromCache,
  } = deps;

  return useCallback(
    async (connection: Nip46Connection): Promise<{ success: boolean; error?: string }> => {
      setIsLoggingIn(true);
      try {
        const pk = connection.userPubkey;
        setPubkey(pk);
        // The connection blob embeds a per-app private key (`clientSecretKeyHex`)
        // that can sign against the bunker, so harden all three writes with
        // AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY (via LEGACY_IDENTITY_SECURE_OPTIONS):
        // keeps them off iCloud/device backups and from migrating to a new device.
        await SecureStore.setItemAsync(PUBKEY_KEY, pk, LEGACY_IDENTITY_SECURE_OPTIONS);
        await SecureStore.setItemAsync(
          NIP46_CONNECTION_KEY,
          JSON.stringify(connection),
          LEGACY_IDENTITY_SECURE_OPTIONS,
        );
        await SecureStore.setItemAsync(SIGNER_TYPE_KEY, 'nip46', LEGACY_IDENTITY_SECURE_OPTIONS);

        // The pairing flow already populated nostrConnectService's in-memory
        // cache via `awaitBunkerPair`; re-asserting here is cheap + idempotent.
        await nostrConnectService.setActiveConnection(connection);

        setSignerType('nip46');
        setIsLoggedIn(true);
        setIsLoggingIn(false);

        // Mirror the amber/nsec login: restart the background watch if enabled.
        void syncBackgroundDmWatchFromPreference().catch((e) => {
          if (__DEV__) console.warn('[Nostr] post-login watch sync failed:', e);
        });
        try {
          await migrateToPerAccountStorage(pk);
        } catch (e) {
          if (__DEV__) console.warn('[Nostr] per-account migration on login failed:', e);
        }

        await loadContactsFromCache(pk);
        await hydrateDmInboxFromCache(pk);
        InteractionManager.runAfterInteractions(async () => {
          try {
            const readRelays = await loadRelays(pk);
            await loadProfile(pk, readRelays);
            loadContacts(pk, readRelays).catch((e) =>
              console.warn('Background contact refresh failed:', e),
            );
          } catch (error) {
            console.warn('NIP-46 post-login refresh failed:', error);
          }
        });

        return { success: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'NIP-46 login failed';
        return { success: false, error: message };
      } finally {
        setIsLoggingIn(false);
      }
    },
    [
      setIsLoggingIn,
      setPubkey,
      setSignerType,
      setIsLoggedIn,
      loadRelays,
      loadProfile,
      loadContacts,
      loadContactsFromCache,
      hydrateDmInboxFromCache,
    ],
  );
}
