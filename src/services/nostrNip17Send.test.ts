import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { pool } from './nostrPool';
import { sendNip17ToManyWithNsec, sendNip17ToManyWithSigner } from './nostrNip17Send';
import { RemoteSignerMismatchError } from './remoteSignedEvent';

jest.mock('./nostrPool', () => ({
  pool: { publish: jest.fn((relays: string[]) => relays.map(() => Promise.resolve('saved'))) },
  trackRelays: jest.fn(),
}));
const publicRelays = ['wss://public.example'];
const rumor = { kind: 14, created_at: 123, tags: [], content: 'pending test message' };
// A fake remote signer answering for the requested account. Seals are checked
// for pubkey + template only (no schnorr), so the claimed pubkey is enough.
// (finalizeEvent mutates its argument, hence the copy.)
const signAsRequested = (seal: Parameters<typeof finalizeEvent>[0] & { pubkey: string }) => ({
  ...finalizeEvent({ ...seal }, generateSecretKey()),
  pubkey: seal.pubkey,
});

afterEach(() => {
  setCurrentUserPubkey(null);
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('keeps nsec wraps on LAN when the account switches while yielding', async () => {
  const senderKey = generateSecretKey();
  const recipient = getPublicKey(generateSecretKey());
  const senderPubkey = getPublicKey(senderKey);
  const originalHas = TEST_ACCOUNT_PUBKEYS.has.bind(TEST_ACCOUNT_PUBKEYS);
  jest
    .spyOn(TEST_ACCOUNT_PUBKEYS, 'has')
    .mockImplementation((pk) => pk === senderPubkey || originalHas(pk));
  setCurrentUserPubkey(senderPubkey);
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation((callback) => {
    setCurrentUserPubkey('a'.repeat(64));
    callback(performance.now());
    return 0;
  });
  const result = await sendNip17ToManyWithNsec({
    senderSecretKey: senderKey,
    rumor,
    recipientPubkeys: [recipient],
    relays: publicRelays,
  });
  expect(result.wrapsPublished).toBe(2);
  expect(pool.publish).toHaveBeenCalledTimes(2);
  for (const [relays] of jest.mocked(pool.publish).mock.calls)
    expect(relays).toEqual([TEST_RELAY_URL]);
  expect(Object.keys(result.delivery.relayResults)).toEqual([TEST_RELAY_URL]);
});

it.each(['encrypt', 'sign'])('keeps signer wraps on LAN when switching during %s', async (step) => {
  setCurrentUserPubkey(TEST_ACCOUNT_KEYS.little);
  const result = await sendNip17ToManyWithSigner({
    senderPubkey: TEST_ACCOUNT_KEYS.little,
    rumor: { ...rumor, pubkey: TEST_ACCOUNT_KEYS.little },
    recipientPubkeys: [],
    relays: publicRelays,
    signerNip44Encrypt: async () => {
      if (step === 'encrypt') setCurrentUserPubkey('a'.repeat(64));
      await Promise.resolve();
      return 'encrypted rumor';
    },
    signerSignSeal: async (seal) => {
      if (step === 'sign') setCurrentUserPubkey('a'.repeat(64));
      await Promise.resolve();
      return signAsRequested(seal);
    },
  });
  expect(result.wrapsPublished).toBe(1);
  expect(pool.publish).toHaveBeenCalledWith(
    [TEST_RELAY_URL],
    expect.objectContaining({ kind: 1059 }),
  );
  expect(Object.keys(result.delivery.relayResults)).toEqual([TEST_RELAY_URL]);
});

it('preserves public destinations for an ordinary sender', async () => {
  const key = generateSecretKey();
  const pubkey = getPublicKey(key);
  setCurrentUserPubkey(pubkey);
  await sendNip17ToManyWithNsec({
    senderSecretKey: key,
    rumor,
    recipientPubkeys: [],
    relays: publicRelays,
  });
  expect(pool.publish).toHaveBeenCalledWith(publicRelays, expect.anything());
});

it('retains LAN destinations through stale-socket retry after an account switch', async () => {
  setCurrentUserPubkey(TEST_ACCOUNT_KEYS.little);
  const close = jest.fn();
  Object.assign(pool, { close });
  jest.mocked(pool.publish).mockImplementationOnce(() => {
    setCurrentUserPubkey('a'.repeat(64));
    return [Promise.resolve('connection failure: offline')];
  });
  const result = await sendNip17ToManyWithSigner({
    senderPubkey: TEST_ACCOUNT_KEYS.little,
    rumor: { ...rumor, pubkey: TEST_ACCOUNT_KEYS.little },
    recipientPubkeys: [],
    relays: publicRelays,
    signerNip44Encrypt: async () => 'ciphertext',
    signerSignSeal: async (seal) => signAsRequested(seal),
  });
  expect(result.wrapsPublished).toBe(1);
  expect(close).toHaveBeenCalledWith([TEST_RELAY_URL]);
  expect(pool.publish).toHaveBeenCalledTimes(2);
  for (const [relays] of jest.mocked(pool.publish).mock.calls)
    expect(relays).toEqual([TEST_RELAY_URL]);
});

it.each([
  ['signed by another account', { pubkey: 'b'.repeat(64) }, /different account/],
  ['with changed content', { content: 'other' }, /changed the request/],
])('publishes nothing when the signer returns a seal %s (#1779)', async (_, change, reason) => {
  const sender = getPublicKey(generateSecretKey());
  setCurrentUserPubkey(sender);
  const result = await sendNip17ToManyWithSigner({
    senderPubkey: sender,
    rumor: { ...rumor, pubkey: sender },
    recipientPubkeys: [getPublicKey(generateSecretKey())],
    relays: publicRelays,
    signerNip44Encrypt: async () => 'ciphertext',
    signerSignSeal: async (seal) => ({ ...signAsRequested(seal), ...change }),
  });
  expect(result.wrapsPublished).toBe(0);
  expect(pool.publish).not.toHaveBeenCalled();
  expect(result.errors[0]).toMatch(reason);
  // The typed refusal travels too, so market flows can show the signer reason.
  expect(result.signerError).toBeInstanceOf(RemoteSignerMismatchError);
});
