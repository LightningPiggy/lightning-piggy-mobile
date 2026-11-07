import AsyncStorage from '@react-native-async-storage/async-storage';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fetchProfile, pool } from './nostrService';
import {
  __flushWritesForTests,
  __resetForTests,
  clearVerifiedLud16Cache,
  getVerifiedLud16,
} from './verifiedLud16Cache';

// fetchProfile feeds payment destinations, so only a signature-verified
// kind-0 BY the requested pubkey may reach the Lightning-address cache (#1719).
const sk = generateSecretKey();
const pubkey = getPublicKey(sk);

function kind0(lud16: string | null, createdAt: number) {
  return finalizeEvent(
    { kind: 0, created_at: createdAt, tags: [], content: JSON.stringify({ name: 'Eden', lud16 }) },
    sk,
  );
}

describe('fetchProfile → verified lud16 cache (#1719)', () => {
  let get: jest.SpyInstance;
  beforeEach(async () => {
    await AsyncStorage.clear();
    __resetForTests();
    get = jest.spyOn(pool, 'get');
  });
  afterEach(() => get.mockRestore());

  it('caches the address from a verified kind-0', async () => {
    get.mockResolvedValue(kind0('eden@example.com', 100));
    expect((await fetchProfile(pubkey, []))?.lud16).toBe('eden@example.com');
    expect(await getVerifiedLud16(pubkey)).toBe('eden@example.com');
  });

  it('ignores a kind-0 with a forged signature', async () => {
    const forged = { ...kind0('attacker@example.com', 100), sig: 'f'.repeat(128) };
    get.mockResolvedValue(forged);
    expect(await fetchProfile(pubkey, [])).toBeNull();
    expect(await getVerifiedLud16(pubkey)).toBeNull();
  });

  it("ignores another author's validly signed kind-0", async () => {
    const other = finalizeEvent(
      { kind: 0, created_at: 100, tags: [], content: '{"lud16":"attacker@example.com"}' },
      generateSecretKey(),
    );
    get.mockResolvedValue(other);
    expect(await fetchProfile(pubkey, [])).toBeNull();
    expect(await getVerifiedLud16(pubkey)).toBeNull();
  });

  it('returns the newest verified address when a stale relay answers', async () => {
    get.mockResolvedValueOnce(kind0('new@example.com', 200));
    await fetchProfile(pubkey, []);
    get.mockResolvedValueOnce(kind0('old@example.com', 100));
    expect((await fetchProfile(pubkey, []))?.lud16).toBe('new@example.com');
  });

  it('a fetch in flight across a logout wipe writes nothing into the next account', async () => {
    let resolveGet!: (event: ReturnType<typeof kind0>) => void;
    get.mockReturnValueOnce(new Promise((resolve) => (resolveGet = resolve)));
    const fetching = fetchProfile(pubkey, []);
    await clearVerifiedLud16Cache();
    const { calls } = (AsyncStorage.setItem as jest.Mock).mock;
    const before = calls.length;
    resolveGet(kind0('eden@example.com', 100));
    // The caller still gets the verified address; only the cache is skipped.
    expect((await fetching)?.lud16).toBe('eden@example.com');
    await __flushWritesForTests();
    expect(calls.length).toBe(before);
    expect(await getVerifiedLud16(pubkey)).toBeNull();
    __resetForTests();
    expect(await getVerifiedLud16(pubkey)).toBeNull();
  });

  it('clears the cached address when the newer kind-0 removed it', async () => {
    get.mockResolvedValueOnce(kind0('old@example.com', 100));
    await fetchProfile(pubkey, []);
    get.mockResolvedValueOnce(kind0(null, 200));
    expect((await fetchProfile(pubkey, []))?.lud16).toBeNull();
    expect(await getVerifiedLud16(pubkey)).toBeNull();
  });
});
