// Relay provenance for the stale-while-revalidate merge: which relays served
// each listing, which answered, and which carried-over listings a deletion
// now withdraws.
import { finalizeEvent, getPublicKey, type Event, type Filter } from 'nostr-tools';
import { fetchMarketListings } from './marketListingsService';
import { collectRelaySnapshot } from './relaySnapshot';
import { __resetVerifiedEventCache } from './nostrVerifyCache';
import { parseMarketListing } from '../utils/marketListings';
import { mergeMarketSnapshot } from '../utils/marketSnapshotMerge';

jest.mock('./nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('./marketListingsPool', () => ({
  acquireMarketListingsPool: () => ({ pool: {}, release: jest.fn() }),
}));
jest.mock('./relaySnapshot', () => ({ collectRelaySnapshot: jest.fn() }));
jest.mock('./nostrCrypto', () => {
  const pure = jest.requireActual('nostr-tools/pure');
  return { nostrGetEventHash: pure.getEventHash, nostrVerifyEvent: jest.fn(pure.verifyEvent) };
});

const key = new Uint8Array(32).fill(7);
const author = getPublicKey(key);
const SHOP = 'wss://relay.plebeian.market';
const FAMILY = 'wss://relay.family.example';
const listing = (d: string, createdAt = 100): Event =>
  finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: d,
      tags: [
        ['d', d],
        ['title', d],
        ['price', '21', 'SAT'],
      ],
    },
    key,
  );
const snapshot = collectRelaySnapshot as jest.Mock;
const copy = (event: Event): Event => JSON.parse(JSON.stringify(event));

/** Each relay serves its listings (pass 1) and deletions (pass 2) and answers. */
function relays(served: Record<string, { listings?: Event[]; deletions?: Event[] }>) {
  const filters: Filter[][] = [];
  snapshot.mockImplementation(async (opts: Parameters<typeof collectRelaySnapshot>[0]) => {
    filters.push([...opts.filters]);
    const deletionPass = opts.filters[0]?.kinds?.[0] === 5;
    for (const url of opts.urls)
      for (const event of (deletionPass ? served[url]?.deletions : served[url]?.listings) ?? [])
        opts.onEvent(copy(event), url);
    const answered = opts.urls.filter((url) => url in served);
    return { answered, responded: answered, truncated: false, truncatedSince: null };
  });
  return filters;
}

beforeEach(() => {
  __resetVerifiedEventCache();
  snapshot.mockReset();
});

it('records which relays served each listing, and which relays answered', async () => {
  const book = listing('book');
  relays({ [SHOP]: { listings: [book] }, [FAMILY]: { listings: [book] } });
  const result = await fetchMarketListings([author], [SHOP, FAMILY], new AbortController().signal);
  expect(result.answeredRelays?.sort()).toEqual([SHOP, FAMILY].sort());
  expect(result.products[0].listing?.seenOn?.sort()).toEqual([SHOP, FAMILY].sort());
  expect(result.withdrawn).toEqual([]);
});

it('reports a served-but-hidden listing as withdrawn so a merge cannot keep it', async () => {
  const scarf = listing('scarf');
  const deletion = finalizeEvent(
    { kind: 5, created_at: 300, content: '', tags: [['a', `30402:${author}:scarf`]] },
    key,
  );
  relays({ [FAMILY]: { listings: [scarf], deletions: [deletion] } });
  const result = await fetchMarketListings([author], [FAMILY], new AbortController().signal);
  expect(result.products).toEqual([]);
  expect(result.withdrawn).toEqual([`nostr-30402-${author}-scarf`]);
});

it('looks up deletions for carried-over listings and reports them withdrawn', async () => {
  const book = listing('book');
  const mug = listing('mug', 90);
  const deletion = finalizeEvent(
    { kind: 5, created_at: 300, content: '', tags: [['a', `30402:${author}:mug`]] },
    key,
  );
  // The mug's own relay is silent; its deletion turns up on another relay.
  const filters = relays({ [SHOP]: { listings: [book], deletions: [deletion] } });
  const result = await fetchMarketListings(
    [author],
    [SHOP, FAMILY],
    new AbortController().signal,
    undefined,
    { carried: [mug] },
  );
  expect(filters[1][0]['#a']).toEqual(
    expect.arrayContaining([`30402:${author}:book`, `30402:${author}:mug`]),
  );
  expect(result.products.map((p) => p.title)).toEqual(['book']);
  expect(result.withdrawn).toEqual([`nostr-30402-${author}-mug`]);
});

it.each(['\ud800', '\udfff'])(
  'skips a malformed carried identifier %j while refreshing listings and withdrawals',
  async (d) => {
    const malformed = listing(d);
    const book = listing('book');
    const mug = listing('mug', 90);
    const deletion = finalizeEvent(
      { kind: 5, created_at: 300, content: '', tags: [['a', `30402:${author}:mug`]] },
      key,
    );
    relays({ [SHOP]: { listings: [book], deletions: [deletion] } });
    const result = await fetchMarketListings(
      [author],
      [SHOP],
      new AbortController().signal,
      undefined,
      { carried: [malformed, mug] },
    );
    expect(result.products.map((p) => p.title)).toEqual(['book']);
    expect(result.withdrawn).toEqual([`nostr-30402-${author}-mug`]);
    expect(result.incomplete).toBe(false);
    expect(result.transportFailed).toBeUndefined();
  },
);

it('ignores carried listings outside the current follow scope', async () => {
  const stranger = finalizeEvent(
    { kind: 30402, created_at: 1, content: '', tags: [['d', 'x']] },
    new Uint8Array(32).fill(9),
  );
  const filters = relays({ [SHOP]: {} });
  await fetchMarketListings([author], [SHOP], new AbortController().signal, undefined, {
    carried: [stranger],
  });
  // No listings and no in-scope carried events: pass 2 never runs.
  expect(filters).toHaveLength(1);
});

it.each(['hash', 'signature'])(
  'does not withdraw a carried listing after a forged %s',
  async (failure) => {
    const book = listing('book');
    const forged = copy(listing('book', 200));
    if (failure === 'hash') forged.content = 'tampered';
    else forged.sig = '0'.repeat(128);
    relays({ [SHOP]: { listings: [forged] } });
    const result = await fetchMarketListings(
      [author],
      [SHOP, FAMILY],
      new AbortController().signal,
      undefined,
      { carried: [book] },
    );
    expect(result.products).toEqual([]);
    expect(result.withdrawn).toEqual([]);
    const previous = parseMarketListing(book)!;
    previous.listing!.seenOn = [FAMILY];
    expect(mergeMarketSnapshot([previous], result)).toEqual([previous]);
  },
);

it('withdraws a carried listing after an authenticated sold revision on another relay', async () => {
  const book = listing('book');
  const sold = finalizeEvent(
    {
      kind: 30402,
      created_at: 200,
      content: '',
      tags: [
        ['d', 'book'],
        ['status', 'sold'],
      ],
    },
    key,
  );
  relays({ [SHOP]: { listings: [sold] } });
  const result = await fetchMarketListings(
    [author],
    [SHOP, FAMILY],
    new AbortController().signal,
    undefined,
    { carried: [book] },
  );
  expect(result.products).toEqual([]);
  expect(result.withdrawn).toEqual([`nostr-30402-${author}-book`]);
});

it.each([
  ['hash', false],
  ['hash', true],
  ['signature', false],
  ['signature', true],
] as const)(
  'does not persist a forged %s source, genuine arrives first: %s',
  async (failure, genuineFirst) => {
    const book = listing('book');
    const forged = copy(book);
    if (failure === 'hash') forged.content = 'tampered';
    else forged.sig = '0'.repeat(128);
    const genuineSource = genuineFirst ? SHOP : FAMILY;
    const forgedSource = genuineFirst ? FAMILY : SHOP;
    relays({ [forgedSource]: { listings: [forged] }, [genuineSource]: { listings: [book] } });
    const initial = await fetchMarketListings(
      [author],
      genuineFirst ? [FAMILY, SHOP] : [SHOP, FAMILY],
      new AbortController().signal,
    );
    expect(initial.products[0].listing?.seenOn).toEqual([genuineSource]);

    // The forged source answers empty while the genuine source is offline.
    relays({ [forgedSource]: {} });
    const refreshed = await fetchMarketListings(
      [author],
      [SHOP, FAMILY],
      new AbortController().signal,
      undefined,
      { carried: [book] },
    );
    expect(mergeMarketSnapshot(initial.products, refreshed)).toEqual(initial.products);
  },
);

it.each(['sold', 'hidden', 'oversized'])(
  'keeps a newer carried listing when another relay serves an older signed %s revision',
  async (status) => {
    const book = listing('book', 200);
    const old = finalizeEvent(
      {
        kind: 30402,
        created_at: 100,
        content: status === 'oversized' ? 'x'.repeat(40000) : '',
        tags: [
          ['d', 'book'],
          ['status', status],
        ],
      },
      key,
    );
    relays({ [SHOP]: { listings: [old] } });
    const result = await fetchMarketListings(
      [author],
      [SHOP, FAMILY],
      new AbortController().signal,
      undefined,
      { carried: [book] },
    );
    expect(result.products).toEqual([]);
    expect(result.withdrawn).toEqual([]);
    const previous = parseMarketListing(book)!;
    previous.listing!.seenOn = [FAMILY];
    expect(mergeMarketSnapshot([previous], result)).toEqual([previous]);
  },
);

it.each([true, false])(
  'orders signed withdrawals against carried revisions by lowest id on timestamp ties: wins=%s',
  async (wins) => {
    const book = listing('book', 200);
    let sold: Event;
    for (let i = 0; ; i++) {
      sold = finalizeEvent(
        {
          kind: 30402,
          created_at: book.created_at,
          content: `sold ${i}`,
          tags: [
            ['d', 'book'],
            ['status', 'sold'],
          ],
        },
        key,
      );
      if (sold.id < book.id === wins) break;
    }
    relays({ [SHOP]: { listings: [sold] } });
    const result = await fetchMarketListings(
      [author],
      [SHOP, FAMILY],
      new AbortController().signal,
      undefined,
      { carried: [book] },
    );
    expect(result.withdrawn).toEqual(wins ? [`nostr-30402-${author}-book`] : []);
    const previous = parseMarketListing(book)!;
    previous.listing!.seenOn = [FAMILY];
    expect(mergeMarketSnapshot([previous], result)).toEqual(wins ? [] : [previous]);
  },
);

it.each(['unavailable deletion', 'failed deletion checks', 'aborted'])(
  'preserves carried listings when the snapshot is withheld: %s',
  async (reason) => {
    const book = listing('book');
    const controller = new AbortController();
    const deletion = finalizeEvent(
      {
        kind: 5,
        created_at: 300,
        content: reason === 'unavailable deletion' ? 'x'.repeat(1048577) : '',
        tags: [['a', `30402:${author}:book`]],
      },
      key,
    );
    snapshot.mockImplementation(async (opts: Parameters<typeof collectRelaySnapshot>[0]) => {
      if (opts.filters[0]?.kinds?.[0] === 5) {
        if (reason === 'aborted') controller.abort();
        else if (reason === 'failed deletion checks') {
          for (let i = 0; i < 32; i++) {
            const forged = finalizeEvent({ ...deletion, created_at: 300 + i }, key);
            opts.onEvent({ ...forged, sig: '0'.repeat(128) }, SHOP);
          }
        } else opts.onEvent(deletion, SHOP);
      } else opts.onEvent(copy(book), SHOP);
      return { answered: [SHOP], responded: [SHOP], truncated: false, truncatedSince: null };
    });
    const result = await fetchMarketListings([author], [SHOP], controller.signal, undefined, {
      carried: [book],
    });
    expect(result.incomplete).toBe(true);
    expect(result.unreachableSellers).toEqual([]);
    expect(result.products).toEqual([]);
    expect(result.answeredRelays).toEqual([]);
    expect(result.withdrawn).toEqual([]);
    const previous = parseMarketListing(book)!;
    previous.listing!.seenOn = [SHOP];
    expect(mergeMarketSnapshot([previous], result)).toEqual([previous]);
  },
);

it.each(['forged first', 'genuine first'])(
  'never records the relay of an oversized forged copy as provenance (%s)',
  async (order) => {
    const book = listing('book');
    const forged = { ...copy(book), content: 'x'.repeat(40000) };
    relays(
      order === 'forged first'
        ? { [FAMILY]: { listings: [forged] }, [SHOP]: { listings: [book] } }
        : { [SHOP]: { listings: [book] }, [FAMILY]: { listings: [forged] } },
    );
    const result = await fetchMarketListings(
      [author],
      [FAMILY, SHOP],
      new AbortController().signal,
    );
    expect(result.products).toHaveLength(1);
    expect(result.products[0].listing?.seenOn).toEqual([SHOP]);
  },
);

it('reports a seller missing from an unanswered listings pass without cached products', async () => {
  relays({});
  const result = await fetchMarketListings([author], [SHOP], new AbortController().signal);
  expect(result.unreachableSellers).toEqual([author]);
});

it('does not report an unreachable seller whose cached products remain in the merge', async () => {
  const book = listing('book');
  const previous = parseMarketListing(book)!;
  previous.listing!.seenOn = [SHOP];
  relays({ [FAMILY]: {} });
  const result = await fetchMarketListings(
    [author],
    [SHOP, FAMILY],
    new AbortController().signal,
    undefined,
    { carried: [book], previousProducts: [previous] },
  );
  expect(mergeMarketSnapshot([previous], result)).toEqual([previous]);
  expect(result.unreachableSellers).toEqual([]);
});

it('does not let a forged listing suppress a missing seller warning', async () => {
  const forged = { ...copy(listing('forged')), sig: '0'.repeat(128) };
  relays({ [SHOP]: { listings: [forged] } });
  const result = await fetchMarketListings([author], [SHOP, FAMILY], new AbortController().signal);
  expect(result.products).toEqual([]);
  expect(result.unreachableSellers).toEqual([author]);
});
