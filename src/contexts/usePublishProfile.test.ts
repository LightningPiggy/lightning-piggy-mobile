import { act, renderHook } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as nip19 from 'nostr-tools/nip19';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import { nip46Sign } from './nip46DmDecrypt';
import { usePublishProfile } from './usePublishProfile';
import type { SignerType } from '../types/nostr';

jest.mock('../services/nostrService', () => ({
  createProfileEvent: jest.fn((data: object) => ({
    kind: 0,
    created_at: 1,
    tags: [],
    content: JSON.stringify(data),
  })),
  decodeNsec: jest.fn((nsec: string) => ({
    secretKey: jest.requireActual('nostr-tools/nip19').decode(nsec).data,
  })),
  signAndPublishEvent: jest.fn(async () => undefined),
  publishSignedEvent: jest.fn(async () => undefined),
}));
jest.mock('../services/amberService', () => ({ requestEventSignature: jest.fn() }));
jest.mock('./nip46DmDecrypt', () => ({ nip46Sign: jest.fn() }));
jest.mock('../services/ownEventPublishTargets', () => ({
  ownEventPublishTargets: jest.fn(async () => ['wss://write.example', 'wss://purplepag.es']),
}));

const keyA = generateSecretKey();
const A = getPublicKey(keyA);
const keyB = generateSecretKey();

const setup = (signerType: SignerType | null) => {
  const setProfile = jest.fn();
  const { result } = renderHook(() =>
    usePublishProfile({ pubkey: A, isLoggedIn: true, signerType, relays: [], setProfile }),
  );
  return { publish: result.current, setProfile };
};

beforeEach(() => jest.clearAllMocks());

it("publishes with the account's own key, to the write relays and indexers", async () => {
  jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(nip19.nsecEncode(keyA));
  const { publish, setProfile } = setup('nsec');
  let ok = false;
  await act(async () => {
    ok = await publish({ name: 'Piggy' });
  });
  expect(ok).toBe(true);
  expect((nostrService.signAndPublishEvent as jest.Mock).mock.calls[0][2]).toEqual([
    'wss://write.example',
    'wss://purplepag.es',
  ]);
  expect(setProfile).toHaveBeenCalledWith(expect.objectContaining({ pubkey: A, name: 'Piggy' }));
});

it("never signs A's edits with another account's key (switched during the lookup)", async () => {
  jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue(nip19.nsecEncode(keyB));
  const { publish, setProfile } = setup('nsec');
  let ok = true;
  await act(async () => {
    ok = await publish({ name: 'Piggy' });
  });
  expect(ok).toBe(false);
  expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
  expect(setProfile).not.toHaveBeenCalled();
});

it.each(['amber', 'nip46'] as const)(
  '%s: an event signed by another account is not published or adopted',
  async (signer) => {
    const other = JSON.stringify({ pubkey: getPublicKey(keyB), id: 'x', sig: 's' });
    (amberService.requestEventSignature as jest.Mock).mockResolvedValue({ event: other });
    (nip46Sign as jest.Mock).mockResolvedValue(other);
    const { publish, setProfile } = setup(signer);
    let ok = true;
    await act(async () => {
      ok = await publish({ name: 'Piggy' });
    });
    expect(ok).toBe(false);
    expect(nostrService.publishSignedEvent).not.toHaveBeenCalled();
    expect(setProfile).not.toHaveBeenCalled();
  },
);

it('no signer: reports failure and adopts nothing', async () => {
  const { publish, setProfile } = setup(null);
  let ok = true;
  await act(async () => {
    ok = await publish({ name: 'Piggy' });
  });
  expect(ok).toBe(false);
  expect(setProfile).not.toHaveBeenCalled();
});
