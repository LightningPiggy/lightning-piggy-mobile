import * as SecureStore from 'expo-secure-store';
import { getPublicKey } from 'nostr-tools';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { signAccountEvent } from './signAccountEvent';
import { signEvent } from './nostrService';
import { requestEventSignature } from './amberService';
import { nip46Sign } from '../contexts/nip46DmDecrypt';
import { Toast } from '../components/BrandedToast';
import { __resetMismatchNoticeForTests } from './remoteSignerMismatchNotice';
jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('./nostrService', () => ({
  decodeNsec: () => ({ secretKey: new Uint8Array(32).fill(8) }),
  signEvent: jest.fn(),
}));
jest.mock('./amberService', () => ({ requestEventSignature: jest.fn() }));
jest.mock('../contexts/nip46DmDecrypt', () => ({ nip46Sign: jest.fn() }));
it('does not sign account A’s pending template with account B’s replacement stored key', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue('replacement key');
  await expect(
    signAccountEvent(
      { kind: 30405, created_at: 100, tags: [], content: 'A shop' },
      {
        pubkey: getPublicKey(new Uint8Array(32).fill(7)),
        isLoggedIn: true,
        signerType: 'nsec',
      },
    ),
  ).resolves.toBeNull();
  expect(signEvent).not.toHaveBeenCalled();
  jest.restoreAllMocks();
});

describe('remote signers (#1779)', () => {
  const template = { kind: 10002, created_at: 100, tags: [['r', 'wss://mine']], content: '' };
  const accountKey = generateSecretKey();
  const account = { pubkey: getPublicKey(accountKey), isLoggedIn: true };

  /** Make both remote signers answer with `event`. */
  const answer = (event: object) => {
    const json = JSON.stringify(event);
    jest.mocked(requestEventSignature).mockResolvedValue({ event: json, signature: '' });
    jest.mocked(nip46Sign).mockResolvedValue(json);
  };

  beforeEach(() => {
    jest.mocked(requestEventSignature).mockReset();
    jest.mocked(nip46Sign).mockReset();
    jest.mocked(Toast.show).mockClear();
    __resetMismatchNoticeForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['amber', 'nip46'] as const)(
    'returns null when %s answers with another account’s signature',
    async (signerType) => {
      answer(finalizeEvent({ ...template }, generateSecretKey()));
      await expect(signAccountEvent(template, { ...account, signerType })).resolves.toBeNull();
      // The caller only sees null, so the user is told why, once per burst.
      await signAccountEvent(template, { ...account, signerType });
      expect(Toast.show).toHaveBeenCalledTimes(1);
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'error',
        text1:
          'Your signer answered with a different account. Switch it to this account and try again.',
      });
    },
  );

  it.each(['amber', 'nip46'] as const)('accepts %s restamping created_at', async (signerType) => {
    answer(finalizeEvent({ ...template, created_at: 999 }, accountKey));
    await expect(signAccountEvent(template, { ...account, signerType })).resolves.toMatchObject({
      created_at: 999,
    });
  });

  it.each(['amber', 'nip46'] as const)('returns null when %s signs a changed event', async (st) => {
    answer(finalizeEvent({ ...template, tags: [] }, accountKey));
    await expect(signAccountEvent(template, { ...account, signerType: st })).resolves.toBeNull();
  });

  it.each(['amber', 'nip46'] as const)(
    'returns the event %s signed for this account',
    async (st) => {
      const signed = finalizeEvent({ ...template }, accountKey);
      answer(signed);
      await expect(
        signAccountEvent(template, { ...account, signerType: st }),
      ).resolves.toMatchObject({ id: signed.id, pubkey: account.pubkey });
      expect(Toast.show).not.toHaveBeenCalled();
    },
  );
});
