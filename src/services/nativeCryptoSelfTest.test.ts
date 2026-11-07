import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as nip44 from 'nostr-tools/nip44';
import { getEventHash, getPublicKey } from 'nostr-tools/pure';
import { NATIVE_CRYPTO_KAT as K, nativeCryptoSelfTest } from './nativeCryptoSelfTest';

// A "native" module backed by the JS reference implementation: the answers a
// healthy rust-nostr build must give.
const reference = {
  schnorrVerify: (sig: string, hash: string, pub: string) =>
    schnorr.verify(hexToBytes(sig), hexToBytes(hash), hexToBytes(pub)),
  nip44Decrypt: (skHex: string, peer: string, payload: string) =>
    nip44.v2.decrypt(payload, nip44.v2.utils.getConversationKey(hexToBytes(skHex), peer)),
  nip44Encrypt: (skHex: string, peer: string, plaintext: string) =>
    nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(hexToBytes(skHex), peer)),
};

describe('NATIVE_CRYPTO_KAT', () => {
  it('is internally consistent under nostr-tools', () => {
    expect(getPublicKey(hexToBytes(K.secretKeyHex))).toBe(K.pubkey);
    const id = getEventHash({
      kind: 1,
      created_at: 1700000000,
      tags: [],
      content: 'native self-test',
      pubkey: K.pubkey,
    });
    expect(id).toBe(K.id);
    expect(reference.schnorrVerify(K.sig, K.id, K.pubkey)).toBe(true);
    expect(reference.schnorrVerify(K.tamperedSig, K.id, K.pubkey)).toBe(false);
    expect(reference.nip44Decrypt(K.secretKeyHex, K.peerPubkey, K.payload)).toBe(K.plaintext);
    expect(
      bytesToHex(nip44.v2.utils.getConversationKey(hexToBytes(K.secretKeyHex), K.peerPubkey)),
    ).toBe(K.conversationKeyHex);
  });
});

describe('nativeCryptoSelfTest', () => {
  it('passes a module that answers like the reference implementation', () => {
    expect(nativeCryptoSelfTest(reference)).toBe(true);
  });

  it('passes a module that throws on the forged signature', () => {
    const native = {
      ...reference,
      schnorrVerify: (sig: string, hash: string, pub: string) => {
        if (sig === K.tamperedSig) throw new Error('invalid signature');
        return reference.schnorrVerify(sig, hash, pub);
      },
    };
    expect(nativeCryptoSelfTest(native)).toBe(true);
  });

  it('fails a verifier that accepts everything (would let forgeries through)', () => {
    expect(nativeCryptoSelfTest({ ...reference, schnorrVerify: () => true })).toBe(false);
  });

  it('fails a verifier that rejects everything (would drop every event)', () => {
    expect(nativeCryptoSelfTest({ ...reference, schnorrVerify: () => false })).toBe(false);
  });

  it('fails a decrypt that returns the wrong plaintext', () => {
    expect(nativeCryptoSelfTest({ ...reference, nip44Decrypt: () => 'oinq' })).toBe(false);
  });

  it('fails, without throwing, when a binding throws (e.g. stripped by R8)', () => {
    const broken = () => {
      throw new Error('UnsatisfiedLinkError');
    };
    expect(nativeCryptoSelfTest({ ...reference, nip44Decrypt: broken })).toBe(false);
    expect(nativeCryptoSelfTest({ ...reference, schnorrVerify: broken })).toBe(false);
    expect(nativeCryptoSelfTest({ ...reference, nip44Encrypt: broken })).toBe(false);
  });

  it('fails an encrypt whose payload JS cannot decrypt to the plaintext', () => {
    // Garbage, and a well-formed payload under the wrong conversation key.
    expect(nativeCryptoSelfTest({ ...reference, nip44Encrypt: () => 'native-payload' })).toBe(
      false,
    );
    const wrongKey = (_sk: string, _peer: string, plaintext: string) =>
      nip44.v2.encrypt(plaintext, new Uint8Array(32).fill(7));
    expect(nativeCryptoSelfTest({ ...reference, nip44Encrypt: wrongKey })).toBe(false);
    const wrongText = (sk: string, peer: string) => reference.nip44Encrypt(sk, peer, 'oinq');
    expect(nativeCryptoSelfTest({ ...reference, nip44Encrypt: wrongText })).toBe(false);
  });
});
