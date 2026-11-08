/**
 * `persistMergedProfileCache` merge precedence (#852).
 *
 * Now that refreshes can run the profile batch fire-and-forget, two persists
 * can overlap. The helper must re-read the freshest on-disk cache at write
 * time and merge on top of that — so a slow background fetch can't clobber
 * newer profiles a later fetch already wrote — while its own fetched results
 * still win for the keys they cover, and it falls back to the caller's
 * snapshot if the on-disk read/parse fails.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { persistMergedProfileCache, PROFILES_CACHE_KEY_BASE } from './nostrCacheKeys';
import { perAccountKey } from '../services/perAccountStorage';
import type { NostrProfile } from '../types/nostr';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// Run InteractionManager callbacks synchronously so the helper's deferred
// write completes within the test.
jest.mock('react-native', () => ({
  InteractionManager: {
    runAfterInteractions: (task: () => void) => {
      task();
      return { then: (cb: () => void) => cb() };
    },
  },
}));

const PK = 'a'.repeat(64);
const key = perAccountKey(PROFILES_CACHE_KEY_BASE, PK);

const profile = (name: string): NostrProfile =>
  ({ pubkey: name.repeat(64).slice(0, 64), name }) as unknown as NostrProfile;

async function readCache(): Promise<Record<string, NostrProfile>> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? (JSON.parse(raw) as Record<string, NostrProfile>) : {};
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('persistMergedProfileCache (#852)', () => {
  it("merges on top of the freshest on-disk cache, not just the caller's snapshot", async () => {
    // A concurrent fetch already wrote a newer profile for `b` after our
    // snapshot (which only knew `a`) was captured.
    await AsyncStorage.setItem(key, JSON.stringify({ b: profile('b-fresh') }));

    const snapshot = { a: profile('a') };
    const fetched = new Map<string, NostrProfile>([['c', profile('c')]]);
    await persistMergedProfileCache(PK, snapshot, fetched);

    const result = await readCache();
    // All three survive: a (snapshot), b (on-disk newer), c (this fetch).
    expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c']);
    expect(result.b.name).toBe('b-fresh');
  });

  it("lets this fetch's results win over an older on-disk value for the same key", async () => {
    await AsyncStorage.setItem(key, JSON.stringify({ a: profile('a-old') }));

    const fetched = new Map<string, NostrProfile>([['a', profile('a-new')]]);
    await persistMergedProfileCache(PK, {}, fetched);

    const result = await readCache();
    expect(result.a.name).toBe('a-new');
  });

  it('never lets an older kind-0 (a late fallback) overwrite a newer cached one (#1390)', async () => {
    const dated = (name: string, createdAt: number) => ({ ...profile(name), createdAt });
    await AsyncStorage.setItem(key, JSON.stringify({ a: dated('a-new', 200), b: dated('b', 1) }));

    const fetched = new Map<string, NostrProfile>([
      ['a', dated('a-stale', 100)],
      ['b', dated('b-newer', 2)],
    ]);
    await persistMergedProfileCache(PK, {}, fetched);

    const result = await readCache();
    expect(result.a.name).toBe('a-new');
    expect(result.b.name).toBe('b-newer');
  });

  it('serialises overlapping persists: no lost additions, no older kind-0 written last (#1390)', async () => {
    const dated = (name: string, createdAt: number) => ({ ...profile(name), createdAt });
    // Both start before either writes: unsynchronised, both would read the
    // same (empty) cache and the second write would win outright.
    const first = persistMergedProfileCache(
      PK,
      {},
      new Map<string, NostrProfile>([
        ['a', dated('a-new', 200)],
        ['c', dated('c', 1)],
      ]),
    );
    const second = persistMergedProfileCache(
      PK,
      {},
      new Map<string, NostrProfile>([
        ['a', dated('a-stale', 100)],
        ['b', dated('b', 1)],
      ]),
    );
    await Promise.all([first, second]);

    const result = await readCache();
    expect(result.a.name).toBe('a-new');
    expect(Object.keys(result).sort()).toEqual(['a', 'b', 'c']);
  });

  it('falls back to the caller snapshot when the on-disk cache is corrupt', async () => {
    await AsyncStorage.setItem(key, '{not valid json');

    const snapshot = { a: profile('a') };
    await persistMergedProfileCache(PK, snapshot, new Map());

    const result = await readCache();
    expect(result.a.name).toBe('a');
  });
});
