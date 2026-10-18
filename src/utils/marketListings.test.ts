import { finalizeEvent, getPublicKey, nip19, type Event } from 'nostr-tools';
import {
  parseMarketListing,
  reduceMarketListings,
  safeMarketImages,
  safeMarketUrl,
  selectVerifiedListings,
} from './marketListings';
import { marketFeedbackContext } from './marketFeedback';
import { marketCheckoutTarget } from './marketCheckout';
import { sellerOf } from '../data/marketProducts';
import { distinctCurrencies } from './marketFilters';

const key = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(8);
const author = getPublicKey(key);
const authors = new Set([author]);
const event = (fields: Partial<Event> = {}, secret = key) =>
  finalizeEvent(
    {
      kind: 30402,
      created_at: 100,
      content: 'A real seller description',
      tags: [
        ['d', 'product-1'],
        ['title', 'Test listing'],
        ['price', '50', 'USD'],
      ],
      ...fields,
    },
    secret,
  );

describe('market relay listings', () => {
  it('labels an unresolved seller with a short npub, never raw hex', () => {
    const product = parseMarketListing(event())!;
    expect(product.sellerName).toMatch(/^npub1[0-9a-z]{7}…[0-9a-z]{4}$/);
    expect(product.sellerName).not.toContain(author.slice(0, 8));
  });

  it('skips Gamma Markets listings marked visibility hidden', () => {
    const withVisibility = (v: string) =>
      event({
        tags: [
          ['d', 'product-1'],
          ['title', 'Test listing'],
          ['price', '50', 'USD'],
          ['visibility', v],
        ],
      });
    expect(parseMarketListing(withVisibility('hidden'))).toBeNull();
    expect(parseMarketListing(withVisibility('on-sale'))).not.toBeNull();
    expect(parseMarketListing(withVisibility('pre-order'))).not.toBeNull();
  });

  it('rejects identifiers too long for a NIP-19 naddr (255 UTF-8 bytes)', () => {
    const withD = (d: string) =>
      event({
        tags: [
          ['d', d],
          ['title', 'Test listing'],
          ['price', '50', 'USD'],
        ],
      });
    expect(parseMarketListing(withD('a'.repeat(255)))).not.toBeNull();
    expect(parseMarketListing(withD('a'.repeat(256)))).toBeNull();
    // 100 × "€" is only 100 characters but 300 UTF-8 bytes.
    expect(parseMarketListing(withD('€'.repeat(100)))).toBeNull();
  });

  it('drops a listing whose identifier has a lone surrogate instead of throwing', () => {
    const lone = event({
      tags: [
        ['d', 'bad\ud800id'],
        ['title', 'Test listing'],
        ['price', '50', 'USD'],
      ],
    });
    expect(() => parseMarketListing(lone)).not.toThrow();
    expect(parseMarketListing(lone)).toBeNull();
  });
  it('retains fiat prices without inventing a sats quote and uses the signed seller identity', () => {
    const e = event();
    const p = parseMarketListing(e)!;
    expect(p.listing?.priceLabel).toBe('50 USD');
    expect(distinctCurrencies([p])).toEqual(['USD']);
    expect(p.listing?.event).toEqual(e);
    // A signed one-off 30402 is orderable in-app (Gamma order, priced in sats
    // at checkout) — but never by its own author.
    expect(marketCheckoutTarget(p, sellerOf(p))).toMatchObject({
      source: 'listing',
      vendorPubkey: e.pubkey,
      listingDTag: 'product-1',
      price: { amount: 50, currency: 'USD' },
    });
    expect(marketCheckoutTarget(p, sellerOf(p), e.pubkey)).toBeNull();
    const address = nip19.decode(p.url.split('/').at(-1)!);
    expect(address.type).toBe('naddr');
    expect(marketFeedbackContext(p, sellerOf(p))).toMatchObject({
      productDTag: 'product-1',
      commentRoot: e,
    });
  });
  it('converts BTC to integral sats, but does not invent recurring payment semantics', () => {
    const p = parseMarketListing(
      event({
        tags: [
          ['d', 'x'],
          ['title', 'Book'],
          ['price', '0.00001', 'btc', 'month'],
        ],
      }),
    )!;
    expect(p.priceSats).toBe(1000);
    expect(p.listing?.priceLabel).toBe('0.00001 BTC/month');
    expect(p.checkout).toBeUndefined();
  });
  it('parses available legacy NIP-15 products and hides zero stock or mismatched identifiers', () => {
    const p = {
      id: 'product-1',
      name: 'Book',
      currency: 'SATS',
      price: 1200,
      quantity: null,
      images: ['https://example.com/book.png'],
    };
    expect(parseMarketListing(event({ kind: 30018, content: JSON.stringify(p) }))?.priceSats).toBe(
      1200,
    );
    expect(
      parseMarketListing(event({ kind: 30018, content: JSON.stringify({ ...p, quantity: 0 }) })),
    ).toBeNull();
    expect(
      parseMarketListing(event({ kind: 30018, content: JSON.stringify({ ...p, id: 'wrong' }) })),
    ).toBeNull();
  });
  it('newer sold, expired or malformed revisions suppress older active listings', () => {
    const original = event();
    for (const tags of [
      [...original.tags, ['status', 'sold']],
      [...original.tags, ['expiration', '150']],
      [['d', 'product-1']],
    ]) {
      expect(
        reduceMarketListings([original, event({ created_at: 200, tags })], authors, 300),
      ).toEqual([]);
    }
  });
  it('deduplicates by author and d tag, and rejects authors outside the follow set', () => {
    const newer = event({ created_at: 200 });
    expect(reduceMarketListings([event(), newer, newer, event({}, other)], authors)).toHaveLength(
      1,
    );
    expect(reduceMarketListings([newer, event()], authors)[0].listing?.event.id).toBe(newer.id);
  });
  it('honours author-owned deletions but not third-party deletions or older address tombstones', () => {
    const listing = event();
    const deletion = event({ kind: 5, created_at: 200, tags: [['e', listing.id]] });
    expect(reduceMarketListings([listing, deletion], authors)).toEqual([]);
    expect(
      reduceMarketListings(
        [listing, event({ kind: 5, tags: [['e', listing.id]] }, other)],
        new Set([author, getPublicKey(other)]),
      ),
    ).toHaveLength(1);
    const a = `30402:${author}:product-1`;
    expect(
      reduceMarketListings(
        [listing, event({ kind: 5, created_at: 200, tags: [['a', a]] })],
        authors,
      ),
    ).toEqual([]);
    expect(
      reduceMarketListings(
        [listing, event({ kind: 5, created_at: 50, tags: [['a', a]] })],
        authors,
      ),
    ).toHaveLength(1);
  });
  it.each(['', '-1', 'NaN', 'Infinity', '1e99'])('ignores invalid price %s', (price) => {
    expect(
      parseMarketListing(
        event({
          tags: [
            ['d', 'x'],
            ['title', 'Book'],
            ['price', price, 'USD'],
          ],
        }),
      ),
    ).toBeNull();
  });
  it('ignores drafts and unsafe URLs without using untrusted HTML', () => {
    expect(parseMarketListing(event({ kind: 30403 }))).toBeNull();
    expect(safeMarketUrl('javascript:alert(1)')).toBeNull();
    expect(safeMarketUrl('https://user:pass@example.com')).toBeNull();
    expect(safeMarketUrl('http://example.com')).toBeNull();
    // #1338: listing URLs load automatically, so private hosts are refused.
    expect(safeMarketUrl('https://192.168.1.1/x.png')).toBeNull();
    expect(safeMarketUrl('https://127.1/x.png')).toBeNull();
    expect(safeMarketUrl('https://[::1]/x.png')).toBeNull();
    expect(safeMarketUrl('https://shop.local/x.png')).toBeNull();
    expect(safeMarketUrl('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png');
    expect(
      parseMarketListing(
        event({
          tags: [
            ['d', 'x'],
            ['title', 'Book'],
            ['price', '1', 'SAT'],
            ['image', 'javascript:evil'],
          ],
        }),
      )?.image,
    ).toBe('');
  });
});

describe('listing images', () => {
  const withImages = (images: string[][]) =>
    parseMarketListing(
      event({
        tags: [['d', 'x'], ['title', 'Book'], ['price', '1', 'SAT'], ...images],
      }),
    )!;

  it('keeps every image tag of a kind-30402 listing, in order, with the first as `image`', () => {
    const p = withImages([
      ['image', 'https://cdn.example.com/a.png', '800x600'],
      ['image', 'https://cdn.example.com/b.png'],
      ['image', 'https://cdn.example.com/c.png', '1024x1024'],
    ]);
    expect(p.images).toEqual([
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.png',
      'https://cdn.example.com/c.png',
    ]);
    expect(p.image).toBe('https://cdn.example.com/a.png');
  });

  it('de-duplicates repeated images and drops unsafe ones', () => {
    const p = withImages([
      ['image', 'javascript:evil'],
      ['image', 'https://cdn.example.com/a.png'],
      ['image', 'http://cdn.example.com/plain.png'],
      ['image', 'https://192.168.1.1/lan.png'],
      ['image', 'https://cdn.example.com/a.png'],
      ['image'],
      ['image', 'https://cdn.example.com/b.png'],
    ]);
    expect(p.images).toEqual(['https://cdn.example.com/a.png', 'https://cdn.example.com/b.png']);
    // The first SAFE image leads, so an unsafe first tag doesn't blank the card.
    expect(p.image).toBe('https://cdn.example.com/a.png');
  });

  it('gives a listing with no usable image an empty list and an empty `image`', () => {
    const p = withImages([['image', 'javascript:evil']]);
    expect(p.images).toEqual([]);
    expect(p.image).toBe('');
  });

  it('keeps the whole images array of a NIP-15 product', () => {
    const p = parseMarketListing(
      event({
        kind: 30018,
        content: JSON.stringify({
          id: 'product-1',
          name: 'Book',
          currency: 'SATS',
          price: 1200,
          quantity: null,
          images: [
            'https://example.com/front.png',
            42,
            'https://example.com/back.png',
            'https://example.com/front.png',
            'https://localhost/x.png',
          ],
        }),
      }),
    )!;
    expect(p.images).toEqual(['https://example.com/front.png', 'https://example.com/back.png']);
    expect(p.image).toBe('https://example.com/front.png');
  });

  it('caps a gallery at 20 images', () => {
    const urls = Array.from({ length: 30 }, (_, i) => `https://cdn.example.com/${i}.png`);
    expect(safeMarketImages(urls)).toEqual(urls.slice(0, 20));
  });
});

describe('selectVerifiedListings', () => {
  const sk = new Uint8Array(32).fill(9);
  const seller = getPublicKey(sk);
  const sellers = new Set([seller]);
  const make = (d: string, created_at: number, extra: string[][] = []) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at,
        content: d,
        tags: [['d', d], ['title', d], ['price', '21', 'SAT'], ...extra],
      },
      sk,
    );
  const noYield = async () => {};

  it('checks only each address winner and stops at the cap', async () => {
    const a1 = make('a', 10);
    const a2 = make('a', 20);
    const b = make('b', 30);
    const c = make('c', 5);
    const checked: string[] = [];
    const result = await selectVerifiedListings([a1, a2, b, c], sellers, {
      verify: (e) => {
        checked.push(e.id);
        return true;
      },
      maybeYield: noYield,
      cap: 2,
    });
    // Newest first: b, then a's winner a2; c is past the cap.
    expect(checked).toEqual([b.id, a2.id, c.id]);
    expect(result.overflow).toBe(true);
    expect(reduceMarketListings(result.events, sellers).map((p) => p.listing?.event.id)).toEqual([
      b.id,
      a2.id,
    ]);
  });

  it('falls back to an older revision when the newest fails verification', async () => {
    const old = make('a', 10);
    const forged = make('a', 20);
    const result = await selectVerifiedListings([old, forged], sellers, {
      verify: (e) => e.id !== forged.id,
      maybeYield: noYield,
      cap: 5,
    });
    expect(result).toMatchObject({ overflow: false, checked: 2 });
    expect(reduceMarketListings(result.events, sellers).map((p) => p.listing?.event.id)).toEqual([
      old.id,
    ]);
  });

  it("doesn't count deleted or unrenderable winners toward the cap", async () => {
    const gone = make('gone', 30);
    const sold = make('sold', 20, [['status', 'sold']]);
    const live = make('live', 10);
    const deletion = finalizeEvent(
      { kind: 5, created_at: 40, content: '', tags: [['a', `30402:${seller}:gone`]] },
      sk,
    );
    const result = await selectVerifiedListings([gone, sold, live, deletion], sellers, {
      verify: () => true,
      maybeYield: noYield,
      cap: 1,
    });
    expect(result.overflow).toBe(false);
    expect(reduceMarketListings(result.events, sellers).map((p) => p.listing?.event.id)).toEqual([
      live.id,
    ]);
  });

  it('ignores events from authors outside the scope', async () => {
    const stranger = finalizeEvent(
      { kind: 30402, created_at: 1, content: 'x', tags: [['d', 'x']] },
      new Uint8Array(32).fill(4),
    );
    const verify = jest.fn(() => true);
    const result = await selectVerifiedListings([stranger], sellers, {
      verify,
      maybeYield: noYield,
      cap: 5,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(result.events).toEqual([]);
  });
});

it('selectVerifiedListings reports a first page once, as soon as it is verified', async () => {
  const sk = new Uint8Array(32).fill(11);
  const seller = getPublicKey(sk);
  const events = [3, 2, 1].map((n) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at: n,
        content: `${n}`,
        tags: [
          ['d', `d${n}`],
          ['title', `${n}`],
          ['price', '1', 'SAT'],
        ],
      },
      sk,
    ),
  );
  const ready = jest.fn();
  let checks = 0;
  await selectVerifiedListings(events, new Set([seller]), {
    verify: () => {
      checks++;
      // The first page must arrive before the third listing is checked.
      if (checks === 3) expect(ready).toHaveBeenCalledTimes(1);
      return true;
    },
    maybeYield: async () => {},
    cap: 10,
    firstPage: { size: 2, ready },
  });
  expect(ready).toHaveBeenCalledTimes(1);
  expect(ready.mock.calls[0][0].map((e: { id: string }) => e.id)).toEqual([
    events[0].id,
    events[1].id,
  ]);
});

it('selectVerifiedListings: a forged newest copy cannot give an old fallback a cap slot', async () => {
  const sk = new Uint8Array(32).fill(12);
  const seller = getPublicKey(sk);
  const make = (d: string, created_at: number) =>
    finalizeEvent(
      {
        kind: 30402,
        created_at,
        content: d,
        tags: [
          ['d', d],
          ['title', d],
          ['price', '1', 'SAT'],
        ],
      },
      sk,
    );
  const oldA = make('a', 1);
  const forgedA = { ...make('a', 100), sig: '0'.repeat(128) };
  const b = make('b', 50);
  const result = await selectVerifiedListings([oldA, forgedA, b], new Set([seller]), {
    verify: (e) => e.sig !== '0'.repeat(128),
    maybeYield: async () => {},
    cap: 1,
  });
  expect(
    reduceMarketListings(result.events, new Set([seller])).map((p) => p.listing?.event.created_at),
  ).toEqual([50]);
  expect(result.overflow).toBe(true);
});

it.each([
  ['Book', 'Book'],
  ['Bo\u202eok\u200b', 'Book'],
])('sanitises Market listing titles', (title, expected) => {
  expect(
    parseMarketListing(
      event({
        tags: [
          ['d', 'item'],
          ['title', title],
          ['price', '21', 'SATS'],
        ],
      }),
    )?.title,
  ).toBe(expected);
});
