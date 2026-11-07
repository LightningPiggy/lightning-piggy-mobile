import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __TEST__,
  __resetForTests,
  getVerifiedLud16,
  peekVerifiedLud16,
  recordVerifiedLud16,
} from './verifiedLud16Cache';

const PK = 'a'.repeat(64);

describe('verifiedLud16Cache (#1719)', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    __resetForTests();
    jest.useRealTimers();
  });

  it('returns nothing for an unknown pubkey', async () => {
    expect(await getVerifiedLud16(PK)).toBeNull();
    expect(peekVerifiedLud16(PK)).toBeNull();
  });

  it('round-trips through storage across a cold start', async () => {
    await recordVerifiedLud16(PK, 'eden@example.com', 100);
    __resetForTests();
    expect(peekVerifiedLud16(PK)).toBeNull(); // mirror not loaded yet
    expect(await getVerifiedLud16(PK)).toBe('eden@example.com');
    expect(peekVerifiedLud16(PK)).toBe('eden@example.com');
  });

  it('a newer kind-0 replaces the address', async () => {
    await recordVerifiedLud16(PK, 'old@example.com', 100);
    expect(await recordVerifiedLud16(PK, 'new@example.com', 200)).toBe('new@example.com');
    expect(await getVerifiedLud16(PK)).toBe('new@example.com');
  });

  it('a newer kind-0 without an address clears it', async () => {
    await recordVerifiedLud16(PK, 'old@example.com', 100);
    expect(await recordVerifiedLud16(PK, null, 200)).toBeNull();
    expect(await getVerifiedLud16(PK)).toBeNull();
  });

  it('an older kind-0 from a stale relay cannot resurrect a replaced address', async () => {
    await recordVerifiedLud16(PK, 'new@example.com', 200);
    expect(await recordVerifiedLud16(PK, 'old@example.com', 100)).toBe('new@example.com');
    await recordVerifiedLud16(PK, null, 300);
    expect(await recordVerifiedLud16(PK, 'new@example.com', 200)).toBeNull();
    expect(await getVerifiedLud16(PK)).toBeNull();
  });

  it('stops seeding an address not re-confirmed within the TTL', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    await recordVerifiedLud16(PK, 'eden@example.com', 100);
    jest.setSystemTime(1_000_000 + __TEST__.TTL_MS + 1);
    expect(peekVerifiedLud16(PK)).toBeNull();
    expect(await getVerifiedLud16(PK)).toBeNull();
    // A fresh verified fetch of the same event re-arms it.
    await recordVerifiedLud16(PK, 'eden@example.com', 100);
    expect(peekVerifiedLud16(PK)).toBe('eden@example.com');
  });

  it('skips rewriting storage for a same-event re-confirmation', async () => {
    await recordVerifiedLud16(PK, 'eden@example.com', 100);
    // The storage mock's setItem is already a jest.fn: count, don't spy.
    const { calls } = (AsyncStorage.setItem as jest.Mock).mock;
    const before = calls.length;
    await recordVerifiedLud16(PK, 'eden@example.com', 100);
    expect(calls.length).toBe(before);
  });

  it('evicts the least recently confirmed entries past the cap', async () => {
    const { MAX_ENTRIES } = __TEST__;
    for (let i = 0; i <= MAX_ENTRIES; i++) {
      await recordVerifiedLud16(i.toString(16).padStart(64, '0'), `u${i}@example.com`, 1);
    }
    const stored = JSON.parse((await AsyncStorage.getItem(__TEST__.STORAGE_KEY)) ?? '{}');
    expect(Object.keys(stored)).toHaveLength(MAX_ENTRIES);
    expect(await getVerifiedLud16('0'.padStart(64, '0'))).toBeNull();
    expect(await getVerifiedLud16(MAX_ENTRIES.toString(16).padStart(64, '0'))).toBe(
      `u${MAX_ENTRIES}@example.com`,
    );
  });

  it('starts empty when the stored blob is corrupt', async () => {
    await AsyncStorage.setItem(__TEST__.STORAGE_KEY, '{not json');
    expect(await getVerifiedLud16(PK)).toBeNull();
    expect(await recordVerifiedLud16(PK, 'eden@example.com', 1)).toBe('eden@example.com');
  });
});
