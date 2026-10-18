import { MARKET_FOF_MAX, marketFofAuthors } from './marketFofScope';

const pk = (n: number) => n.toString(16).padStart(64, '0');

describe('marketFofAuthors', () => {
  it('puts follows first, then friends-of-friends in rank order, de-duplicated', () => {
    expect(marketFofAuthors([pk(1), pk(2)], [pk(9), pk(2), pk(8)])).toEqual([
      pk(1),
      pk(2),
      pk(9),
      pk(8),
    ]);
  });

  it('lowercases and caps the set, never cutting a follow for a friend-of-friend', () => {
    const friends = [pk(1).toUpperCase(), pk(2)];
    const fof = Array.from({ length: 10 }, (_, i) => pk(100 + i));
    const out = marketFofAuthors(friends, fof, 5);
    expect(out).toEqual([pk(1), pk(2), pk(100), pk(101), pk(102)]);
  });

  it('defaults to the listings service author ceiling', () => {
    const fof = Array.from({ length: MARKET_FOF_MAX + 50 }, (_, i) => pk(i + 1));
    expect(marketFofAuthors([], fof)).toHaveLength(MARKET_FOF_MAX);
  });
});
