import * as SecureStore from 'expo-secure-store';
import * as nostrService from '../services/nostrService';
import {
  loadIdentities,
  upsertIdentity,
  type IdentitiesBlob,
  type StoredIdentity,
} from '../services/identitiesStore';
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

/** Defer a read's failure to the point its value is actually used. */
function settle<T>(read: Promise<T>): Promise<() => T> {
  return read.then(
    (value) => () => value,
    (error: unknown) => () => {
      throw error;
    },
  );
}

/**
 * Read the multi-account registry and every legacy active-identity slot in
 * one concurrent round instead of three serial SecureStore hops. Only the
 * slot matching the stored signer type is used; a failed read of an unused
 * slot is ignored, exactly as when it was never read.
 */
export async function readStoredLogin(): Promise<StoredLogin> {
  const t0 = Date.now();
  const [blob, signerType, nsecSlot, pubkeySlot, nip46Slot] = await Promise.all([
    loadIdentities(),
    SecureStore.getItemAsync(SIGNER_TYPE_KEY),
    settle(SecureStore.getItemAsync(NSEC_KEY)),
    settle(SecureStore.getItemAsync(PUBKEY_KEY)),
    settle(SecureStore.getItemAsync(NIP46_CONNECTION_KEY)),
  ]);
  perfLog(`identity reads done signer=${signerType ?? 'none'} in ${Date.now() - t0}ms`);
  const identities = blob.identities;
  if (signerType === 'nsec') {
    const nsec = nsecSlot();
    if (!nsec) return { identities, session: null };
    return {
      identities,
      session: { pubkey: nostrService.decodeNsec(nsec).pubkey, signerType, nsec },
    };
  }
  if (signerType === 'amber') {
    const pubkey = pubkeySlot();
    return { identities, session: pubkey ? { pubkey, signerType, nsec: null } : null };
  }
  if (signerType === 'nip46') {
    // Restore the persisted bunker connection (see useNip46Login).
    const pubkey = await restoreNip46Session(nip46Slot());
    return { identities, session: pubkey ? { pubkey, signerType, nsec: null } : null };
  }
  return { identities, session: null };
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
