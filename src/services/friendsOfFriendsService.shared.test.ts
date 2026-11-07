// The Messages Web of Trust tier and the Market's friends-of-friends scope
// share one ranked set (FOF_SHARED_MAX): one fetch, one cache, one copy in
// memory — with per-caller cancel and per-account isolation.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetFofMemory,
  buildFofSet,
  computeFofSet,
  dropFofCache,
  fofCacheKey,
  FOF_SHARED_MAX,
  loadFofCache,
  retireFofCache,
} from './friendsOfFriendsService';

const pk = (label: string, n = 0) => `${label}_${n}`.padStart(64, '0').slice(-64);
const user = pk('u');
const other = pk('v');
const friends = Array.from({ length: 120 }, (_, i) => pk('friend', i));
const MARKET_CAP = 1024;

// Overlapping follows, so candidates are followed by different numbers of
// friends and the ranking actually orders them.
const followsOf = (friend: string): string[] => {
  const n = Number(friend.split('_')[1] ?? 0);
  return Array.from({ length: 60 }, (_, j) => pk('pool', (n * 37 + j * 101) % 4000));
};
const lists = Object.fromEntries(friends.map((f) => [f, followsOf(f)]));
const fetchKind3 = jest.fn(async (batch: string[], _signal: AbortSignal) =>
  Object.fromEntries(batch.map((f) => [f, followsOf(f)])),
);

// Holds every fetch until released, so two callers can overlap.
const gated = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const signals: AbortSignal[] = [];
  const fetch = jest.fn(async (batch: string[], signal: AbortSignal) => {
    signals.push(signal);
    await gate;
    return fetchKind3(batch, signal);
  });
  return { fetch, release, signals };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  await AsyncStorage.clear();
  __resetFofMemory();
  fetchKind3.mockClear();
  (AsyncStorage.getItem as jest.Mock).mockClear();
});

it("the shared set's first 1024 are exactly a 1024-capped build", () => {
  const shared = buildFofSet(user, friends, lists, FOF_SHARED_MAX);
  const market = buildFofSet(user, friends, lists, MARKET_CAP);
  expect(shared.set.size).toBeGreaterThan(MARKET_CAP);
  expect([...shared.set].slice(0, MARKET_CAP)).toEqual([...market.set]);
});

describe('in-memory set', () => {
  it('a set one consumer built is read by the other without touching storage', async () => {
    const built = await computeFofSet(user, friends, { fetchKind3, maxSize: FOF_SHARED_MAX });
    const getItem = AsyncStorage.getItem as jest.Mock;
    getItem.mockClear();
    const read = await loadFofCache(user, friends, FOF_SHARED_MAX);
    expect(getItem).not.toHaveBeenCalled();
    expect(read?.set).toBe(built.set);
    expect(read?.stale).toBe(false);
  });

  it('a set read from storage is remembered for the next reader', async () => {
    await computeFofSet(user, friends, { fetchKind3, maxSize: FOF_SHARED_MAX });
    __resetFofMemory(); // as after an app restart
    const getItem = AsyncStorage.getItem as jest.Mock;
    getItem.mockClear();
    const first = await loadFofCache(user, friends, FOF_SHARED_MAX);
    const second = await loadFofCache(user, friends, FOF_SHARED_MAX);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(second?.set).toBe(first?.set);
  });

  it('keeps the TTL and follow-change rules', async () => {
    await computeFofSet(user, friends, { fetchKind3, maxSize: FOF_SHARED_MAX });
    const changed = friends.slice(1);
    expect(await loadFofCache(user, changed, FOF_SHARED_MAX)).toBeNull();
    expect((await loadFofCache(user, changed, FOF_SHARED_MAX, { allowStale: true }))?.stale).toBe(
      true,
    );
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 60 * 60 * 1000);
    try {
      expect(await loadFofCache(user, friends, FOF_SHARED_MAX)).toBeNull();
    } finally {
      now.mockRestore();
    }
  });

  it("never hands one account another's set, and a sign-out forgets it", async () => {
    await computeFofSet(user, friends, { fetchKind3, maxSize: FOF_SHARED_MAX });
    expect(await loadFofCache(other, friends, FOF_SHARED_MAX)).toBeNull();
    await retireFofCache(user);
    await AsyncStorage.removeItem(fofCacheKey(user, FOF_SHARED_MAX)); // the wipe's key scan
    expect(await loadFofCache(user, friends, FOF_SHARED_MAX)).toBeNull();
  });

  it('dropFofCache removes one cap from memory and storage', async () => {
    await computeFofSet(user, friends, { fetchKind3, maxSize: MARKET_CAP });
    await computeFofSet(user, friends, { fetchKind3, maxSize: FOF_SHARED_MAX });
    await dropFofCache(user, MARKET_CAP);
    expect(await AsyncStorage.getItem(fofCacheKey(user, MARKET_CAP))).toBeNull();
    expect(await loadFofCache(user, friends, MARKET_CAP)).toBeNull();
    expect(await loadFofCache(user, friends, FOF_SHARED_MAX)).not.toBeNull();
  });
});

describe('shared build', () => {
  const batches = Math.ceil(friends.length / 50);

  it('two consumers asking at once pay for one fetch', async () => {
    const { fetch, release } = gated();
    const progressA = jest.fn();
    const progressB = jest.fn();
    const a = computeFofSet(user, friends, {
      fetchKind3: fetch,
      maxSize: FOF_SHARED_MAX,
      onProgress: progressA,
    });
    await flush();
    const b = computeFofSet(user, friends, {
      fetchKind3: jest.fn(),
      maxSize: FOF_SHARED_MAX,
      onProgress: progressB,
    });
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetch).toHaveBeenCalledTimes(batches);
    expect(rb.set).toBe(ra.set);
    expect(progressA).toHaveBeenLastCalledWith(batches, batches);
    expect(progressB).toHaveBeenLastCalledWith(batches, batches);
  });

  it('a late joiner sees the progress so far', async () => {
    const { fetch, release } = gated();
    const a = computeFofSet(user, friends, { fetchKind3: fetch, maxSize: FOF_SHARED_MAX });
    release();
    await flush();
    const progress = jest.fn();
    const b = computeFofSet(user, friends, {
      fetchKind3: fetch,
      maxSize: FOF_SHARED_MAX,
      onProgress: progress,
    });
    await Promise.all([a, b]);
    expect(progress).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(batches);
  });

  it("one consumer's cancel leaves the other's build running", async () => {
    const { fetch, release, signals } = gated();
    const cancelA = new AbortController();
    const a = computeFofSet(user, friends, {
      fetchKind3: fetch,
      maxSize: FOF_SHARED_MAX,
      signal: cancelA.signal,
    });
    await flush();
    const b = computeFofSet(user, friends, {
      fetchKind3: fetch,
      maxSize: FOF_SHARED_MAX,
      signal: new AbortController().signal,
    });
    cancelA.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0].aborted).toBe(false);
    release();
    const result = await b;
    expect(result.set.size).toBe(FOF_SHARED_MAX);
    expect(await AsyncStorage.getItem(fofCacheKey(user, FOF_SHARED_MAX))).not.toBeNull();
  });

  it('the build stops, persisting nothing, once every consumer cancelled', async () => {
    const { fetch, release, signals } = gated();
    const cancelA = new AbortController();
    const cancelB = new AbortController();
    const a = computeFofSet(user, friends, {
      fetchKind3: fetch,
      maxSize: FOF_SHARED_MAX,
      signal: cancelA.signal,
    });
    await flush();
    const b = computeFofSet(user, friends, {
      fetchKind3: fetch,
      maxSize: FOF_SHARED_MAX,
      signal: cancelB.signal,
    });
    cancelA.abort();
    cancelB.abort();
    await expect(a).rejects.toMatchObject({ name: 'AbortError' });
    await expect(b).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0].aborted).toBe(true);
    release();
    await flush();
    expect(await AsyncStorage.getItem(fofCacheKey(user, FOF_SHARED_MAX))).toBeNull();
    // The next request starts a fresh build rather than joining the dead one.
    const fresh = await computeFofSet(user, friends, { fetchKind3, maxSize: FOF_SHARED_MAX });
    expect(fresh.set.size).toBe(FOF_SHARED_MAX);
  });

  it('never shares a build across accounts, follow lists or caps', async () => {
    const { fetch, release } = gated();
    const runs = [
      computeFofSet(user, friends, { fetchKind3: fetch, maxSize: FOF_SHARED_MAX }),
      computeFofSet(other, friends, { fetchKind3: fetch, maxSize: FOF_SHARED_MAX }),
      computeFofSet(user, friends.slice(1), { fetchKind3: fetch, maxSize: FOF_SHARED_MAX }),
      computeFofSet(user, friends, { fetchKind3: fetch, maxSize: MARKET_CAP }),
    ];
    release();
    await Promise.all(runs);
    expect(fetch).toHaveBeenCalledTimes(batches * 4);
  });

  it('a build retired by a sign-out is not joined by the next login', async () => {
    const { fetch, release } = gated();
    const before = computeFofSet(user, friends, { fetchKind3: fetch, maxSize: FOF_SHARED_MAX });
    await flush();
    await retireFofCache(user);
    const after = computeFofSet(user, friends, { fetchKind3: fetch, maxSize: FOF_SHARED_MAX });
    release();
    await Promise.all([before, after]);
    expect(fetch).toHaveBeenCalledTimes(batches * 2);
  });
});
