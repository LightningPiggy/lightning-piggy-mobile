import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  __resetLegacyPiggyClaimForTests,
  claimLegacyPiggies,
  deletePiggiesForOwner,
  findPiggy,
  loadPiggies,
  piggyStorageKey,
  removePiggy,
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

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const LEGACY = 'hunt-piggies-v1';
const LEGACY_IOS = 'hunt-piggies:v1';

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
    await expect(savePiggy(null, piggy('x'))).rejects.toThrow();
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
