import { requireNativeModule, Platform } from 'expo-modules-core';

interface GetPublicKeyResult {
  pubkey: string;
  package: string;
}

interface SignEventResult {
  signature: string;
  event: string;
}

const AmberSigner = Platform.OS === 'android' ? requireNativeModule('AmberSigner') : null;

export async function getPublicKey(permissionsJson?: string): Promise<GetPublicKeyResult> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.getPublicKey(permissionsJson ?? null);
}

export async function signEvent(
  eventJson: string,
  eventId: string,
  currentUser: string,
): Promise<SignEventResult> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.signEvent(eventJson, eventId, currentUser);
}

export async function nip04Encrypt(
  plaintext: string,
  pubkey: string,
  currentUser: string,
): Promise<{ result: string }> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.nip04Encrypt(plaintext, pubkey, currentUser);
}

export async function nip04Decrypt(
  ciphertext: string,
  pubkey: string,
  currentUser: string,
): Promise<{ result: string }> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.nip04Decrypt(ciphertext, pubkey, currentUser);
}

export async function nip44Encrypt(
  plaintext: string,
  pubkey: string,
  currentUser: string,
): Promise<{ result: string }> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.nip44Encrypt(plaintext, pubkey, currentUser);
}

export async function nip44Decrypt(
  ciphertext: string,
  pubkey: string,
  currentUser: string,
): Promise<{ result: string }> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.nip44Decrypt(ciphertext, pubkey, currentUser);
}

/**
 * Silent-only NIP-44 decrypt. Resolves only if Amber has already granted
 * blanket permission for this op; rejects with `PERMISSION_NOT_GRANTED`
 * otherwise. Used by batch inbox paths that must not fan out approval
 * dialogs.
 */
export async function nip44DecryptSilent(
  ciphertext: string,
  pubkey: string,
  currentUser: string,
): Promise<{ result: string }> {
  if (!AmberSigner) {
    throw new Error('Amber is only supported on Android');
  }
  return AmberSigner.nip44DecryptSilent(ciphertext, pubkey, currentUser);
}

export async function isInstalled(): Promise<boolean> {
  if (!AmberSigner) return false;
  return AmberSigner.isInstalled();
}
