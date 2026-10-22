import type { MarketProduct } from '../data/marketProducts';
import type { MarketListingsResult } from '../services/marketListingsService';
import { carriedListingEvents, MARKET_MERGE_CAP, mergeMarketSnapshot } from './marketSnapshotMerge';

const EDEN_RELAY = 'wss://relay.family.example';
const MARKET_RELAY = 'wss://relay.plebeian.market';

const product = (id: string, createdAt: number, seenOn?: string[]): MarketProduct =>
  ({
    id,
    title: id,
    sellerName: id,
    listing: { event: { id: `event-${id}`, created_at: createdAt, tags: [] }, seenOn },
  }) as unknown as MarketProduct;

const result = (
  products: MarketProduct[],
  answeredRelays: string[] | undefined,
  extra: Partial<MarketListingsResult> = {},
): MarketListingsResult => ({ products, incomplete: false, answeredRelays, ...extra });

const ids = (products: readonly MarketProduct[]) => products.map((p) => p.id);

const eden = product('eden-scarf', 50, [EDEN_RELAY]);
const shop = product('shop-mug', 100, [MARKET_RELAY]);

it("keeps a listing whose only relay didn't answer this round", () => {
  const merged = mergeMarketSnapshot([shop, eden], result([shop], [MARKET_RELAY]));
  expect(ids(merged)).toEqual(['shop-mug', 'eden-scarf']);
});

it('drops it once a relay that holds it answers without it', () => {
  const merged = mergeMarketSnapshot([shop, eden], result([shop], [MARKET_RELAY, EDEN_RELAY]));
  expect(ids(merged)).toEqual(['shop-mug']);
});

it('drops it when any one of several relays that held it answers without it', () => {
  const both = product('eden-scarf', 50, [EDEN_RELAY, MARKET_RELAY]);
  expect(ids(mergeMarketSnapshot([both], result([], [MARKET_RELAY])))).toEqual([]);
});

it('never keeps a listing the fresh snapshot withdrew (NIP-09 deletion, expiry, supersede)', () => {
  const merged = mergeMarketSnapshot(
    [shop, eden],
    result([shop], [MARKET_RELAY], { withdrawn: ['eden-scarf'] }),
  );
  expect(ids(merged)).toEqual(['shop-mug']);
});

it('prefers the fresh revision of a listing over the carried one', () => {
  const fresher = product('eden-scarf', 60, [EDEN_RELAY]);
  const merged = mergeMarketSnapshot([eden], result([fresher], [EDEN_RELAY]));
  expect(merged).toEqual([fresher]);
});

it('keeps everything when no relay answered, including listings without provenance', () => {
  const legacy = product('legacy', 10);
  const merged = mergeMarketSnapshot(
    [shop, legacy],
    result([], [], { incomplete: true, transportFailed: true }),
  );
  expect(ids(merged)).toEqual(['shop-mug', 'legacy']);
});

it('drops listings without provenance once some relay answered', () => {
  expect(ids(mergeMarketSnapshot([product('legacy', 10)], result([shop], [MARKET_RELAY])))).toEqual(
    ['shop-mug'],
  );
});

it('falls back to replace semantics for a result without relay outcomes', () => {
  expect(ids(mergeMarketSnapshot([eden], result([shop], undefined)))).toEqual(['shop-mug']);
  expect(
    ids(mergeMarketSnapshot([eden], result([], undefined, { transportFailed: true }))),
  ).toEqual(['eden-scarf']);
});

it('only fills spare room under the display cap with carried listings, newest first', () => {
  const fresh = Array.from({ length: MARKET_MERGE_CAP - 1 }, (_, i) =>
    product(`fresh-${i}`, 1000 + i, [MARKET_RELAY]),
  );
  const older = product('older', 1, [EDEN_RELAY]);
  const newer = product('newer', 2, [EDEN_RELAY]);
  const merged = mergeMarketSnapshot([older, newer], result(fresh, [MARKET_RELAY]));
  expect(merged).toHaveLength(MARKET_MERGE_CAP);
  expect(ids(merged)).toContain('newer');
  expect(ids(merged)).not.toContain('older');
});

it('lists the listing events still shown for the deletion lookup', () => {
  expect(carriedListingEvents([eden, { id: 'curated' } as MarketProduct])).toEqual([
    eden.listing!.event,
  ]);
});

it('keeps the newer cached revision when a relay serves an older one of the same listing', () => {
  const newer = product('shop-mug', 200, [EDEN_RELAY]);
  const older = product('shop-mug', 100, [MARKET_RELAY]);
  const merged = mergeMarketSnapshot([newer], result([older], [MARKET_RELAY]));
  expect(merged).toHaveLength(1);
  expect(merged[0].listing?.event.created_at).toBe(200);
});

it('takes a newer fetched revision over the cached one', () => {
  const cached = product('shop-mug', 100, [MARKET_RELAY]);
  const fetched = product('shop-mug', 200, [MARKET_RELAY]);
  expect(mergeMarketSnapshot([cached], result([fetched], [MARKET_RELAY]))[0]).toBe(fetched);
});

it('shows neither a withdrawn newer revision nor an older fallback of the same listing', () => {
  const deletedNewer = product('shop-mug', 200, [EDEN_RELAY]);
  const olderActive = product('shop-mug', 100, [MARKET_RELAY]);
  const merged = mergeMarketSnapshot(
    [deletedNewer],
    result([olderActive], [MARKET_RELAY], { withdrawn: ['shop-mug'] }),
  );
  expect(merged).toEqual([]);
});

it('still takes a fetched revision when the withdrawn cached one was older', () => {
  const olderWithdrawn = product('shop-mug', 100, [EDEN_RELAY]);
  const newerFetched = product('shop-mug', 200, [MARKET_RELAY]);
  const merged = mergeMarketSnapshot(
    [olderWithdrawn],
    result([newerFetched], [MARKET_RELAY], { withdrawn: ['shop-mug'] }),
  );
  expect(merged).toEqual([newerFetched]);
});
