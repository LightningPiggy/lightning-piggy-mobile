/**
 * Unit tests for the per-signer NIP-17 inbox ingest dispatcher. The shared
 * ingest engine, secret-key cache, unwrap helpers and nip46 unwrap builder are
 * mocked so we assert only the branch selection + result-shaping this module
 * owns (which signer uses which unwrap / skip key, the null short-circuits, and
 * that only Amber reports a permission verdict).
 */
import { ingestInboxNip17ForSigner } from './inboxNip17Ingest';

const mockIngestInboxWraps = jest.fn();
const mockGetMemoisedSecretKey = jest.fn();
const mockNip46Unwrap = jest.fn(() => 'nip46-unwrap-fn');

jest.mock('./dmWrapIngest', () => ({
  ingestInboxWraps: (...a: unknown[]) => mockIngestInboxWraps(...(a as [])),
}));
jest.mock('./nostrSecretKeyCache', () => ({
  getMemoisedSecretKey: (...a: unknown[]) => mockGetMemoisedSecretKey(...(a as [])),
}));
jest.mock('./nip46DmDecrypt', () => ({
  nip46Unwrap: (...a: unknown[]) => mockNip46Unwrap(...(a as [])),
}));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: jest.fn(),
  unwrapWrapViaNip44: jest.fn(),
}));
jest.mock('../services/perAccountStorage', () => ({
  perAccountKey: (base: string, pk: string) => `${base}_${pk}`,
}));

const engineResult = {
  entries: [{ id: 'e1' }],
  alreadyKnown: 2,
  skipHits: 3,
  misses: 4,
  stored: 5,
  yields: 6,
  permissionDenied: false,
};

const baseArgs = {
  ownerPubkey: 'owner',
  wraps: [{ id: 'w1' }] as never,
  passesFollowGate: () => true,
  onSkip: jest.fn(),
  amberNip44DecryptSilent: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
  mockIngestInboxWraps.mockResolvedValue(engineResult);
});

it('returns null (no-op) when there are no wraps', async () => {
  const out = await ingestInboxNip17ForSigner({ ...baseArgs, signerType: 'nsec', wraps: [] });
  expect(out).toBeNull();
  expect(mockIngestInboxWraps).not.toHaveBeenCalled();
});

describe('nsec', () => {
  it('returns null when the memoised secret key is unavailable', async () => {
    mockGetMemoisedSecretKey.mockResolvedValue(null);
    const out = await ingestInboxNip17ForSigner({ ...baseArgs, signerType: 'nsec' });
    expect(out).toBeNull();
    expect(mockIngestInboxWraps).not.toHaveBeenCalled();
  });

  it('ingests with the nsec skip key and reports no amber permission', async () => {
    mockGetMemoisedSecretKey.mockResolvedValue(new Uint8Array([1]));
    const out = await ingestInboxNip17ForSigner({ ...baseArgs, signerType: 'nsec' });
    expect(mockIngestInboxWraps).toHaveBeenCalledWith(
      expect.objectContaining({ skipKey: 'nsec_nip17_skip_v3_owner' }),
    );
    expect(out).toMatchObject({ alreadyKnown: 2, stored: 5, yields: 6 });
    expect(out?.amberPermission).toBeUndefined();
  });
});

describe('amber', () => {
  it('sets stopOnPermissionDenied and maps permissionDenied → granted/denied', async () => {
    const out = await ingestInboxNip17ForSigner({ ...baseArgs, signerType: 'amber' });
    expect(mockIngestInboxWraps).toHaveBeenCalledWith(
      expect.objectContaining({
        skipKey: 'amber_nip17_skip_v3_owner',
        stopOnPermissionDenied: true,
      }),
    );
    expect(out?.amberPermission).toBe('granted');

    mockIngestInboxWraps.mockResolvedValueOnce({ ...engineResult, permissionDenied: true });
    const denied = await ingestInboxNip17ForSigner({ ...baseArgs, signerType: 'amber' });
    expect(denied?.amberPermission).toBe('denied');
  });
});

describe('nip46', () => {
  it('ingests via the bunker unwrap builder + nip46 skip key, no permission verdict', async () => {
    const out = await ingestInboxNip17ForSigner({ ...baseArgs, signerType: 'nip46' });
    expect(mockNip46Unwrap).toHaveBeenCalledWith('owner', baseArgs.onSkip);
    expect(mockIngestInboxWraps).toHaveBeenCalledWith(
      expect.objectContaining({
        skipKey: 'nip46_nip17_skip_v3_owner',
        unwrap: 'nip46-unwrap-fn',
      }),
    );
    expect(out?.amberPermission).toBeUndefined();
  });
});
