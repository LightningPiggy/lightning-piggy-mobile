import type { Event } from 'nostr-tools';
import { acquireMarketListingsPool } from './marketListingsPool';
import { querySyncAbortable } from './relayQuery';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { hasValidSignature } from '../utils/eventSignature';
import { parseMarketListing, reduceMarketListings } from '../utils/marketListings';
import { addressOf, addressRefs, deletionFilters, idRefs } from '../utils/nip09';
import type { MarketProduct } from '../data/marketProducts';

const MAX_CONCURRENT_SELLERS = 4;

/** Reconcile a bounded embed batch by seller and kind, using the structure-only
 * market pool so signature checks run under a frame budget, outside callbacks. */
export async function reconcileEmbedProducts(
  current: Event[],
  relays: string[],
  maxWait: number,
  signal?: AbortSignal,
): Promise<Map<string, MarketProduct | null>> {
  const result = new Map<string, MarketProduct | null>();
  if (!current.length) return result;
  const lease = acquireMarketListingsPool(relays);
  const scheduler = createYieldScheduler({ safetyEvery: 32 });
  try {
    const groups = new Map<string, Event[]>();
    for (const event of current) {
      const key = `${event.pubkey}:${event.kind}`;
      const group = groups.get(key) ?? [];
      group.push(event);
      groups.set(key, group);
    }
    const reconcileGroup = async (group: Event[]): Promise<void> => {
      try {
        const { pubkey, kind } = group[0];
        const addresses = new Set(group.map(addressOf));
        const ds = [...new Set(group.map((e) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''))];
        const query = (filter: Parameters<typeof querySyncAbortable>[2]) =>
          querySyncAbortable(lease.pool, relays, filter, {
            maxWait,
            signal,
            rejectOnAllRelaysFailure: filter.kinds?.[0] !== 5,
          });
        const revisions = await query({
          kinds: [kind],
          authors: [pubkey],
          '#d': ds,
          limit: ds.length * 10,
        });
        const known = [...group];
        for (const event of revisions) {
          if (event.pubkey !== pubkey || event.kind !== kind || !addresses.has(addressOf(event)))
            continue;
          await scheduler.maybeYield();
          if (hasValidSignature(event)) known.push(event);
        }
        const deletions = await Promise.all(
          [...deletionFilters('a', addressRefs(group)), ...deletionFilters('e', idRefs(known))].map(
            (filter) => query(filter).catch(() => [] as Event[]),
          ),
        );
        for (const event of deletions.flat()) {
          if (event.kind !== 5 || event.pubkey !== pubkey) continue;
          await scheduler.maybeYield();
          if (hasValidSignature(event)) known.push(event);
        }
        const products = reduceMarketListings(known, new Set([pubkey]));
        const byAddress = new Map(products.map((p) => [addressOf(p.listing!.event), p]));
        for (const event of group) result.set(event.id, byAddress.get(addressOf(event)) ?? null);
      } catch {
        // Match the old per-product transport fallback without undoing another
        // seller's successfully reconciled withdrawals.
        for (const event of group) result.set(event.id, parseMarketListing(event));
      }
    };
    const remaining = [...groups.values()];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(MAX_CONCURRENT_SELLERS, remaining.length) }, async () => {
        while (!signal?.aborted && next < remaining.length) {
          const group = remaining[next++];
          await reconcileGroup(group);
        }
      }),
    );
    return result;
  } finally {
    scheduler.dispose();
    lease.release();
  }
}
