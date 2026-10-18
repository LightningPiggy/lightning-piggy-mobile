import { catchUpWrapById, storeDecryptedWrap } from './backgroundDmIngest';
import type { RawGiftWrapEvent } from './nostrService';
import type { DecodedRumor } from '../utils/nip17Unwrap';

const mockIngest = jest.fn(async (_params: unknown) => ({}));
jest.mock('../contexts/dmWrapIngest', () => ({
  ingestInboxWraps: (params: unknown) => mockIngest(params),
}));
const mockReplied = new Set<string>();
jest.mock('./dmRepliedPartners', () => ({
  loadRepliedPartners: jest.fn(async () => undefined),
  hasRepliedTo: (_owner: string, pk: string) => mockReplied.has(pk.toLowerCase()),
}));
let mockEpoch = 0;
let mockRetired = false;
jest.mock('./dmOwnerGuard', () => ({
  dmOwnerEpoch: () => mockEpoch,
  isDmOwnerRetired: () => mockRetired,
}));
const mockIdentities = jest.fn();
jest.mock('./identitiesStore', () => ({ loadIdentities: () => mockIdentities() }));
jest.mock('./backgroundDmReadRelays', () => ({
  resolveReadRelays: jest.fn(async () => ['wss://relay']),
}));
const mockQuery = jest.fn();
jest.mock('./relayQuery', () => ({
  querySyncAbortable: (...args: unknown[]) => mockQuery(...args),
}));
jest.mock('./nostrService', () => ({
  pool: {},
  decodeNsec: (nsec: string) => ({
    pubkey: nsec === 'nsec-me' ? 'a'.repeat(64) : 'x',
    secretKey: new Uint8Array(32),
  }),
}));
const mockUnwrap = jest.fn();
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: (...args: unknown[]) => mockUnwrap(...args),
}));
const mockGetItem = jest.fn(async (_key: string) => null as string | null);
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: (key: string) => mockGetItem(key),
}));

const ME = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const wrap = { id: 'w1', kind: 1059 } as RawGiftWrapEvent;
const rumor = { pubkey: FRIEND, kind: 14, content: 'hi', tags: [], created_at: 1 } as DecodedRumor;

type IngestParams = {
  persistIf: () => boolean;
  owner: string;
  wraps: { id: string; decoded: DecodedRumor }[];
  unwrap: (w: { decoded: DecodedRumor }) => DecodedRumor;
  passesFollowGate: (pk: string) => boolean;
};
const lastIngest = () => mockIngest.mock.calls.at(-1)![0] as IngestParams;

beforeEach(() => jest.clearAllMocks());

describe('storeDecryptedWrap', () => {
  it('stores through the inbox ingest with the background follow gate', async () => {
    await storeDecryptedWrap(ME, wrap, rumor, new Set([FRIEND]));
    const params = lastIngest();
    expect(params.owner).toBe(ME);
    expect(params.wraps.map((w) => w.id)).toEqual(['w1']);
    expect(params.unwrap(params.wraps[0])).toBe(rumor);
    expect(params.passesFollowGate(FRIEND.toUpperCase())).toBe(true);
    expect(params.passesFollowGate(STRANGER)).toBe(false);
  });

  it("won't save once the account's rows were wiped (sign-out mid-write)", async () => {
    await storeDecryptedWrap(ME, wrap, rumor, new Set([FRIEND]));
    const { persistIf } = lastIngest();
    expect(persistIf()).toBe(true);
    mockEpoch += 1; // deleteDmMessagesForOwner
    expect(persistIf()).toBe(false);
  });

  it("won't save for an account signed out before the write started", async () => {
    mockRetired = true; // wiped; identity not yet removed
    await storeDecryptedWrap(ME, wrap, rumor, new Set([FRIEND]));
    expect(lastIngest().persistIf()).toBe(false);
    mockRetired = false;
  });

  it('lets someone we replied to through, as the alert gate does (#1623)', async () => {
    mockReplied.add(STRANGER);
    await storeDecryptedWrap(ME, wrap, rumor, new Set([FRIEND]));
    expect(lastIngest().passesFollowGate(STRANGER)).toBe(true);
    mockReplied.clear();
    expect(lastIngest().passesFollowGate(STRANGER)).toBe(false);
  });

  it('stores nothing without a contacts cache (the refresh applies the gate)', async () => {
    await storeDecryptedWrap(ME, wrap, rumor, null);
    expect(mockIngest).not.toHaveBeenCalled();
  });
});

describe('catchUpWrapById', () => {
  it('fetches, decrypts and stores the one wrap for a local key', async () => {
    mockIdentities.mockResolvedValue({
      identities: [{ pubkey: ME, signerType: 'nsec', nsec: 'nsec-me' }],
    });
    mockQuery.mockResolvedValue([wrap]);
    mockUnwrap.mockReturnValue(rumor);
    mockGetItem.mockResolvedValue(JSON.stringify([{ pubkey: FRIEND }]));
    await catchUpWrapById(ME, 'w1');
    expect(mockQuery).toHaveBeenCalledWith(
      {},
      ['wss://relay'],
      { kinds: [1059], ids: ['w1'], limit: 1 },
      { maxWait: 4000 },
    );
    expect(lastIngest().wraps[0].id).toBe('w1');
    expect(lastIngest().passesFollowGate(STRANGER)).toBe(false);
  });

  it('finds an identity stored with an uppercase pubkey', async () => {
    mockIdentities.mockResolvedValue({
      identities: [{ pubkey: ME.toUpperCase(), signerType: 'nsec', nsec: 'nsec-me' }],
    });
    mockQuery.mockResolvedValue([wrap]);
    mockUnwrap.mockReturnValue(rumor);
    mockGetItem.mockResolvedValue(JSON.stringify([{ pubkey: FRIEND }]));
    await catchUpWrapById(ME, 'w1');
    expect(lastIngest().wraps[0].id).toBe('w1');
  });

  it('drops the wrap if the account signed out during the fetch', async () => {
    mockIdentities
      .mockResolvedValueOnce({ identities: [{ pubkey: ME, signerType: 'nsec', nsec: 'nsec-me' }] })
      .mockResolvedValueOnce({ identities: [] });
    mockQuery.mockResolvedValue([wrap]);
    mockUnwrap.mockReturnValue(rumor);
    mockGetItem.mockResolvedValue(JSON.stringify([{ pubkey: FRIEND }]));
    await catchUpWrapById(ME, 'w1');
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('leaves a remote signer, a missing wrap or an undecryptable one to the refresh', async () => {
    mockIdentities.mockResolvedValue({ identities: [{ pubkey: ME, signerType: 'amber' }] });
    await catchUpWrapById(ME, 'w1');
    expect(mockQuery).not.toHaveBeenCalled();

    mockIdentities.mockResolvedValue({
      identities: [{ pubkey: ME, signerType: 'nsec', nsec: 'nsec-me' }],
    });
    mockQuery.mockResolvedValue([]);
    await catchUpWrapById(ME, 'w1');
    mockQuery.mockResolvedValue([wrap]);
    mockUnwrap.mockReturnValue(null);
    await catchUpWrapById(ME, 'w1');
    mockQuery.mockRejectedValue(new Error('offline'));
    await expect(catchUpWrapById(ME, 'w1')).resolves.toBeUndefined();
    expect(mockIngest).not.toHaveBeenCalled();
  });
});
