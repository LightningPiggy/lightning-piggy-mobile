import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { assertRemoteSignedEvent, parseRemoteSignedEvent } from './remoteSignedEvent';

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const template = { kind: 3, created_at: 100, tags: [['p', 'b'.repeat(64)]], content: '' };

describe('parseRemoteSignedEvent (#1779)', () => {
  it('returns the event when it is the template signed by the expected account', () => {
    const signed = finalizeEvent(template, key);
    expect(parseRemoteSignedEvent(JSON.stringify(signed), template, pubkey)).toMatchObject({
      id: signed.id,
      pubkey,
    });
  });

  it('rejects the template signed by another account', () => {
    const other = finalizeEvent(template, generateSecretKey());
    expect(() => parseRemoteSignedEvent(JSON.stringify(other), template, pubkey)).toThrow(
      /different account/,
    );
  });

  it.each([
    ['kind', { kind: 10002 }],
    ['created_at', { created_at: 101 }],
    ['tags', { tags: [] }],
    ['content', { content: 'x' }],
  ])('rejects an event whose %s differs from the template', (_, change) => {
    const signed = finalizeEvent({ ...template, ...change }, key);
    expect(() => parseRemoteSignedEvent(JSON.stringify(signed), template, pubkey)).toThrow(
      /different event/,
    );
  });

  it('rejects a bad signature unless the caller skips the schnorr check', () => {
    const forged = { ...finalizeEvent(template, generateSecretKey()), pubkey };
    expect(() => parseRemoteSignedEvent(JSON.stringify(forged), template, pubkey)).toThrow(
      /invalid signature/,
    );
    expect(assertRemoteSignedEvent(forged, template, pubkey, { verifySignature: false })).toBe(
      forged,
    );
  });

  it('rejects a non-event answer', () => {
    expect(() => assertRemoteSignedEvent(null, template, pubkey)).toThrow(/different account/);
  });
});
