import { AmberSignerError } from './amberErrors';
import * as amberService from './amberService';
import { createSerialQueue } from './marmotSigner';

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));

jest.mock('../../modules/amber-signer', () => ({
  getPublicKey: jest.fn(),
  signEvent: jest.fn(),
  nip04Encrypt: jest.fn(),
  nip04Decrypt: jest.fn(),
  nip44Encrypt: jest.fn(),
  nip44Decrypt: jest.fn(),
  nip44DecryptSilent: jest.fn(),
  isInstalled: jest.fn(),
}));
const mockNative: Record<
  | 'getPublicKey'
  | 'signEvent'
  | 'nip04Encrypt'
  | 'nip04Decrypt'
  | 'nip44Encrypt'
  | 'nip44Decrypt'
  | 'nip44DecryptSilent'
  | 'isInstalled',
  jest.Mock
> = jest.requireMock('../../modules/amber-signer');

// marmotSigner pulls in the other signer backends; only its queue is used here.
jest.mock('expo-secure-store', () => ({}));
jest.mock('./nostrCrypto', () => ({}));
jest.mock('./nostrConnectService', () => ({}));
jest.mock('./nostrService', () => ({}));

const coded = (code: string) => Object.assign(new Error(`native ${code}`), { code });

const PUBKEY = 'a'.repeat(64);

beforeEach(() => jest.resetAllMocks());

describe('amberService Intent calls', () => {
  it('passes relay-login pre-approval JSON to the native getPublicKey method', async () => {
    mockNative.getPublicKey.mockResolvedValueOnce({ pubkey: PUBKEY, package: 'amber' });
    await expect(amberService.requestPublicKey()).resolves.toBe(PUBKEY);
    const [permissionsJson] = mockNative.getPublicKey.mock.calls[0];
    expect(typeof permissionsJson).toBe('string');
    expect(JSON.parse(permissionsJson)).toEqual([{ type: 'sign_event', kind: 22242 }]);
  });

  const calls: [string, keyof typeof mockNative, () => Promise<unknown>][] = [
    ['requestPublicKey', 'getPublicKey', () => amberService.requestPublicKey()],
    [
      'requestEventSignature',
      'signEvent',
      () => amberService.requestEventSignature('{}', '', PUBKEY),
    ],
    ['requestNip04Encrypt', 'nip04Encrypt', () => amberService.requestNip04Encrypt('m', PUBKEY, PUBKEY)], // prettier-ignore
    ['requestNip04Decrypt', 'nip04Decrypt', () => amberService.requestNip04Decrypt('c', PUBKEY, PUBKEY)], // prettier-ignore
    ['requestNip44Encrypt', 'nip44Encrypt', () => amberService.requestNip44Encrypt('m', PUBKEY, PUBKEY)], // prettier-ignore
    ['requestNip44Decrypt', 'nip44Decrypt', () => amberService.requestNip44Decrypt('c', PUBKEY, PUBKEY)], // prettier-ignore
  ];

  it.each(calls)('%s rethrows native failures as a typed AmberSignerError', async (_, fn, call) => {
    mockNative[fn].mockRejectedValueOnce(coded('NO_RESULT'));
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmberSignerError);
    expect(err).toMatchObject({ code: 'NO_RESULT', kind: 'no-response' });
  });

  it('distinguishes declined, busy and no-response for the same call', async () => {
    mockNative.signEvent
      .mockRejectedValueOnce(coded('CANCELLED'))
      .mockRejectedValueOnce(coded('BUSY'))
      .mockRejectedValueOnce(coded('NO_RESULT'));
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      await amberService.requestEventSignature('{}', '', PUBKEY).catch((e: AmberSignerError) => {
        kinds.push(e.kind);
      });
    }
    expect(kinds).toEqual(['declined', 'busy', 'no-response']);
  });

  // #1186: once the native module settles a lost request (NO_RESULT), the
  // very next request must reach Amber rather than failing with BUSY.
  it('a retry after a lost result goes through to Amber', async () => {
    mockNative.signEvent
      .mockRejectedValueOnce(coded('NO_RESULT'))
      .mockResolvedValueOnce({ signature: 'sig', event: '{"id":"x"}' });
    await expect(amberService.requestEventSignature('{}', '', PUBKEY)).rejects.toMatchObject({
      kind: 'no-response',
    });
    await expect(amberService.requestEventSignature('{}', '', PUBKEY)).resolves.toEqual({
      signature: 'sig',
      event: '{"id":"x"}',
    });
    expect(mockNative.signEvent).toHaveBeenCalledTimes(2);
  });

  it('passes successful results through unchanged', async () => {
    mockNative.nip44Encrypt.mockResolvedValueOnce({ result: 'ciphertext' });
    await expect(amberService.requestNip44Encrypt('m', PUBKEY, PUBKEY)).resolves.toBe('ciphertext');
    expect(mockNative.nip44Encrypt).toHaveBeenCalledWith('m', PUBKEY, PUBKEY);
  });

  it('still decodes an npub public key', async () => {
    mockNative.getPublicKey.mockResolvedValueOnce({
      pubkey: 'npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6',
      package: 'com.greenart7c3.nostrsigner',
    });
    await expect(amberService.requestPublicKey()).resolves.toBe(
      '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
    );
  });
});

describe('amberService silent decrypt', () => {
  // Inbox paths match on the raw PERMISSION_NOT_GRANTED code + message.
  it('passes the native error through untouched', async () => {
    const raw = coded('PERMISSION_NOT_GRANTED');
    mockNative.nip44DecryptSilent.mockRejectedValueOnce(raw);
    await expect(amberService.requestNip44DecryptSilent('c', PUBKEY, PUBKEY)).rejects.toBe(raw);
  });
});

describe('signer queue interplay', () => {
  // marmotSigner serialises Amber calls through one queue. A request the
  // native module settles as NO_RESULT must free the queue for the next one.
  it('a lost result does not wedge the serial queue', async () => {
    const enqueue = createSerialQueue();
    mockNative.signEvent
      .mockRejectedValueOnce(coded('NO_RESULT'))
      .mockResolvedValueOnce({ signature: 's', event: '{"id":"y"}' });
    const first = enqueue(() => amberService.requestEventSignature('{}', '', PUBKEY));
    const second = enqueue(() => amberService.requestEventSignature('{}', '', PUBKEY));
    await expect(first).rejects.toMatchObject({ kind: 'no-response' });
    await expect(second).resolves.toMatchObject({ event: '{"id":"y"}' });
  });

  it('runs queued Amber requests one at a time, never overlapping', async () => {
    const enqueue = createSerialQueue();
    let inFlight = 0;
    let maxInFlight = 0;
    mockNative.signEvent.mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { signature: 's', event: '{}' };
    });
    await Promise.all(
      [1, 2, 3].map(() => enqueue(() => amberService.requestEventSignature('{}', '', PUBKEY))),
    );
    expect(maxInFlight).toBe(1);
  });
});

describe('amberService empty answers (Amber Reject)', () => {
  // Amber answers Reject with RESULT_OK and an empty payload, not CANCELLED.
  const empties: [string, keyof typeof mockNative, unknown, () => Promise<unknown>][] = [
    ['requestPublicKey', 'getPublicKey', { pubkey: '', package: 'p' }, () => amberService.requestPublicKey()], // prettier-ignore
    ['requestEventSignature', 'signEvent', { signature: '', event: '' }, () => amberService.requestEventSignature('{}', '', PUBKEY)], // prettier-ignore
    ['requestNip04Encrypt', 'nip04Encrypt', { result: '' }, () => amberService.requestNip04Encrypt('m', PUBKEY, PUBKEY)], // prettier-ignore
    ['requestNip04Decrypt', 'nip04Decrypt', { result: '' }, () => amberService.requestNip04Decrypt('c', PUBKEY, PUBKEY)], // prettier-ignore
    ['requestNip44Encrypt', 'nip44Encrypt', { result: '' }, () => amberService.requestNip44Encrypt('m', PUBKEY, PUBKEY)], // prettier-ignore
    ['requestNip44Decrypt', 'nip44Decrypt', { result: '' }, () => amberService.requestNip44Decrypt('c', PUBKEY, PUBKEY)], // prettier-ignore
  ];

  it.each(empties)('%s treats an empty answer as declined', async (_, fn, answer, call) => {
    mockNative[fn].mockResolvedValueOnce(answer);
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmberSignerError);
    expect(err).toMatchObject({ code: 'CANCELLED', kind: 'declined' });
  });

  it('accepts a signature-only answer from Amber', async () => {
    mockNative.signEvent.mockResolvedValueOnce({ signature: 'sig', event: '' });
    await expect(amberService.requestEventSignature('{}', '', PUBKEY)).resolves.toEqual({
      signature: 'sig',
      event: '',
    });
  });

  it('leaves the silent decrypt untouched', async () => {
    mockNative.nip44DecryptSilent.mockResolvedValueOnce({ result: '' });
    await expect(amberService.requestNip44DecryptSilent('c', PUBKEY, PUBKEY)).resolves.toBe('');
  });
});
