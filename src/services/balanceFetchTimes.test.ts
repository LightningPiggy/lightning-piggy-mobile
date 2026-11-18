import {
  __resetBalanceFetchTimesForTests,
  balanceFetchedAt,
  noteBalanceFetched,
  subscribeBalanceFetches,
} from './balanceFetchTimes';

beforeEach(() => __resetBalanceFetchTimesForTests());

describe('balanceFetchTimes', () => {
  it('knows nothing until a balance is fetched, then the latest fetch time', () => {
    expect(balanceFetchedAt('w1')).toBeNull();
    noteBalanceFetched('w1', 1000);
    noteBalanceFetched('w1', 2000);
    noteBalanceFetched('w2', 1500);
    expect(balanceFetchedAt('w1')).toBe(2000);
    expect(balanceFetchedAt('w2')).toBe(1500);
  });

  it('tells subscribers, and a throwing subscriber never breaks the read', () => {
    const seen: string[] = [];
    subscribeBalanceFetches(() => {
      throw new Error('boom');
    });
    const stop = subscribeBalanceFetches((id) => seen.push(id));
    expect(() => noteBalanceFetched('w1')).not.toThrow();
    stop();
    noteBalanceFetched('w2');
    expect(seen).toEqual(['w1']);
  });
});
