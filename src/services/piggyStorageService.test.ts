import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { loadIdentities } from './identitiesStore';
import {
  __resetLegacyPiggyClaimForTests,
  claimLegacyPiggies,
  deletePiggiesForOwner,
  findPiggy,
  hasStoredPiggies,
  PiggyOwnerError,
  loadPiggies,
  piggyStorageKey,
  removePiggy,
  revivePiggyOwner,
  savePiggy,
  type HiddenPiggy,
} from './piggyStorageService';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

jest.mock('./identitiesStore', () => ({ loadIdentities: jest.fn() }));
const registry = jest.mocked(loadIdentities);
const registryOf = (...pubkeys: string[]) =>
  registry.mockResolvedValue({
    identities: pubkeys.map((pubkey) => ({ pubkey, signerType: 'amber', lastUsedAt: 1 })),
    activePubkey: pubkeys[0] ?? null,
  });

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const LEGACY = 'hunt-piggies-v1';
const LEGACY_IOS = 'hunt-piggies:v1';
const LEGACY_MARKER = 'hunt-piggies-legacy-claim';

const piggy = (id: string, extra: Partial<HiddenPiggy> = {}): HiddenPiggy => ({
  id,
  lnurlw: `lnurl-${id}`,
  createdAt: 1,
  isPublic: false,
  ...extra,
});
const ids = (list: HiddenPiggy[]) => list.map((p) => p.id).sort();
const originalOS = Platform.OS;

beforeEach(() => {
  mockStore.clear();
  __resetLegacyPiggyClaimForTests();
  jest.mocked(SecureStore.getItemAsync).mockClear();
  Platform.OS = 'android';
  registryOf(A, B);
});
afterAll(() => {
  Platform.OS = originalOS;
});

describe('per-account Piglet storage (#1781)', () => {
  it("never shows one account's Piglets to another", async () => {
    await savePiggy(A, piggy('a1'));
    await savePiggy(B, piggy('b1'));
    expect(ids(await loadPiggies(A))).toEqual(['a1']);
    expect(ids(await loadPiggies(B))).toEqual(['b1']);
    expect(await findPiggy(B, 'a1')).toBeUndefined();
  });

  it('keys the store per account, case-insensitively', async () => {
    await savePiggy(A.toUpperCase(), piggy('a1'));
    expect(mockStore.has(piggyStorageKey(A))).toBe(true);
    expect(ids(await loadPiggies(A))).toEqual(['a1']);
  });

  it('reads and writes nothing without a signed-in account', async () => {
    await savePiggy(A, piggy('a1'));
    expect(await loadPiggies(null)).toEqual([]);
    const noAccount = savePiggy(null, piggy('x'));
    await expect(noAccount).rejects.toBeInstanceOf(PiggyOwnerError);
    await expect(noAccount).rejects.toThrow('Sign in to save Piglets on this phone.');
    expect(await removePiggy(undefined, 'a1')).toEqual([]);
    expect(ids(await loadPiggies(A))).toEqual(['a1']);
  });

  it("removes only the owner's record", async () => {
    await savePiggy(A, piggy('same'));
    await savePiggy(B, piggy('same'));
    await removePiggy(A, 'same');
    expect(await loadPiggies(A)).toEqual([]);
    expect(ids(await loadPiggies(B))).toEqual(['same']);
  });

  it('a save that resolves after the sign-out wipe does not recreate the record', async () => {
    const save = savePiggy(A, piggy('late'));
    const wipe = deletePiggiesForOwner(A);
    // A translated message, shown as is by the save / republish toasts.
    await expect(save).rejects.toThrow(
      "This account was signed out, so the Piglet wasn't saved on this phone.",
    );
    await expect(save).rejects.toMatchObject({ reason: 'signed-out' });
    await wipe;
    expect(mockStore.has(piggyStorageKey(A))).toBe(false);
    // Signing back in makes saves work again.
    revivePiggyOwner(A);
    await savePiggy(A, piggy('again'));
    expect(ids(await loadPiggies(A))).toEqual(['again']);
  });

  it('the wipe waits for a write already in flight, then deletes', async () => {
    const set = jest.mocked(SecureStore.setItemAsync);
    const realSet = set.getMockImplementation()!;
    let release: () => void = () => {};
    let writing: () => void = () => {};
    const started = new Promise<void>((r) => (writing = r));
    set.mockImplementationOnce(async (key, value) => {
      writing();
      await new Promise<void>((r) => (release = r));
      return realSet(key, value);
    });
    const save = savePiggy(A, piggy('slow'));
    await started;
    const wipe = deletePiggiesForOwner(A);
    release();
    await save;
    await wipe;
    expect(mockStore.has(piggyStorageKey(A))).toBe(false);
  });

  it('reports whether an account has Piglets to warn about at sign-out', async () => {
    expect(await hasStoredPiggies(A)).toBe(false);
    await savePiggy(A, piggy('a1'));
    expect(await hasStoredPiggies(A)).toBe(true);
    expect(await hasStoredPiggies(B)).toBe(false);
  });

  it("sign-out wipe deletes that account's bearer links and PINs only", async () => {
    await savePiggy(A, piggy('a1'));
    await savePiggy(B, piggy('b1'));
    await deletePiggiesForOwner(A);
    expect(mockStore.has(piggyStorageKey(A))).toBe(false);
    expect(await loadPiggies(A)).toEqual([]);
    expect(ids(await loadPiggies(B))).toEqual(['b1']);
  });
});

describe('legacy device-wide blob migration (#1781)', () => {
  it('hands the legacy blob to the first account to become active, then deletes it', async () => {
    const lock = { tagUid: '04AB', pwdHex: '0011AABB', packHex: 'CAFE', lockedAt: 5 };
    mockStore.set(LEGACY, JSON.stringify([piggy('old1'), piggy('old2', { nfcLock: lock })]));
    await claimLegacyPiggies(A);
    expect(mockStore.has(LEGACY)).toBe(false);
    const mine = await loadPiggies(A);
    expect(ids(mine)).toEqual(['old1', 'old2']);
    expect(mine.find((p) => p.id === 'old2')?.nfcLock).toEqual(lock);
    // A later account (switch, or the next sign-in) never sees them.
    expect(await loadPiggies(B)).toEqual([]);
  });

  it('claims for the reader when no account activation ran first', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    expect(ids(await loadPiggies(A))).toEqual(['old1']);
    expect(await loadPiggies(B)).toEqual([]);
  });

  it('lets a second account racing the claim see nothing', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    const [a, b] = await Promise.all([loadPiggies(A), loadPiggies(B)]);
    expect(ids(a)).toEqual(['old1']);
    expect(b).toEqual([]);
  });

  it("keeps the account's own record on an id clash", async () => {
    mockStore.set(piggyStorageKey(A), JSON.stringify([piggy('dup', { name: 'mine' })]));
    mockStore.set(LEGACY, JSON.stringify([piggy('dup', { name: 'legacy' }), piggy('old1')]));
    const mine = await loadPiggies(A);
    expect(ids(mine)).toEqual(['dup', 'old1']);
    expect(mine.find((p) => p.id === 'dup')?.name).toBe('mine');
  });

  it('also migrates the pre-rename iOS key', async () => {
    Platform.OS = 'ios';
    mockStore.set(LEGACY, JSON.stringify([piggy('new-key')]));
    mockStore.set(LEGACY_IOS, JSON.stringify([piggy('ios-key'), piggy('new-key')]));
    expect(ids(await loadPiggies(A))).toEqual(['ios-key', 'new-key']);
    expect(mockStore.has(LEGACY)).toBe(false);
    expect(mockStore.has(LEGACY_IOS)).toBe(false);
  });

  it('retries a failed claim instead of losing the blob', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('locked'));
    await claimLegacyPiggies(A);
    expect(mockStore.has(LEGACY)).toBe(true);
    expect(ids(await loadPiggies(A))).toEqual(['old1']);
    expect(mockStore.has(LEGACY)).toBe(false);
  });

  it('reads the legacy key only once per run after the claim', async () => {
    await loadPiggies(A);
    await loadPiggies(A);
    const legacyReads = jest
      .mocked(SecureStore.getItemAsync)
      .mock.calls.filter(([key]) => key === LEGACY);
    expect(legacyReads).toHaveLength(1);
  });

  it('a failed legacy delete after the copy is finished by anyone, never re-copied', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('keystore busy'));
    await claimLegacyPiggies(A);
    expect(mockStore.has(LEGACY)).toBe(true);
    // App restart, then the other account becomes active.
    __resetLegacyPiggyClaimForTests();
    expect(await loadPiggies(B)).toEqual([]);
    expect(mockStore.has(LEGACY)).toBe(false);
    expect(mockStore.has(LEGACY_MARKER)).toBe(false);
    expect(ids(await loadPiggies(A))).toEqual(['old1']);
  });

  it('an unfinished copy is retried only by the account that started it', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    const set = jest.mocked(SecureStore.setItemAsync);
    const realSet = set.getMockImplementation()!;
    set.mockImplementation(async (key, value) => {
      if (key === piggyStorageKey(A)) throw new Error('write failed');
      return realSet(key, value);
    });
    await claimLegacyPiggies(A);
    set.mockImplementation(realSet);
    expect(mockStore.get(LEGACY_MARKER)).toBe(`pending:${A}`);
    __resetLegacyPiggyClaimForTests();
    expect(await loadPiggies(B)).toEqual([]);
    expect(mockStore.has(LEGACY)).toBe(true);
    expect(ids(await loadPiggies(A))).toEqual(['old1']);
    expect(mockStore.has(LEGACY)).toBe(false);
    expect(await loadPiggies(B)).toEqual([]);
  });

  const failOwnCopy = (owner: string) => {
    const set = jest.mocked(SecureStore.setItemAsync);
    const realSet = set.getMockImplementation()!;
    set.mockImplementation(async (key, value) => {
      if (key === piggyStorageKey(owner)) throw new Error('write failed');
      return realSet(key, value);
    });
    return () => set.mockImplementation(realSet);
  };

  it('warns at sign-out about legacy Piglets the account had started claiming', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    const restore = failOwnCopy(A);
    await claimLegacyPiggies(A);
    restore();
    expect(mockStore.get(LEGACY_MARKER)).toBe(`pending:${A}`);
    expect(await hasStoredPiggies(A)).toBe(true);
    expect(await hasStoredPiggies(B)).toBe(false);
  });

  it('warns at sign-out while the cold-start claim is still copying', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    void claimLegacyPiggies(A);
    expect(await hasStoredPiggies(A)).toBe(true);
  });

  it("a failing sign-out never strands A's legacy Piglets or hands them to B", async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    const restore = failOwnCopy(A);
    await claimLegacyPiggies(A);
    restore();
    // A signs out; reading the claim marker throws, so the wipe can't clean up.
    jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error('keystore busy'));
    await expect(deletePiggiesForOwner(A)).rejects.toThrow();
    expect(mockStore.get(LEGACY_MARKER)).toBe(`pending:${A}`);
    expect(mockStore.has(piggyStorageKey(A))).toBe(false);
    // B is next: the departed claimant's records are deleted, not handed on.
    expect(await loadPiggies(B)).toEqual([]);
    expect(mockStore.has(LEGACY)).toBe(false);
    expect(mockStore.has(LEGACY_MARKER)).toBe(false);
  });

  it('after a restart, a claimant gone from the registry has its legacy Piglets deleted', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    mockStore.set(LEGACY_MARKER, `pending:${A}`);
    registryOf(B);
    expect(await loadPiggies(B)).toEqual([]);
    expect(mockStore.has(LEGACY)).toBe(false);
    expect(mockStore.has(LEGACY_MARKER)).toBe(false);
  });

  it('a sign-out during the claim still leaves nothing behind', async () => {
    mockStore.set(LEGACY, JSON.stringify([piggy('old1')]));
    const claim = claimLegacyPiggies(A);
    await deletePiggiesForOwner(A);
    await claim;
    expect(mockStore.has(piggyStorageKey(A))).toBe(false);
    expect(mockStore.has(LEGACY)).toBe(false);
    expect(await loadPiggies(B)).toEqual([]);
  });
});
