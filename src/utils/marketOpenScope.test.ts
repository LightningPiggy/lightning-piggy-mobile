import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';
import {
  curateOpenListingEvents,
  curateOpenListingProducts,
  OPEN_SCOPE_PER_AUTHOR,
  passesOpenScopeHygiene,
  withKnownProfiles,
} from './marketOpenScope';
import { parseMarketListing } from './marketListings';
import type { MarketProduct } from '../data/marketProducts';

const keyOf = (n: number) => new Uint8Array(32).fill(n);
const listing = (
  n: number,
  d: string,
  createdAt: number,
  tags: string[][] = [
    ['title', `Thing ${d}`],
    ['price', '21', 'SAT'],
    ['image', 'https://img.example/x.png'],
  ],
) =>
  finalizeEvent(
    { kind: 30402, created_at: createdAt, content: '', tags: [['d', d], ...tags] },
    keyOf(n),
  );
const productOf = (event: ReturnType<typeof listing>) => parseMarketListing(event, 0)!;

describe('passesOpenScopeHygiene', () => {
  it('requires an image and a positive price (title/price shape is the parser’s job)', () => {
    expect(passesOpenScopeHygiene(productOf(listing(1, 'ok', 10)))).toBe(true);
    const noImage = listing(1, 'a', 10, [
      ['title', 'A'],
      ['price', '21', 'SAT'],
    ]);
    expect(passesOpenScopeHygiene(productOf(noImage))).toBe(false);
    const free = listing(1, 'b', 10, [
      ['title', 'B'],
      ['price', '0', 'SAT'],
      ['image', 'https://img.example/x.png'],
    ]);
    expect(passesOpenScopeHygiene(productOf(free))).toBe(false);
    const fiat = listing(1, 'c', 10, [
      ['title', 'C'],
      ['price', '12.50', 'EUR'],
      ['image', 'https://img.example/x.png'],
    ]);
    expect(passesOpenScopeHygiene(productOf(fiat))).toBe(true);
  });

  it('a listing missing its title or price never parses at all', () => {
    expect(parseMarketListing(listing(1, 'x', 10, [['price', '21', 'SAT']]), 0)).toBeNull();
    expect(parseMarketListing(listing(1, 'y', 10, [['title', 'Y']]), 0)).toBeNull();
  });
});

describe('curateOpenListingEvents', () => {
  it('drops listings without an image and keeps at most N newest per seller', async () => {
    const flood = Array.from({ length: OPEN_SCOPE_PER_AUTHOR + 5 }, (_, i) =>
      listing(2, `spam-${i}`, 1000 - i),
    );
    const noImage = listing(3, 'bare', 900, [
      ['title', 'Bare'],
      ['price', '5', 'SAT'],
    ]);
    const honest = listing(4, 'honest', 800);
    const out = await curateOpenListingEvents([...flood, noImage, honest], {
      now: 0,
      verify: verifyEvent,
    });
    const fromSpammer = out.filter((e) => e.pubkey === getPublicKey(keyOf(2)));
    expect(fromSpammer).toHaveLength(OPEN_SCOPE_PER_AUTHOR);
    expect(fromSpammer.map((e) => e.tags[0][1])).toEqual(
      Array.from({ length: OPEN_SCOPE_PER_AUTHOR }, (_, i) => `spam-${i}`),
    );
    expect(out).not.toContain(noImage);
    expect(out).toContain(honest);
  });

  it('keeps the authenticated winner of each address', async () => {
    const older = listing(5, 'lamp', 100);
    const newer = listing(5, 'lamp', 200);
    const soldNewer = listing(6, 'chair', 300, [
      ['title', 'Chair'],
      ['price', '9', 'SAT'],
      ['image', 'https://img.example/x.png'],
      ['status', 'sold'],
    ]);
    const chairOlder = listing(6, 'chair', 100);
    const deletion = finalizeEvent({ kind: 5, created_at: 400, content: '', tags: [] }, keyOf(5));
    const out = await curateOpenListingEvents([older, newer, soldNewer, chairOlder, deletion], {
      now: 0,
      verify: verifyEvent,
    });
    expect(out).toEqual(expect.arrayContaining([newer, deletion]));
    expect(out).not.toContain(older);
    // A sold newest revision drops the address — the older one never resurfaces.
    expect(out).not.toContain(chairOlder);
    expect(out).not.toContain(soldNewer);
  });
});

describe('curateOpenListingProducts', () => {
  it('applies the image rule and the per-seller cap to final products', () => {
    const products: MarketProduct[] = [
      ...Array.from({ length: OPEN_SCOPE_PER_AUTHOR + 3 }, (_, i) =>
        productOf(listing(7, `p-${i}`, 500 - i)),
      ),
      productOf(listing(8, 'q', 100)),
      { ...productOf(listing(9, 'r', 50)), image: '' },
    ];
    const out = curateOpenListingProducts(products);
    expect(out.filter((p) => p.listing?.event.pubkey === getPublicKey(keyOf(7)))).toHaveLength(
      OPEN_SCOPE_PER_AUTHOR,
    );
    expect(out.some((p) => p.id.endsWith('-q'))).toBe(true);
    expect(out.some((p) => p.id.endsWith('-r'))).toBe(false);
  });
});

describe('withKnownProfiles', () => {
  it('keeps listings whose seller has a kind-0 profile', () => {
    const a = productOf(listing(10, 'a', 10));
    const b = productOf(listing(11, 'b', 10));
    const known = new Set([getPublicKey(keyOf(10))]);
    expect(withKnownProfiles([a, b], (pk) => known.has(pk))).toEqual([a]);
  });
});
