import { Platform } from 'react-native';
import * as nip19 from 'nostr-tools/nip19';
import * as AmberSigner from '../../modules/amber-signer';
import { AMBER_PERMISSIONS_JSON } from './signerPermissions';
import { AmberSignerError, toAmberSignerError } from './amberErrors';

/**
 * Runs an Amber call that may launch an approval Intent, rethrowing any
 * failure as a typed `AmberSignerError` (declined / no-response / busy / …)
 * whose message is the user-facing copy — see amberErrors.ts (#1186).
 */
async function viaAmber<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    throw toAmberSignerError(e);
  }
}

/**
 * Amber answers Reject with RESULT_OK and an empty payload rather than a
 * cancelled result (seen on Amber 6.6.7), so an empty answer is the user
 * declining — never a success to hand on (#1186).
 */
function requireAnswer(answer: string | undefined): string {
  if (answer) return answer;
  throw new AmberSignerError('CANCELLED', 'declined', 'Amber returned an empty answer (rejected)');
}

export function isAmberSupported(): boolean {
  return Platform.OS === 'android';
}

export async function requestPublicKey(): Promise<string> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const result = await viaAmber(() => AmberSigner.getPublicKey(AMBER_PERMISSIONS_JSON));
  let pk = requireAnswer(result.pubkey);

  // Amber may return npub (bech32) instead of hex — convert if needed
  if (pk.startsWith('npub1')) {
    const decoded = nip19.decode(pk);
    if (decoded.type === 'npub') {
      pk = decoded.data;
    }
  }

  return pk;
}

export async function requestEventSignature(
  eventJson: string,
  eventId: string,
  currentUser: string,
): Promise<{ signature: string; event: string }> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const result = await viaAmber(() => AmberSigner.signEvent(eventJson, eventId, currentUser));
  // Either field proves Amber signed; both empty is a Reject.
  requireAnswer(result.event || result.signature);
  return { signature: result.signature, event: result.event };
}

export async function requestNip04Encrypt(
  plaintext: string,
  recipientPubkey: string,
  currentUser: string,
): Promise<string> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const { result } = await viaAmber(() =>
    AmberSigner.nip04Encrypt(plaintext, recipientPubkey, currentUser),
  );
  return requireAnswer(result);
}

export async function requestNip04Decrypt(
  ciphertext: string,
  senderPubkey: string,
  currentUser: string,
): Promise<string> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const { result } = await viaAmber(() =>
    AmberSigner.nip04Decrypt(ciphertext, senderPubkey, currentUser),
  );
  return requireAnswer(result);
}

export async function requestNip44Encrypt(
  plaintext: string,
  recipientPubkey: string,
  currentUser: string,
): Promise<string> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const { result } = await viaAmber(() =>
    AmberSigner.nip44Encrypt(plaintext, recipientPubkey, currentUser),
  );
  return requireAnswer(result);
}

export async function requestNip44Decrypt(
  ciphertext: string,
  senderPubkey: string,
  currentUser: string,
): Promise<string> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const { result } = await viaAmber(() =>
    AmberSigner.nip44Decrypt(ciphertext, senderPubkey, currentUser),
  );
  return requireAnswer(result);
}

/**
 * Silent NIP-44 decrypt — resolves only when Amber has blanket permission
 * granted (ContentResolver fast-path), throws `PERMISSION_NOT_GRANTED`
 * otherwise. Never launches an Intent, so its raw error is passed through
 * untouched (inbox paths match on that code). Use this from batch inbox paths so we never surface a dialog
 * per event on tab focus.
 */
export async function requestNip44DecryptSilent(
  ciphertext: string,
  senderPubkey: string,
  currentUser: string,
): Promise<string> {
  if (!isAmberSupported()) {
    throw new Error('Amber is only supported on Android');
  }
  const { result } = await AmberSigner.nip44DecryptSilent(ciphertext, senderPubkey, currentUser);
  return result;
}
