// Resolves events referenced from note / bio content (NIP-27 `nostr:note…`,
// `nevent…`, `naddr…`) for the embedded cards in `components/nostr`.
//
// - Batched: refs requested within BATCH_MS with the same read-relay plan
//   share one relay query per shape
//   (one `ids` filter for events, one `#d` filter per kind+author for
//   addresses), so a feed page full of quotes costs a couple of REQs, not one
//   per card.
// - Bounded: every filter carries a `limit`, the batch size is capped, and
//   each query gives up after TIMEOUT_MS.
// - Cached: results (including "not found", for a shorter TTL) live in a
//   small LRU so scrolling back, or the same quote in two places, is free.
// - Verified: every event's id + signature is checked here, not trusted to
//   the shared pool (which fast-paths some kinds), and must match the ref.
//   A product (kind 30402) also has its seller's deletions applied through
//   a seller/kind batch reconciliation, so a withdrawn listing never embeds.
import type { Event } from 'nostr-tools';
import { pool, trackRelays, pruneIdleRelays } from './nostrPool';
import { querySyncAbortable } from './relayQuery';
import { reconcileEmbedProducts } from './nostrEmbedProducts';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { hasValidSignature } from '../utils/eventSignature';
import { parseMarketListing } from '../utils/marketListings';
import { embedKey, type NostrContentToken } from '../utils/nip27';
import type { MarketProduct } from '../data/marketProducts';

export type EmbedRef = Extract<NostrContentToken, { type: 'event' | 'address' }>;

export interface EmbedResult {
  /** The verified event, or null when no relay returned a valid one. */
  event: Event | null;
  /** For a kind-30402 listing: the live product (null when withdrawn / invalid). */
  product?: MarketProduct | null;
}

export const PRODUCT_KIND = 30402;
const BATCH_MS = 60;
const MAX_BATCH = 20;
const TIMEOUT_MS = 5000;
const MAX_CACHE = 300;
const NEGATIVE_TTL_MS = 2 * 60 * 1000;
/**
 * Addressable events (articles, listings) can be edited or withdrawn, so a
 * cached copy is re-fetched after this long. Plain notes are immutable and
 * stay cached for the session (LRU-bounded).
 */
const MUTABLE_TTL_MS = 10 * 60 * 1000;
/** Read relays used per batch, plus at most this many relay hints. */
const MAX_READ_RELAYS = 6;
const MAX_HINT_RELAYS = 3;

interface Entry {
  result: EmbedResult;
  at: number;
}

const cache = new Map<string, Entry>();
interface Pending {
  ref: EmbedRef;
  readRelays: string[];
  relayPlan: string;
  resolve: (r: EmbedResult) => void;
  promise: Promise<EmbedResult>;
  consumers: Set<symbol>;
  controller?: AbortController;
  batch?: Pending[];
}
const queue = new Map<string, Pending>();
const inFlight = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;

function remember(key: string, result: EmbedResult): void {
  // A miss from another relay plan must not erase a fresh verified result.
  if (!result.event && peekEmbed(key)?.event) return;
  cache.delete(key);
  cache.set(key, { result, at: Date.now() });
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Cached result for `key`, if fresh. Synchronous, for a first-frame paint. */
export function peekEmbed(key: string): EmbedResult | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  const { event } = entry.result;
  const ttl = !event
    ? NEGATIVE_TTL_MS
    : key.startsWith('a:') || event.kind >= 30000
      ? MUTABLE_TTL_MS
      : Infinity;
  if (Date.now() - entry.at > ttl) {
    cache.delete(key);
    return undefined;
  }
  return entry.result;
}

/** Resolve one reference; concurrent callers for the same ref share a fetch. */
export function resolveEmbed(
  ref: EmbedRef,
  readRelays: readonly string[],
  signal?: AbortSignal,
  retryMissing = false,
): Promise<EmbedResult> {
  if (signal?.aborted) return Promise.resolve({ event: null });
  const relayPlan = JSON.stringify(readRelays);
  const key = JSON.stringify([embedKey(ref), relayPlan]);
  const cached = peekEmbed(embedKey(ref));
  if (cached && (cached.event || !retryMissing)) return Promise.resolve(cached);
  let item = inFlight.get(key) ?? queue.get(key);
  if (!item) {
    let resolve!: (r: EmbedResult) => void;
    const promise = new Promise<EmbedResult>((r) => (resolve = r));
    item = { ref, readRelays: [...readRelays], relayPlan, resolve, promise, consumers: new Set() };
    queue.set(key, item);
    if (!timer) timer = setTimeout(flush, BATCH_MS);
  }
  const pending = item;
  const consumer = Symbol();
  pending.consumers.add(consumer);
  return new Promise((resolve) => {
    const release = () => {
      pending.consumers.delete(consumer);
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      release();
      resolve({ event: null });
      if (!pending.consumers.size) {
        if (queue.get(key) === pending) {
          queue.delete(key);
          pending.resolve({ event: null });
        }
        if (inFlight.get(key) === pending) inFlight.delete(key);
        if (pending.batch?.every((entry) => !entry.consumers.size)) pending.controller?.abort();
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    void pending.promise.then((result) => {
      release();
      resolve(result);
    });
  });
}

function relaysFor(refs: EmbedRef[], readRelays: readonly string[]): string[] {
  const read = readRelays.slice(0, MAX_READ_RELAYS);
  const hints: string[] = [];
  for (const ref of refs) {
    for (const r of ref.relays.slice(0, 2)) {
      if (hints.length >= MAX_HINT_RELAYS) break;
      if (!read.includes(r) && !hints.includes(r)) hints.push(r);
    }
  }
  return [...read, ...hints];
}

const dTag = (e: Event) => e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
/** Newest wins; equal timestamps break to the lower id (NIP-01). */
const newer = (a: Event, b: Event | undefined) =>
  !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

async function flush(): Promise<void> {
  timer = null;
  const batch = [...queue.entries()].slice(0, MAX_BATCH);
  for (const [key] of batch) queue.delete(key);
  if (queue.size > 0) timer = setTimeout(flush, BATCH_MS);
  const groups = new Map<string, typeof batch>();
  for (const entry of batch) {
    const plan = entry[1].relayPlan;
    const group = groups.get(plan) ?? [];
    group.push(entry);
    groups.set(plan, group);
  }
  await Promise.all([...groups.values()].map(flushBatch));
}

async function flushBatch(batch: [string, Pending][]): Promise<void> {
  const controller = new AbortController();
  for (const [key, item] of batch) {
    item.controller = controller;
    item.batch = batch.map(([, entry]) => entry);
    inFlight.set(key, item);
  }
  const refs = batch.map(([, p]) => p.ref);
  const relays = relaysFor(refs, batch[0][1].readRelays);
  const found = new Map<string, Event>();
  const scheduler = createYieldScheduler({ safetyEvery: 32 });
  const delivered = new Set<string>();
  const deliver = (key: string, item: Pending, result: EmbedResult): void => {
    if (delivered.has(key)) return;
    delivered.add(key);
    if (!controller.signal.aborted && item.consumers.size) remember(embedKey(item.ref), result);
    if (inFlight.get(key) === item) inFlight.delete(key);
    item.resolve(result);
  };
  const deliverOrdinary = (matches: (ref: EmbedRef) => boolean): void => {
    for (const [key, item] of batch) {
      if (!matches(item.ref)) continue;
      const event = found.get(embedKey(item.ref)) ?? null;
      if (event?.kind !== PRODUCT_KIND) deliver(key, item, { event });
    }
  };
  try {
    if (relays.length > 0) {
      trackRelays(relays);
      const query = (filter: Parameters<typeof querySyncAbortable>[2]) =>
        querySyncAbortable(pool, relays, filter, {
          maxWait: TIMEOUT_MS,
          signal: controller.signal,
        }).catch(() => [] as Event[]);
      const eventRefs = refs.filter(
        (r): r is Extract<EmbedRef, { type: 'event' }> => r.type === 'event',
      );
      const byAuthor = new Map<string, Extract<EmbedRef, { type: 'address' }>[]>();
      for (const r of refs) {
        if (r.type !== 'address') continue;
        const k = `${r.kind}:${r.pubkey}`;
        byAuthor.set(k, [...(byAuthor.get(k) ?? []), r]);
      }
      const jobs: Promise<void>[] = [];
      if (eventRefs.length > 0) {
        const ids = [...new Set(eventRefs.map((r) => r.id))];
        jobs.push(
          query({ ids, limit: ids.length }).then(async (events) => {
            for (const e of events) {
              await scheduler.maybeYield();
              if (ids.includes(e.id) && hasValidSignature(e)) found.set(`e:${e.id}`, e);
            }
            deliverOrdinary((ref) => ref.type === 'event');
          }),
        );
      }
      for (const group of byAuthor.values()) {
        const { kind, pubkey } = group[0];
        const ds = [...new Set(group.map((r) => r.identifier))];
        jobs.push(
          query({ kinds: [kind], authors: [pubkey], '#d': ds, limit: ds.length * 3 }).then(
            async (events) => {
              for (const e of events) {
                await scheduler.maybeYield();
                const k = `a:${kind}:${pubkey}:${dTag(e)}`;
                if (
                  e.kind === kind &&
                  e.pubkey === pubkey &&
                  ds.includes(dTag(e)) &&
                  newer(e, found.get(k)) &&
                  hasValidSignature(e)
                )
                  found.set(k, e);
              }
              deliverOrdinary(
                (ref) => ref.type === 'address' && ref.kind === kind && ref.pubkey === pubkey,
              );
            },
          ),
        );
      }
      await Promise.all(jobs);
    }
    const listings = [
      ...new Map(
        [...found.values()].filter((e) => e.kind === PRODUCT_KIND).map((e) => [e.id, e]),
      ).values(),
    ];
    let products: Awaited<ReturnType<typeof reconcileEmbedProducts>>;
    try {
      products = await reconcileEmbedProducts(listings, relays, TIMEOUT_MS, controller.signal);
    } catch {
      // Keep the previous best-effort fallback on transport failure.
      products = new Map(listings.map((event) => [event.id, parseMarketListing(event)]));
    }
    for (const [key, item] of batch) {
      const event = found.get(embedKey(item.ref)) ?? null;
      const product = event?.kind === PRODUCT_KIND ? (products.get(event.id) ?? null) : undefined;
      const result: EmbedResult =
        event?.kind === PRODUCT_KIND
          ? { event: product?.listing?.event ?? event, product }
          : { event };
      deliver(key, item, result);
    }
  } finally {
    scheduler.dispose();
    // Completed subscriptions mark their sockets idle. Preserve any relay
    // still serving another reader; remove idle hint sockets and bookkeeping.
    pruneIdleRelays();
  }
}

/** Test hook — drop all cached / queued state. */
export function __resetEmbedCacheForTests(): void {
  cache.clear();
  queue.clear();
  inFlight.clear();
  if (timer) clearTimeout(timer);
  timer = null;
}
