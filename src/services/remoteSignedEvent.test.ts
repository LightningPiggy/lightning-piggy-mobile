import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { t } from '../i18n';
import {
  assertRemoteSignedEvent,
  parseRemoteSignedEvent,
  RemoteSignerMismatchError,
  type RemoteSignerMismatchCode,
} from './remoteSignedEvent';

const key = generateSecretKey();
const pubkey = getPublicKey(key);
const template = { kind: 3, created_at: 100, tags: [['p', 'b'.repeat(64)]], content: '' };
/** finalizeEvent mutates its argument, so always sign a copy. */
const sign = (change: object = {}, secret = key) =>
  finalizeEvent({ ...template, ...change }, secret);

/** The code of the mismatch `run` throws (fails the test if it throws anything else). */
function refusal(run: () => unknown): RemoteSignerMismatchCode {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(RemoteSignerMismatchError);
    return (e as RemoteSignerMismatchError).code;
  }
  throw new Error('expected a refusal');
}

describe('parseRemoteSignedEvent (#1779)', () => {
  it('returns the event when it is the template signed by the expected account', () => {
    const signed = sign();
    expect(parseRemoteSignedEvent(JSON.stringify(signed), template, pubkey)).toMatchObject({
      id: signed.id,
      pubkey,
    });
  });

  it('accepts a signer that restamped created_at (the id is still verified)', () => {
    const restamped = sign({ created_at: 200 });
    expect(parseRemoteSignedEvent(JSON.stringify(restamped), template, pubkey).created_at).toBe(
      200,
    );
    const idNotUpdated = { ...restamped, created_at: 300 };
    expect(refusal(() => assertRemoteSignedEvent(idNotUpdated, template, pubkey))).toBe(
      'bad-signature',
    );
  });

  it('refuses the template signed by another account', () => {
    const other = sign({}, generateSecretKey());
    expect(refusal(() => parseRemoteSignedEvent(JSON.stringify(other), template, pubkey))).toBe(
      'wrong-account',
    );
  });

  it.each([
    ['kind', { kind: 10002 }],
    ['tags', { tags: [] }],
    ['content', { content: 'x' }],
  ])('refuses an event whose %s differs from the template', (_, change) => {
    const signed = sign(change);
    expect(refusal(() => parseRemoteSignedEvent(JSON.stringify(signed), template, pubkey))).toBe(
      'modified',
    );
  });

  it('refuses a bad signature unless the caller skips the schnorr check', () => {
    const forged = { ...sign({}, generateSecretKey()), pubkey };
    expect(refusal(() => assertRemoteSignedEvent(forged, template, pubkey))).toBe('bad-signature');
    expect(assertRemoteSignedEvent(forged, template, pubkey, { verifySignature: false })).toBe(
      forged,
    );
  });

  it('refuses a non-event answer', () => {
    expect(refusal(() => assertRemoteSignedEvent(null, template, pubkey))).toBe('wrong-account');
  });
});

describe('RemoteSignerMismatchError', () => {
  it.each([
    ['wrong-account', 'remoteSignerMismatch.wrongAccount'],
    ['modified', 'remoteSignerMismatch.modified'],
    ['bad-signature', 'remoteSignerMismatch.badSignature'],
  ] as const)('%s carries the translated %s copy as its message', (code, key) => {
    const error = new RemoteSignerMismatchError(code);
    expect(error.code).toBe(code);
    expect(error.message).toBe(t(key));
    expect(error.message).not.toBe(key); // the key exists in en.json
  });

  it('tells the user to switch their signer to this account', () => {
    expect(new RemoteSignerMismatchError('wrong-account').message).toBe(
      'Your signer answered with a different account. Switch it to this account and try again.',
    );
  });
});
