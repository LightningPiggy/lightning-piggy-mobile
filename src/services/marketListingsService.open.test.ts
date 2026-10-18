// The experimental All seller scope: author-less, bounded, spam-curated.
import { finalizeEvent, getPublicKey, type Filter } from 'nostr-tools';
import { mergeMarketSnapshot } from '../utils/marketSnapshotMerge';
import { parseMarketListing } from '../utils/marketListings';
import { fetchOpenMarketListings } from './marketListingsService';
import { OPEN_LISTING_LIMIT, OPEN_LISTING_WINDOW_DAYS } from '../utils/marketListingsQuery';
import { OPEN_SCOPE_PER_AUTHOR } from '../utils/marketOpenScope';
import { nostrVerifyEvent } from './nostrCrypto';
import { __resetVerifiedEventCache } from './nostrVerifyCache';

// Real pacing waits on timers; under fake timers it would never resume.
jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: () => ({
    maybeYield: () => Promise.resolve(),
    dispose: () => {},
    yieldCount: 0,
  }),
}));
jest.mock('./nostrPool', () => ({ pool: { ensureRelay: jest.fn() }, trackRelays: jest.fn() }));
jest.mock('./marketListingsPool', () => {
  const ensureRelay = jest.fn();
  return {
    acquireMarketListingsPool: () => ({ pool: { ensureRelay }, release: jest.fn() }),
    __ensureRelay: ensureRelay,
  };
});
jest.mock('./nostrCrypto', () => {
  const actual = jest.requireActual('./nostrCrypto');
  const pure = jest.requireActual('nostr-tools/pure');
  return {
    ...actual,
    nostrGetEventHash: pure.getEventHash,
    nostrVerifyEvent: jest.fn(pure.verifyEvent),
  };
});

const ensureRelay = (jest.requireMock('./marketListingsPool') as { __ensureRelay: jest.Mock })
  .__ensureRelay;
const verify = nostrVerifyEvent as unknown as jest.Mock;
const NOW_S = 1_800_000_000;

interface Callbacks {
  onevent: (e: ReturnType<typeof finalizeEvent>) => void;
  oneose: () => void;
  onclose: (reason: string) => void;
  receivedEvent?: () => void;
  alreadyHaveEvent?: (id: string) => boolean;
}
interface Sub {
  url: string;
  filters: Filter[];
  c: Callbacks;
}
let subs: Sub[];
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const listingSubs = () => subs.filter((s) => s.filters[0].kinds?.[0] !== 5);
/** EOSE every open sub (listings, then the deletion pass it triggers). */
const answerAll = async () => {
  const done = new Set<Sub>();
  for (let round = 0; round < 5; round++) {
    subs
      .filter((s) => !done.has(s))
      .forEach((s) => {
        done.add(s);
        s.c.oneose();
      });
    await flush();
  }
};
const deliver = (s: Sub, e: ReturnType<typeof finalizeEvent>) => {
  s.c.receivedEvent?.();
  if (!s.c.alreadyHaveEvent?.(e.id)) s.c.onevent(e);
};

const keyOf = (n: number) => new Uint8Array(32).fill(n);
const listing = (
  n: number,
  d: string,
  createdAt: number,
  extra: { image?: string | null; price?: string } = {},
) =>
  finalizeEvent(
    {
      kind: 30402,
      created_at: createdAt,
      content: 'Thing',
      tags: [
        ['d', d],
        ['title', `Thing ${d}`],
        ['price', extra.price ?? '21', 'SAT'],
        ...(extra.image === null ? [] : [['image', extra.image ?? 'https://img.example/x.png']]),
      ],
    },
    keyOf(n),
  );

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(NOW_S * 1000);
  subs = [];
  verify.mockClear();
  __resetVerifiedEventCache();
  ensureRelay.mockReset();
  ensureRelay.mockImplementation((url: string) =>
    url === 'wss://example.com'
      ? Promise.resolve({
          subscribe: (filters: Filter[], c: Callbacks) => {
            subs.push({ url, filters, c });
            return { close: jest.fn() };
          },
        })
      : Promise.reject(new Error('offline')),
  );
});
afterEach(() => {
  __resetVerifiedEventCache();
  jest.useRealTimers();
});

const start = () => fetchOpenMarketListings(['wss://example.com'], new AbortController().signal);

it('asks for listings from anyone: no authors, bounded by limit and a since window', async () => {
  const pending = start();
  await flush();
  const [sub] = listingSubs();
  expect(sub.filters).toEqual([
    {
      kinds: [30018, 30402],
      since: NOW_S - OPEN_LISTING_WINDOW_DAYS * 86400,
      limit: OPEN_LISTING_LIMIT,
    },
  ]);
  expect(sub.filters[0]).not.toHaveProperty('authors');
  await answerAll();
  await pending;
});

it('keeps listings from any seller, dropping ones without an image or a price', async () => {
  const pending = start();
  await flush();
  const [sub] = listingSubs();
  deliver(sub, listing(1, 'good', NOW_S - 10));
  deliver(sub, listing(2, 'other-seller', NOW_S - 20));
  deliver(sub, listing(3, 'no-image', NOW_S - 30, { image: null }));
  deliver(sub, listing(4, 'free', NOW_S - 40, { price: '0' }));
  await answerAll();
  const result = await pending;
  expect(result.products.map((p) => p.listing?.event.tags[0][1])).toEqual(['good', 'other-seller']);
  expect(result.incomplete).toBe(false);
});

it('caps one seller at their newest authenticated listings', async () => {
  const pending = start();
  await flush();
  const [sub] = listingSubs();
  for (let i = 0; i < OPEN_SCOPE_PER_AUTHOR + 15; i++)
    deliver(sub, listing(5, `spam-${i}`, NOW_S - i));
  deliver(sub, listing(6, 'honest', NOW_S - 100));
  await answerAll();
  const { products } = await pending;
  const spam = products.filter((p) => p.id.includes('spam-'));
  expect(spam).toHaveLength(OPEN_SCOPE_PER_AUTHOR);
  // Newest first: spam-0 … spam-9 survive.
  expect(spam.map((p) => p.id.split('-').pop())).toEqual(
    Array.from({ length: OPEN_SCOPE_PER_AUTHOR }, (_, i) => String(i)),
  );
  expect(products.some((p) => p.id.endsWith('-honest'))).toBe(true);
  expect(verify.mock.calls.length).toBe(OPEN_SCOPE_PER_AUTHOR + 16);
});

it('treats a reply that fills its limit as the sample edge, not an incomplete load', async () => {
  const pending = start();
  await flush();
  const [sub] = listingSubs();
  // OPEN_LISTING_LIMIT events from distinct sellers fill the reply.
  for (let i = 0; i < OPEN_LISTING_LIMIT; i++) {
    deliver(sub, listing(10 + (i % 200), `item-${i}`, NOW_S - i, i % 2 ? { image: null } : {}));
  }
  await answerAll();
  const result = await pending;
  expect(result.incomplete).toBe(false);
  expect(result.budgetLimited).toBeUndefined();
  expect(result.products.length).toBeGreaterThan(0);
});

it('rejects a forged listing even with no author filter', async () => {
  const pending = start();
  await flush();
  const [sub] = listingSubs();
  const genuine = listing(7, 'real', NOW_S - 5);
  const forged = { ...listing(8, 'fake', NOW_S - 1), sig: '0'.repeat(128) };
  deliver(sub, forged);
  deliver(sub, genuine);
  await answerAll();
  const { products } = await pending;
  expect(products.map((p) => p.listing?.event.pubkey)).toEqual([getPublicKey(keyOf(7))]);
});

it('retains carried listings absent from a sample while honoring authenticated withdrawals', async () => {
  const absent = listing(1, 'outside-sample', NOW_S - 100);
  const deleted = listing(2, 'deleted', NOW_S - 90);
  const previous = [absent, deleted].map((event) => {
    const product = parseMarketListing(event)!;
    product.listing!.seenOn = ['wss://example.com'];
    return product;
  });
  const pending = fetchOpenMarketListings(
    ['wss://example.com'],
    new AbortController().signal,
    undefined,
    { carried: [absent, deleted] },
  );
  await flush();
  deliver(listingSubs()[0], listing(3, 'fresh', NOW_S - 10));
  listingSubs()[0].c.oneose();
  await flush();
  const deletion = finalizeEvent(
    { kind: 5, created_at: NOW_S, content: '', tags: [['e', deleted.id]] },
    keyOf(2),
  );
  const deletionSub = subs.find((sub) => sub.filters[0].kinds?.[0] === 5)!;
  deliver(deletionSub, deletion);
  await answerAll();
  const result = await pending;
  expect(result.answeredRelays).toEqual([]);
  expect(result.withdrawn).toContain(previous[1].id);
  const merged = mergeMarketSnapshot(previous, result);
  expect(merged.map((product) => product.id)).toContain(previous[0].id);
  expect(merged.map((product) => product.id)).not.toContain(previous[1].id);
  expect(merged).toHaveLength(2);
});

it.each(['sold', 'hidden', 'forged', 'older'])(
  'authenticates a carried listing revision excluded by hygiene: %s',
  async (status) => {
    const old = listing(1, 'carried', NOW_S - 100);
    const previous = [parseMarketListing(old)!];
    const unsigned = {
      kind: old.kind,
      created_at: status === 'older' ? NOW_S - 200 : NOW_S - 10,
      content: old.content,
      tags: [...old.tags, ['status', status === 'forged' || status === 'older' ? 'sold' : status]],
    };
    const signed = finalizeEvent(unsigned, keyOf(1));
    const revision = status === 'forged' ? { ...signed, sig: '0'.repeat(128) } : signed;
    const pending = fetchOpenMarketListings(
      ['wss://example.com'],
      new AbortController().signal,
      undefined,
      { carried: [old] },
    );
    await flush();
    deliver(listingSubs()[0], revision);
    await answerAll();
    const result = await pending;
    const withdrawn = status === 'sold' || status === 'hidden';
    expect(result.withdrawn?.includes(previous[0].id)).toBe(withdrawn);
    expect(mergeMarketSnapshot(previous, result)).toHaveLength(withdrawn ? 0 : 1);
  },
);

it('keeps a genuine fallback when a forged newer sold revision arrives on first load', async () => {
  const pending = start();
  await flush();
  const original = listing(1, 'lamp', NOW_S - 100);
  const sold = finalizeEvent(
    {
      kind: original.kind,
      created_at: NOW_S - 10,
      content: original.content,
      tags: [...original.tags, ['status', 'sold']],
    },
    keyOf(1),
  );
  deliver(listingSubs()[0], { ...sold, sig: '0'.repeat(128) });
  deliver(listingSubs()[0], original);
  await answerAll();
  expect((await pending).products.map((p) => p.listing?.event.id)).toEqual([original.id]);
});

it('does not let forged addresses or inflated fallback timestamps consume seller slots', async () => {
  const pending = start();
  await flush();
  const sub = listingSubs()[0];
  for (let i = 0; i < OPEN_SCOPE_PER_AUTHOR; i++) {
    deliver(sub, { ...listing(1, `fake-${i}`, NOW_S - i), sig: '0'.repeat(128) });
    deliver(sub, listing(1, `real-${i}`, NOW_S - 100 - i));
  }
  const fallback = listing(1, 'old-fallback', NOW_S - 200);
  deliver(sub, { ...listing(1, 'old-fallback', NOW_S), sig: '0'.repeat(128) });
  deliver(sub, fallback);
  await answerAll();
  expect((await pending).products.map((p) => p.listing?.event.tags[0][1])).toEqual(
    Array.from({ length: OPEN_SCOPE_PER_AUTHOR }, (_, i) => `real-${i}`),
  );
});

it('keeps the existing forged-signature budget while authenticating All-scope winners', async () => {
  const pending = start();
  await flush();
  for (let i = 0; i < 70; i++) {
    deliver(listingSubs()[0], { ...listing(1, `forged-${i}`, NOW_S - i), sig: '0'.repeat(128) });
  }
  await answerAll();
  const result = await pending;
  expect(verify).toHaveBeenCalledTimes(64);
  expect(result.products).toEqual([]);
  expect(result.incomplete).toBe(true);
  expect(result.budgetLimited).toBe(true);
});
