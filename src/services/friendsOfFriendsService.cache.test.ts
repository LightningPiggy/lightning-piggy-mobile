// #565: the friends-of-friends cache is per (account, ranked cap), bounded,
// cancel-safe, and the build yields instead of tallying in one burst.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as pacing from '../contexts/nostrDecryptPacing';
import {
  buildFofSet,
  buildFofSetYielding,
  computeFofSet,
  fofCacheKey,
  FOF_CACHE_TTL_MS,
  isFofCacheKeyFor,
  loadFofCache,
  retireFofCache,
  __resetFofMemory,
} from './friendsOfFriendsService';

const pk = (label: string, n = 0) => `${label}_${n}`.padStart(64, '0').slice(-64);
const user = pk('u');
const other = pk('v');
const friends = Array.from({ length: 120 }, (_, i) => pk('friend', i));

// Every friend follows 40 people from a shared pool of 5000, so the
// uncapped union is far bigger than either cap.
const followsOf = (friend: string): string[] => {
  const n = Number(friend.split('_')[1] ?? 0);
  return Array.from({ length: 40 }, (_, j) => pk('pool', (n * 37 + j * 101) % 5000));
};
const fetchKind3 = jest.fn(async (batch: string[]) =>
  Object.fromEntries(batch.map((f) => [f, followsOf(f)])),
);

beforeEach(async () => {
  await AsyncStorage.clear();
  __resetFofMemory();
  fetchKind3.mockClear();
});

describe('cache layout', () => {
  it('keys the set by account and cap', () => {
    expect(fofCacheKey(user, 2000)).toBe(`@lp:wot-fof:v3:cap-2000_${user}`);
    expect(fofCacheKey(user.toUpperCase(), 1024)).toBe(`@lp:wot-fof:v3:cap-1024_${user}`);
    expect(fofCacheKey(user)).toBe(`@lp:wot-fof:v3:cap-all_${user}`);
    expect(isFofCacheKeyFor(fofCacheKey(user, 2000), user)).toBe(true);
    expect(isFofCacheKeyFor(fofCacheKey(other, 2000), user)).toBe(false);
    expect(isFofCacheKeyFor('@lp:wot-settings:v1_' + user, user)).toBe(false);
  });

  it("keeps the Market's cap and the Web of Trust cap side by side", async () => {
    const market = await computeFofSet(user, friends, { fetchKind3, maxSize: 1024 });
    const wot = await computeFofSet(user, friends, { fetchKind3, maxSize: 2000 });
    expect(market.set.size).toBe(1024);
    expect(wot.set.size).toBe(2000);
    expect((await loadFofCache(user, friends, 1024))!.set).toEqual(market.set);
    expect((await loadFofCache(user, friends, 2000))!.set).toEqual(wot.set);
  });

  it("never hands one account another account's set", async () => {
    await computeFofSet(user, friends, { fetchKind3, maxSize: 2000 });
    expect(await loadFofCache(other, friends, 2000)).toBeNull();
    expect(await loadFofCache(other, friends, 2000, { allowStale: true })).toBeNull();
  });

  it('respects the cap and stores far below the 2 MB CursorWindow ceiling', async () => {
    const big = Array.from({ length: 400 }, (_, i) => pk('friend', i));
    const result = await computeFofSet(user, big, { fetchKind3, maxSize: 2000 });
    expect(result.set.size).toBe(2000);
    const raw = await AsyncStorage.getItem(fofCacheKey(user, 2000));
    expect(raw!.length).toBeLessThan(150_000);
  });
});

describe('staleness', () => {
  it('serves an expired or follow-list-mismatched set only when asked for stale data', async () => {
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    await computeFofSet(user, friends, { fetchKind3, maxSize: 2000 });
    expect((await loadFofCache(user, friends, 2000))!.stale).toBe(false);

    spy.mockReturnValue(now + FOF_CACHE_TTL_MS + 1);
    expect(await loadFofCache(user, friends, 2000)).toBeNull();
    const expired = await loadFofCache(user, friends, 2000, { allowStale: true });
    expect(expired!.stale).toBe(true);
    expect(expired!.set.size).toBe(2000);

    spy.mockReturnValue(now);
    const followedSomeone = [...friends, pk('new')];
    expect(await loadFofCache(user, followedSomeone, 2000)).toBeNull();
    expect((await loadFofCache(user, followedSomeone, 2000, { allowStale: true }))!.stale).toBe(
      true,
    );
    spy.mockRestore();
  });
});

describe('cancel safety', () => {
  it('writes nothing when cancelled between follow-list batches', async () => {
    const controller = new AbortController();
    const fetchThenCancel = jest.fn(async (batch: string[]) => {
      const lists = await fetchKind3(batch);
      controller.abort(); // user taps Cancel while batch 1 is in flight
      return lists;
    });
    await expect(
      computeFofSet(user, friends, {
        fetchKind3: fetchThenCancel,
        maxSize: 2000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchThenCancel).toHaveBeenCalledTimes(1); // batches 2 + 3 never fetched
    expect(await AsyncStorage.getItem(fofCacheKey(user, 2000))).toBeNull();
  });
});

describe('flaky batches', () => {
  const noRelay = () => new Error('No follow-list relay answered');

  it('retries a failed batch once and completes', async () => {
    const flaky = jest.fn(fetchKind3).mockRejectedValueOnce(noRelay());
    const result = await computeFofSet(user, friends, { fetchKind3: flaky, maxSize: 2000 });
    expect(flaky).toHaveBeenCalledTimes(4); // 3 batches + 1 retry
    expect(result.set.size).toBeGreaterThan(0);
    expect(await AsyncStorage.getItem(fofCacheKey(user, 2000))).not.toBeNull();
  });

  it('fails (persisting nothing) when the retry fails too', async () => {
    const down = jest
      .fn(fetchKind3)
      .mockRejectedValueOnce(noRelay())
      .mockRejectedValueOnce(noRelay());
    await expect(computeFofSet(user, friends, { fetchKind3: down, maxSize: 2000 })).rejects.toThrow(
      'No follow-list relay answered',
    );
    expect(down).toHaveBeenCalledTimes(2);
    expect(await AsyncStorage.getItem(fofCacheKey(user, 2000))).toBeNull();
  });

  it('never retries an abort', async () => {
    const aborting = jest
      .fn(fetchKind3)
      .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(
      computeFofSet(user, friends, { fetchKind3: aborting, maxSize: 2000 }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborting).toHaveBeenCalledTimes(1);
  });
});

it('keeps only FANOUT_CAP + 1 follows per friend yet gives the same set as the full lists', async () => {
  // Two over-cap friends (700 follows) among eight normal ones: heuristic 1
  // must still see them as over the cap after trimming.
  const ten = friends.slice(0, 10);
  const lists = Object.fromEntries(
    ten.map((f, i) => [
      f,
      Array.from({ length: i < 2 ? 700 : 40 }, (_, j) => pk('pool', (i * 53 + j * 7) % 900)),
    ]),
  );
  const result = await computeFofSet(user, ten, {
    fetchKind3: async (batch) => Object.fromEntries(batch.map((f) => [f, lists[f]])),
    maxSize: 2000,
  });
  const full = buildFofSet(user, ten, lists, 2000);
  expect([...result.set]).toEqual([...full.set]);
  expect(result.excludedFriends).toBe(2);
});

describe('sign-out retirement', () => {
  it('a build still running when the account is wiped never writes its graph back', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slowFetch = jest.fn(async (batch: string[]) => {
      await gate;
      return fetchKind3(batch);
    });
    const build = computeFofSet(user, friends.slice(0, 10), {
      fetchKind3: slowFetch,
      maxSize: 2000,
    });
    await retireFofCache(user); // sign-out wipe runs mid-build
    release();
    await build;
    expect(await AsyncStorage.getItem(fofCacheKey(user, 2000))).toBeNull();

    // A build started after the wipe (re-login) persists as normal.
    await computeFofSet(user, friends.slice(0, 10), { fetchKind3, maxSize: 2000 });
    expect(await AsyncStorage.getItem(fofCacheKey(user, 2000))).not.toBeNull();
  });
});

describe('buildFofSetYielding', () => {
  const lists = Object.fromEntries(friends.map((f) => [f, followsOf(f)]));

  it('matches the synchronous build, capped and uncapped', async () => {
    for (const cap of [undefined, 50, 2000]) {
      const sync = buildFofSet(user, friends, lists, cap);
      const yielded = await buildFofSetYielding(user, friends, lists, cap);
      expect([...yielded.set]).toEqual([...sync.set]);
      expect(yielded.excludedFriends).toBe(sync.excludedFriends);
    }
  });

  it('offers the scheduler a yield per friend tallied and per 1024 candidates ranked', async () => {
    const maybeYield = jest.fn(async () => {});
    const spy = jest
      .spyOn(pacing, 'createYieldScheduler')
      .mockReturnValue({ maybeYield, yieldCount: 0, dispose: jest.fn() });
    // 10 friends × 300 disjoint follows = 3000 distinct candidates.
    const few = friends.slice(0, 10);
    const disjoint = Object.fromEntries(
      few.map((f, i) => [f, Array.from({ length: 300 }, (_, j) => pk(`d${i}`, j))]),
    );
    await buildFofSetYielding(user, few, disjoint, 2000);
    // 10 (tally) + 1 (before ranking) + floor(3000 / 1024) = 2 (ranking).
    expect(maybeYield).toHaveBeenCalledTimes(13);
    spy.mockRestore();
  });

  it('rejects without a result once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildFofSetYielding(user, friends, lists, 2000, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
