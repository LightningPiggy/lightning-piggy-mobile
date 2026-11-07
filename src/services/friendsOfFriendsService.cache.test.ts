// #565: the friends-of-friends cache is per (account, ranked cap), bounded,
// cancel-safe, and the build yields instead of tallying in one burst.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  buildFofSet,
  buildFofSetYielding,
  computeFofSet,
  fofCacheKey,
  FOF_CACHE_TTL_MS,
  isFofCacheKeyFor,
  loadFofCache,
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

  it('rejects without a result once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      buildFofSetYielding(user, friends, lists, 2000, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
