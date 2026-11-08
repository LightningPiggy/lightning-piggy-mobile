import * as SecureStore from 'expo-secure-store';
import * as nostrService from '../services/nostrService';
import {
  loadIdentities,
  upsertIdentity,
  type IdentitiesBlob,
  type StoredIdentity,
} from '../services/identitiesStore';
import { migrateToPerAccountStorage } from '../services/migrateToPerAccountStorage';
import { resolveStartupWalletOwner } from '../services/walletStorageService';
import type { SignerType } from '../types/nostr';
import { perfLog } from '../utils/perfLog';
import { NIP46_CONNECTION_KEY, NSEC_KEY, PUBKEY_KEY, SIGNER_TYPE_KEY } from './nostrAuthKeys';
import { restoreNip46Session } from './useNip46Login';

/** What cold-start auto-login found in SecureStore. */
export interface StoredLogin {
  identities: StoredIdentity[];
  /** The restored session, or null when logged out (or the slots are unusable). */
  session: { pubkey: string; signerType: SignerType; nsec: string | null } | null;
}

// The one legacy slot each signer restores from.
const SIGNER_SLOT: Record<SignerType, string> = {
  nsec: NSEC_KEY,
  amber: PUBKEY_KEY,
  nip46: NIP46_CONNECTION_KEY,
};
function isSignerType(value: string | null): value is SignerType {
  return value === 'nsec' || value === 'amber' || value === 'nip46';
}

/**
 * Read the multi-account registry alongside the signer type → that signer's
 * slot chain: two SecureStore hops on the critical path instead of three
 * serial ones. Only the active signer's slot is read, so another signer's
 * secret (a stale nsec, a NIP-46 client key) never enters JS memory.
 * `isCurrent` false (the restore was superseded) skips installing a NIP-46
 * bunker connection.
 */
export async function readStoredLogin(isCurrent: () => boolean = () => true): Promise<StoredLogin> {
  const t0 = Date.now();
  const readSigner = async () => {
    const signerType = await SecureStore.getItemAsync(SIGNER_TYPE_KEY);
    if (!isSignerType(signerType)) return null;
    return { signerType, slot: await SecureStore.getItemAsync(SIGNER_SLOT[signerType]) };
  };
  const [blob, signer] = await Promise.all([loadIdentities(), readSigner()]);
  perfLog(`identity reads done signer=${signer?.signerType ?? 'none'} in ${Date.now() - t0}ms`);
  const identities = blob.identities;
  if (!signer) return { identities, session: null };
  const { signerType, slot } = signer;
  if (signerType === 'nsec') {
    if (!slot) return { identities, session: null };
    return {
      identities,
      session: { pubkey: nostrService.decodeNsec(slot).pubkey, signerType, nsec: slot },
    };
  }
  // Amber: the slot is the pubkey. NIP-46: restore the persisted bunker
  // connection from it (see useNip46Login).
  const pubkey = signerType === 'amber' ? slot : await restoreNip46Session(slot, isCurrent);
  return { identities, session: pubkey ? { pubkey, signerType, nsec: null } : null };
}

/**
 * Cold-start auto-login's read. When it ends without an account (logged out,
 * or the slots are unreadable) the wallet gate opens signed-out immediately
 * rather than after its 2 s timeout. A found account is handed to the gate
 * by the caller, once that account's storage migration has run. A read
 * superseded by a newer login, logout or switch reports nothing to the gate:
 * "no session" then means "not this restore's call", not "signed out".
 */
export async function readStartupLogin(
  isCurrent: () => boolean = () => true,
): Promise<StoredLogin> {
  try {
    const login = await readStoredLogin(isCurrent);
    if (!login.session && isCurrent()) resolveStartupWalletOwner(null);
    return login;
  } catch (error) {
    if (isCurrent()) resolveStartupWalletOwner(null);
    throw error;
  }
}

/**
 * Hand a restored session's account to the wallet gate and publish it, unless
 * a login, logout or switch superseded this auto-login while it read
 * SecureStore and migrated (#1746): then it is dropped and false returned.
 *
 * The one-time per-account storage migration (#288) MUST run first:
 * WalletContext's startup reads `wallet_list_${pk}` as soon as the gate opens
 * for `pk`, so migrating later would let it read before the legacy
 * `wallet_list` was copied there (#442). The gate opens on the publish (in
 * useActiveNostrAccount's layout effect). The migration runs once, sets a
 * flag and short-circuits afterwards (<50 ms of cold start).
 */
export async function publishRestoredSession(
  pk: string,
  isCurrent: () => boolean,
  publish: (pk: string) => void,
): Promise<boolean> {
  try {
    const result = await migrateToPerAccountStorage(pk);
    if (__DEV__ && !result.alreadyDone) {
      console.log(
        `[Nostr] per-account storage migration: copied ${result.ranSteps} keys`,
        result.copiedKeys,
      );
    }
  } catch (e) {
    console.warn('[Nostr] per-account storage migration failed:', e);
  }
  if (!isCurrent()) {
    perfLog('auto-login superseded by a newer login, logout or switch: session dropped');
    return false;
  }
  resolveStartupWalletOwner(pk);
  publish(pk);
  return true;
}

/**
 * Backfill the multi-account registry for an nsec / Amber session restored
 * from the legacy slots but missing from it. NIP-46 sessions aren't in the
 * registry. Returns the updated blob, or null when nothing was written.
 */
export async function registerRestoredSession(login: StoredLogin): Promise<IdentitiesBlob | null> {
  const { session, identities } = login;
  if (!session || session.signerType === 'nip46') return null;
  if (identities.some((i) => i.pubkey === session.pubkey)) return null;
  if (session.signerType === 'nsec') {
    if (!session.nsec) return null;
    return upsertIdentity({
      pubkey: session.pubkey,
      signerType: 'nsec',
      nsec: session.nsec,
      lastUsedAt: Date.now(),
    });
  }
  return upsertIdentity({ pubkey: session.pubkey, signerType: 'amber', lastUsedAt: Date.now() });
}
