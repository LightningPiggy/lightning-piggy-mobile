// Heuristic 4 (ranked cap) and the cached pipeline the Market's
// friends-of-friends scope builds on.
import { marketFofAuthors, MARKET_FOF_MAX } from '../utils/marketFofScope';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildFofSet, computeFofSet, loadFofCache } from './friendsOfFriendsService';

const pk = (label: string, n = 0) => `${label}_${n}`.padStart(64, '0').slice(-64);
const user = pk('u');
const [a, b, c] = [pk('a'), pk('b'), pk('c')];

beforeEach(() => AsyncStorage.clear());

describe('buildFofSet maxSize (heuristic 4)', () => {
  const lists = {
    [a]: [pk('x', 1), pk('shared', 1), pk('shared', 2)],
    [b]: [pk('shared', 1), pk('y', 1), pk('shared', 2)],
    [c]: [pk('shared', 1), pk('z', 1)],
  };

  it('keeps the pubkeys followed by the most friends, most-shared first', () => {
    const { set } = buildFofSet(user, [a, b, c], lists, 2);
    expect([...set]).toEqual([pk('shared', 1), pk('shared', 2)]);
  });

  it('breaks ties by discovery order', () => {
    const { set } = buildFofSet(user, [a, b, c], lists, 3);
    expect([...set]).toEqual([pk('shared', 1), pk('shared', 2), pk('x', 1)]);
  });

  it('ranks even when the set already fits, preserving discovery order without a cap)', () => {
    const uncapped = [...buildFofSet(user, [a, b, c], lists).set];
    expect([...buildFofSet(user, [a, b, c], lists, 100).set]).toEqual([
      pk('shared', 1),
      pk('shared', 2),
      pk('x', 1),
      pk('y', 1),
      pk('z', 1),
    ]);
    expect(uncapped).toHaveLength(5);
  });
});

describe('computeFofSet + cache with a ranked cap', () => {
  const fetchKind3 = jest.fn(async (batch: string[]) =>
    Object.fromEntries(batch.map((f) => [f, [pk('shared'), pk(`only-${f.slice(-3)}`)]])),
  );

  it('builds, reports progress, and caches the capped set for the same cap only', async () => {
    const progress: [number, number][] = [];
    const result = await computeFofSet(user, [a, b], {
      fetchKind3,
      maxSize: 1,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect([...result.set]).toEqual([pk('shared')]);
    expect(progress).toEqual([[1, 1]]);
    expect([...(await loadFofCache(user, [a, b], 1))!.set]).toEqual([pk('shared')]);
    // A reader with another cap (or none) must not reuse a capped set.
    expect(await loadFofCache(user, [a, b], 5)).toBeNull();
    expect(await loadFofCache(user, [a, b])).toBeNull();
    // A follow / unfollow invalidates it too.
    expect(await loadFofCache(user, [a], 1)).toBeNull();
  });

  it('rejects (and caches nothing) when the fetch is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      computeFofSet(user, [a], { fetchKind3, maxSize: 1, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(await loadFofCache(user, [a], 1)).toBeNull();
  });
});

it('counts distinct friends rather than duplicate follow tags or duplicate friend inputs', () => {
  const lists = { [a]: [pk('x'), pk('x'), pk('y')], [b]: [pk('y')] };
  expect([...buildFofSet(user, [a, a, b], lists, 100).set]).toEqual([pk('y'), pk('x')]);
});

it('retains the strongest FoF candidates when direct friends leave only two author slots', () => {
  const friends = Array.from({ length: 1022 }, (_, i) => pk('friend', i));
  const [first, second, shared] = [pk('first'), pk('second'), pk('shared')];
  const lists = { [friends[0]]: [first, second, shared], [friends[1]]: [shared] };
  const fof = buildFofSet(user, friends, lists, MARKET_FOF_MAX);
  expect(marketFofAuthors(friends, [...fof.set]).slice(-2)).toEqual([shared, first]);
});
