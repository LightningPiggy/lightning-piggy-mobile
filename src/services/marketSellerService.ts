import { enabledAppRelays } from './appRelayPrefs';
// Relay I/O for the seller side of the Market (#1273): fetch the user's own
// Gamma Markets events and publish newly signed ones. Thin shell over the
// pure builders/reducer in utils/marketSeller*.
import { lockRelays } from '../config/testRelayLockdown';
import { MARKET_RELAYS } from '../utils/marketListingsQuery';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Event, Filter } from 'nostr-tools';
import { trackRelays, DEFAULT_RELAYS, publishSignedEvent } from './nostrService';
import { acquireMarketListingsPool } from './marketListingsPool';
import { verifyEventCached } from './nostrVerifyCache';
import {
  sellerCacheStorageKey as cacheKey,
  sellerHiddenStorageKey as hiddenKey,
  isSellerAccountForgotten,
  sellerStoreState,
} from './sellerEventStore';
import type { RevisionResult } from '../utils/marketSellerRevision';
import { reduceSellerSnapshot } from '../utils/marketSellerSnapshot';
import { querySyncAbortable } from './relayQuery';
import { selectHealthyRelays } from './relayHealth';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import {
  COLLECTION_KIND,
  DELETION_KIND,
  LISTING_KIND,
  SHIPPING_OPTION_KIND,
} from '../utils/marketSellerEvents';

const FETCH_MAX_WAIT_MS = 8000;
const PUBLISH_TIMEOUT_MS = 12000;
const MAX_RELAYS = 8;
const MAX_HIDDEN = 200;
const SELLER_KINDS = [LISTING_KIND, COLLECTION_KIND, SHIPPING_OPTION_KIND, DELETION_KIND];

// Reads include every publication target and displaced write relay. Only
// publishing caps the full set; reads query it in bounded batches instead.
function sellerEventRelays(relays: readonly string[], pubkey?: string): string[] {
  return lockRelays(
    [...new Set([...enabledAppRelays('market', MARKET_RELAYS), ...relays])],
    pubkey,
  );
}

/** Keep the user's write relays distinct for pre-publish revision checks. */
export function sellerRelays(relays: readonly { url: string; write: boolean; read: boolean }[]) {
  const write = relays.filter((r) => r.write && /^wss:\/\//.test(r.url)).map((r) => r.url);
  return [...new Set(write.length > 0 ? write : enabledAppRelays('default', DEFAULT_RELAYS))].slice(
    0,
    MAX_RELAYS,
  );
}

/**
 * Keep only events this author really signed: relays ignore `authors` /
 * `kinds` at will, and a forged "own" listing must never become the base of
 * an edit that the user then re-signs. Verification yields between events
 * so a large snapshot can't wedge the JS thread.
 */
export async function verifiedOwnEvents(
  events: readonly Event[],
  pubkey: string,
  kinds: readonly number[],
  signal?: AbortSignal,
): Promise<Event[]> {
  const scheduler = createYieldScheduler({ signal, safetyEvery: 25 });
  const out: Event[] = [];
  const seen = new Set<string>();
  try {
    for (const event of events) {
      if (signal?.aborted) break;
      // Dedupe on VERIFIED ids only: a forged copy reusing a real id must
      // not hide the genuine copy another relay returned.
      if (event.pubkey !== pubkey || !kinds.includes(event.kind) || seen.has(event.id)) continue;
      let ok = false;
      try {
        // Verify a clean copy: nostr-tools trusts a cached `verified` symbol
        // on the object, which a copied / forged event can carry along.
        ok = verifyEventCached({
          id: event.id,
          pubkey: event.pubkey,
          created_at: event.created_at,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
          sig: event.sig,
        });
      } catch {
        ok = false;
      }
      if (ok) {
        seen.add(event.id);
        out.push(event);
      }
      await scheduler.maybeYield();
    }
  } finally {
    scheduler.dispose();
  }
  return out;
}

/**
 * Query each relay on its own and require a QUORUM — at least half of them
 * (min 1) completing with EOSE — before an answer counts. Fewer is "unknown"
 * and rejects: an empty answer from one fast relay must not read as "no
 * shop", while one dead relay in the user's list mustn't block everything.
 * Returns the union of the relays that completed. When requiredRelays is
 * supplied, only that subset determines the quorum and must answer.
 */
export async function queryQuorum(
  relays: readonly string[],
  filter: Filter,
  signal?: AbortSignal,
  requiredRelays?: readonly string[],
): Promise<Event[]> {
  // Relays parked as dead (#1326) neither burn a timeout nor count against
  // the quorum; selectHealthyRelays always keeps the healthiest two.
  const unique = selectHealthyRelays([...new Set(relays)]);
  const lease = acquireMarketListingsPool(unique);
  try {
    const results = await Promise.allSettled(
      unique.map((relay) =>
        querySyncAbortable(lease.pool, [relay], filter, {
          maxWait: FETCH_MAX_WAIT_MS,
          signal,
          rejectOnAllRelaysFailure: true,
          rejectOnTimeout: true,
        }),
      ),
    );
    const answered = results.filter(
      (r): r is PromiseFulfilledResult<Event[]> => r.status === 'fulfilled',
    );
    const quorumRelays = requiredRelays
      ? unique.filter((relay) => requiredRelays.includes(relay))
      : unique;
    const answeredForQuorum = requiredRelays
      ? results.filter(
          (result, index) =>
            result.status === 'fulfilled' && requiredRelays.includes(unique[index]),
        ).length
      : answered.length;
    const quorum = Math.max(1, Math.ceil(quorumRelays.length / 2));
    if (signal?.aborted) {
      throw new Error(`Only ${answered.length} of ${unique.length} relays answered`);
    }
    if (requiredRelays && answeredForQuorum === 0) {
      throw new Error('No seller write relay answered');
    }
    if (answeredForQuorum < quorum) {
      throw new Error(`Only ${answeredForQuorum} of ${quorumRelays.length} relays answered`);
    }
    return answered.flatMap((r) => r.value);
  } finally {
    lease.release();
  }
}

/** Every bounded batch must complete before a seller read is authoritative. */
async function querySellerBatches(
  relays: readonly string[],
  filter: Filter,
  signal?: AbortSignal,
  requiredRelays?: readonly string[],
): Promise<Event[]> {
  const events: Event[] = [];
  for (let start = 0; start < relays.length; start += MAX_RELAYS) {
    events.push(
      ...(await queryQuorum(
        relays.slice(start, start + MAX_RELAYS),
        filter,
        signal,
        requiredRelays,
      )),
    );
  }
  return events;
}

/**
 * One bounded snapshot of the seller's listings, shop, zones and deletions.
 * FAILS CLOSED: without a relay quorum it's an error, never an empty
 * "no shop" — saving a blank setup would replace the real shop. The
 * shop + zones and the market deletions are separate queries so other
 * features' kind-5s (and a long listing history) can't crowd them out.
 */
export async function fetchSellerEvents(input: {
  pubkey: string;
  relays: string[];
  signal?: AbortSignal;
}): Promise<Event[]> {
  const pubkey = input.pubkey.toLowerCase();
  const writeRelays = lockRelays(
    input.relays.length ? input.relays : enabledAppRelays('default', DEFAULT_RELAYS),
    pubkey,
  );
  const relays = sellerEventRelays(writeRelays, pubkey);
  trackRelays(relays);
  const batches = await Promise.all([
    querySellerBatches(
      relays,
      { kinds: [COLLECTION_KIND, SHIPPING_OPTION_KIND], authors: [pubkey], limit: 100 },
      input.signal,
      writeRelays,
    ),
    querySellerBatches(
      relays,
      { kinds: [LISTING_KIND], authors: [pubkey], limit: 300 },
      input.signal,
      writeRelays,
    ),
    querySellerBatches(
      relays,
      {
        kinds: [DELETION_KIND],
        authors: [pubkey],
        '#k': [String(LISTING_KIND), String(SHIPPING_OPTION_KIND), String(COLLECTION_KIND)],
        limit: 200,
      },
      input.signal,
      writeRelays,
    ),
  ]);
  return verifiedOwnEvents(batches.flat(), pubkey, SELLER_KINDS, input.signal);
}

/**
 * The newest verified revision of one of the user's addressable events, or
 * null when relays completed with none. Used right before publishing so an
 * edit never silently overwrites a newer revision made elsewhere (and a
 * first-time shop never replaces a shop a slow relay hadn't returned).
 * Fails closed unless a seller write-relay quorum completes every batch;
 * marketplace replies supplement those results but cannot replace them.
 */
export async function fetchLatestRevision(input: {
  pubkey: string;
  kind: number;
  dTag: string;
  baseId?: string;
  relays: string[];
}): Promise<RevisionResult> {
  const pubkey = input.pubkey.toLowerCase();
  const writeRelays = lockRelays(
    input.relays.length ? input.relays : enabledAppRelays('default', DEFAULT_RELAYS),
    pubkey,
  );
  const relays = sellerEventRelays(writeRelays, pubkey);
  trackRelays(relays);
  // Marketplace replies supplement the write-relay quorum in every batch;
  // they cannot replace it (even when health filtering parks write relays).
  const queryRevision = (filter: Filter) =>
    querySellerBatches(relays, filter, undefined, writeRelays);
  const coordinate = `${input.kind}:${pubkey}:${input.dTag}`;
  // The revisions plus any NIP-09 deletion of that address: a deleted shop
  // that some relays still serve is not "an existing shop".
  const [events, deletions] = await Promise.all([
    queryRevision({
      kinds: [input.kind],
      authors: [pubkey],
      '#d': [input.dTag],
      limit: 5,
    }),
    queryRevision({
      kinds: [DELETION_KIND],
      authors: [pubkey],
      '#a': [coordinate],
      limit: 20,
    }),
  ]);
  const ids = [...new Set([...events.map((e) => e.id), ...(input.baseId ? [input.baseId] : [])])];
  const idDeletions = ids.length
    ? await queryRevision({
        kinds: [DELETION_KIND],
        authors: [pubkey],
        '#e': ids,
        limit: 20,
      })
    : [];
  const [own, ownDeletions] = await Promise.all([
    verifiedOwnEvents(events, pubkey, [input.kind]),
    verifiedOwnEvents([...deletions, ...idDeletions], pubkey, [DELETION_KIND]),
  ]);
  let deletedAt = -1;
  const deletedIds = new Set<string>();
  for (const d of ownDeletions) {
    for (const t of d.tags) {
      if (t[0] === 'a' && t[1] === coordinate) deletedAt = Math.max(deletedAt, d.created_at);
      if (t[0] === 'e' && t[1]) deletedIds.add(t[1]);
    }
  }
  let newest: Event | null = null;
  for (const e of own) {
    if (e.tags.find((t) => t[0] === 'd')?.[1] !== input.dTag) continue;
    if (e.created_at <= deletedAt || deletedIds.has(e.id)) continue;
    if (
      !newest ||
      e.created_at > newest.created_at ||
      (e.created_at === newest.created_at && e.id < newest.id)
    )
      newest = e;
  }
  return { event: newest, deletedAt, deletedIds: [...deletedIds] };
}

/** Publish to marketplace and seller relays; resolves once ONE relay accepts, rejects
 * if none do within the deadline. */
export async function publishSellerEvent(signed: Event, relays: string[]): Promise<void> {
  // Reserve room for every marketplace relay before capping user write relays.
  // Lock by the signed author, even if the active account changed while signing.
  const targets = sellerEventRelays(relays, signed.pubkey).slice(0, MAX_RELAYS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Publishing timed out')), PUBLISH_TIMEOUT_MS);
  });
  try {
    await Promise.race([publishSignedEvent(signed, targets), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---- locally hidden (deleted on this device) -------------------------------
// A NIP-09 deletion is a request; some relays keep serving the event. The
// coordinates the user deleted here stay hidden in "My shop" until a newer
// revision appears.

export async function loadHiddenListings(pubkey: string): Promise<Map<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(hiddenKey(pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Map();
    return new Map(
      parsed.filter(
        (e): e is [string, number] =>
          Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number',
      ),
    );
  } catch {
    return new Map();
  }
}

export async function saveHiddenListings(
  pubkey: string,
  hidden: ReadonlyMap<string, number>,
): Promise<void> {
  const newest = [...hidden.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_HIDDEN);
  try {
    await AsyncStorage.setItem(hiddenKey(pubkey), JSON.stringify(newest));
  } catch {
    // Best effort — the relay deletion still applies.
  }
}

// ---- persisted snapshot -----------------------------------------------------
// The winning revisions (shop, zones, newest listings) plus recent deletions,
// so "My shop" paints instantly after a cold start and a slow or unreachable
// relay set can't make an existing shop look like a first-time setup.

const MAX_CACHED_LISTINGS = 150;
const MAX_CACHED_DELETIONS = 50;

const isEventLike = (e: unknown): e is Event =>
  !!e &&
  typeof e === 'object' &&
  typeof (e as Event).id === 'string' &&
  typeof (e as Event).pubkey === 'string' &&
  typeof (e as Event).kind === 'number' &&
  typeof (e as Event).created_at === 'number' &&
  typeof (e as Event).content === 'string' &&
  Array.isArray((e as Event).tags);

export async function loadSellerCache(pubkey: string): Promise<Event[]> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((e): e is Event => isEventLike(e) && e.pubkey === pubkey)
      : [];
  } catch {
    return [];
  }
}

/** Persist the account's current snapshot from the in-memory store. */
export async function persistSellerSnapshot(pubkey: string): Promise<void> {
  if (isSellerAccountForgotten(pubkey)) return;
  const state = sellerStoreState(pubkey);
  const all = [...state.events.values()];
  const snapshot = reduceSellerSnapshot(all, pubkey, state.hidden);
  const deletions = all
    .filter((e) => e.kind === DELETION_KIND)
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, MAX_CACHED_DELETIONS);
  const keep = [
    ...(snapshot.collections ?? []),
    ...snapshot.zoneEvents.values(),
    ...snapshot.listings.slice(0, MAX_CACHED_LISTINGS),
    ...deletions,
  ];
  try {
    await AsyncStorage.setItem(cacheKey(pubkey), JSON.stringify(keep));
  } catch {
    // Best effort — relays remain the source of truth.
  }
}
