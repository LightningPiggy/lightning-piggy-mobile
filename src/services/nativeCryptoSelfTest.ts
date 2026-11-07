import { hexToBytes } from '@noble/hashes/utils.js';
import * as nip44 from 'nostr-tools/nip44';

import type { NostrNativeApi } from '../../modules/nostr-native';

/**
 * Known-answer vectors for the native crypto self-test (#1727), produced with
 * nostr-tools from DUMMY keys (secret key 0x11…11, peer 0x22…22; never a real
 * account). `id` is the event hash the `sig` signs; `payload` is NIP-44 v2
 * from the peer to `pubkey`, decryptable with `secretKeyHex` + `peerPubkey`.
 * `conversationKeyHex` is that pair's NIP-44 conversation key, precomputed so
 * checking native encrypt costs no JS ECDH at startup.
 */
export const NATIVE_CRYPTO_KAT = {
  secretKeyHex: '1111111111111111111111111111111111111111111111111111111111111111',
  pubkey: '4f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa',
  peerPubkey: '466d7fcae563e5cb09a0d1870bb580344804617879a14949cf22285f1bae3f27',
  conversationKeyHex: '2cbdf074f601178c24da3f829b504507a1f550f97d472af0f3f2cc59ab7757d1',
  id: '8337bba7c43479c06bd526e910fd02d9c0768062cea8b22c9bbf29bd9728d91c',
  sig: '85e10fdcceac672b8c53c7cdc8da2e5ec1ac495b7aef0c4a57f3b6f89ac5b4f366867afea4b2495fec96ac0667a535f8807252662518f5a4e483f61911b22834',
  tamperedSig:
    '85e10fdcceac672b8c53c7cdc8da2e5ec1ac495b7aef0c4a57f3b6f89ac5b4f366867afea4b2495fec96ac0667a535f8807252662518f5a4e483f61911b22835',
  payload:
    'AjMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzJCR/tKoGE/SDtg3fKI6lTFkJ3LT9K3uFhr22oozB/q91ITwXE3cX9nT7koc6JQ5lmZ4BxlLYjUUG5VyiGLYYMOR2',
  plaintext: 'oink',
} as const;

/**
 * Run once at warm-up, before native routing latches. Native crypto is on by
 * default, so a build whose module loads but answers wrongly (an R8-stripped
 * binding, ABI or rust-nostr drift) must stay on JS rather than reject every
 * signature, fail every DM decrypt, or throw on every send. Covers each op the
 * facade routes natively: verify (valid + forged), decrypt, and encrypt — the
 * latter checked by an independent JS decrypt. Four sync JSI calls plus one
 * small JS decrypt (a few ms, once per launch).
 */
export function nativeCryptoSelfTest(
  native: Pick<NostrNativeApi, 'schnorrVerify' | 'nip44Decrypt' | 'nip44Encrypt'>,
): boolean {
  const k = NATIVE_CRYPTO_KAT;
  try {
    if (native.schnorrVerify(k.sig, k.id, k.pubkey) !== true) return false;
    if (native.nip44Decrypt(k.secretKeyHex, k.peerPubkey, k.payload) !== k.plaintext) return false;
    const sealed = native.nip44Encrypt(k.secretKeyHex, k.peerPubkey, k.plaintext);
    if (nip44.v2.decrypt(sealed, hexToBytes(k.conversationKeyHex)) !== k.plaintext) return false;
  } catch {
    return false;
  }
  try {
    // Must reject a forgery; throwing counts as rejecting (the facade
    // normalises a native throw to "invalid").
    return native.schnorrVerify(k.tamperedSig, k.id, k.pubkey) === false;
  } catch {
    return true;
  }
}
