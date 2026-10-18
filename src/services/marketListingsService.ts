import type { Event, Filter } from 'nostr-tools';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { pool, trackRelays } from './nostrPool';
import { querySyncAbortable } from './relayQuery';
import { acquireMarketListingsPool } from './marketListingsPool';
import { selectHealthyRelays } from './relayHealth';
import { collectRelaySnapshot } from './relaySnapshot';
import { verifyEventCached } from './nostrVerifyCache';
import { nostrGetEventHash } from './nostrCrypto';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import {
  marketListingProductId,
  reduceMarketListings,
  selectVerifiedListings,
  type AuthorScope,
} from '../utils/marketListings';
import {
  deletionFilters as listingDeletionFilters,
  listingFilters,
  MARKET_LISTING_KINDS,
  marketSnapshotRelays,
  openListingFilters,
  openListingSince,
} from '../utils/marketListingsQuery';
import { curateOpenListingEvents, curateOpenListingProducts } from '../utils/marketOpenScope';
import { addressRefs, deletionFilters, idRefs } from '../utils/nip09';
import { hasValidSignature } from '../utils/eventSignature';
import { isNewerRevision } from '../utils/marketSellerRevision';
import { startJsStallProbe } from '../utils/jsStallProbe';
import { PERF_LOGS_ENABLED } from '../utils/perfLog';
import { ROBOTECHY_PUBKEY } from '../utils/marketSample';
import type { MarketProduct } from '../data/marketProducts';
import { mergeMarketSnapshot } from '../utils/marketSnapshotMerge';
import { unreachableMarketSellers } from '../utils/marketUnreachableSellers';

export interface MarketListingsResult {
  products: MarketProduct[];
  incomplete: boolean;
  /** In-scope sellers with unanswered listing sources and nothing left to show. */
  unreachableSellers?: string[];
  /** Deliberate query/work limits, separately from an unanswered relay pass. */
  budgetLimited?: boolean;
  transportFailed?: boolean;
  /** Relays that answered the listings pass in full. */
  answeredRelays?: string[];
  /**
   * Product ids this snapshot has ruled on without showing them: listings a
   * verified revision withdrew, superseded or excluded from display, plus
   * carried-over listings a NIP-09 deletion (or expiry) now removes. A merge
   * must never keep a previous copy of these.
   */
  withdrawn?: string[];
}

export interface MarketListingsOptions {
  /** Listing events still shown from an earlier snapshot. Pass 2 looks up
   * their deletions too, so a stale copy can't outlive its withdrawal while
   * its own relay is unreachable. */
  carried?: readonly Event[];
  /** Products/provenance used to determine whether an unreachable seller is still visible. */
  previousProducts?: readonly MarketProduct[];
}

const MAX_AUTHORS = 1024;
const MAX_EVENTS = 1200;
/** Deletions get their own budget so a full listing pass can't starve them. */
const MAX_DELETIONS = 600;
/**
 * Forged LISTING signatures tolerated per snapshot before giving up (and
 * flagging it incomplete). Every candidate already hashes to its id, so
 * failures mean a relay is serving fakes — it must not buy ~25 ms of
 * verification apiece.
 */
const MAX_FAILED_CHECKS = 64;
/** Stop and mark the snapshot unavailable after too many forged deletions. */
const MAX_FAILED_DELETION_CHECKS = 32;
/** Total oversized checks, including successful signatures and replacements.
 * Beyond this budget, affected authors are withheld without further crypto. */
const MAX_OVERSIZED_CHECKS = 16;
const MAX_PRODUCTS = 250;
/** Listings painted before the rest are verified — about two screens of grid. */
const FIRST_PAGE = 12;
/** Hard ceiling for both passes together. */
const TIMEOUT_MS = 10000;
/** Time other relays get once the first one has answered in full. */
const GRACE_MS = 2000;
// Signature checks hash the whole payload; beyond this we can't afford to
// verify, so the author must be withheld if a listing revision could be skipped.
const MAX_VERIFY_CHARS = 1048576;

/**
 * A listing batch that hit its `limit` only left out listings OLDER than
 * `truncatedSince`. When the display is already full (capped at the newest
 * MAX_PRODUCTS) with listings no older than that, nothing missing could have
 * made the cut — so a prolific seller filling one batch doesn't brand the
 * whole snapshot "could not be loaded".
 */
export function listingsCutMattered(
  truncatedSince: number | null,
  products: readonly MarketProduct[],
  capped: boolean,
): boolean {
  if (truncatedSince === null) return false;
  if (!capped || products.length < MAX_PRODUCTS) return true;
  const shownUntil = products[MAX_PRODUCTS - 1].listing?.event.created_at ?? -Infinity;
  return shownUntil < truncatedSince;
}

/**
 * Foreground snapshot of followed sellers' listings, bounded and abortable.
 *
 * Pass 1 fetches listings only; pass 2 fetches just the deletions that target
 * them (see `utils/marketListingsQuery`). Either pass completes once one relay
 * has answered in full plus a short grace, so a dead relay can't hold the
 * screen on "Loading…" until the deadline.
 */
export async function fetchMarketListings(
  authors: readonly string[],
  relays: readonly string[],
  signal: AbortSignal,
  /** Called at most once with the newest verified listings, before the rest. */
  onFirstPage?: (products: MarketProduct[]) => void,
  options: MarketListingsOptions = {},
): Promise<MarketListingsResult> {
  const keys = [...new Set(authors.filter((a) => /^[a-f0-9]{64}$/.test(a)))].sort();
  const scope = new Set(keys.slice(0, MAX_AUTHORS));
  if (signal.aborted || scope.size === 0) return { products: [], incomplete: false };
  return withSnapshotRelays(relays, keys.length > MAX_AUTHORS, (urls, relayPool, limited) =>
    runSnapshot(
      scope,
      limited,
      urls,
      relayPool,
      signal,
      onFirstPage,
      // Already-verified listings from a previous snapshot, in scope only.
      (options.carried ?? []).filter(
        (event) => scope.has(event.pubkey) && MARKET_LISTING_KINDS.includes(event.kind),
      ),
      options.previousProducts ?? [],
      { filters: listingFilters([...scope]) },
    ),
  );
}

/** Every author is in scope — the All seller scope has no author filter. */
const ANY_AUTHOR: AuthorScope = { has: () => true };

/**
 * Experimental "All" scope: the newest listings from ANYONE on the market
 * relays + the user's read relays. Same two passes, verification, deletion
 * handling and budgets as the author-scoped snapshot; pass 1 is a bounded
 * newest-N sample (`limit` + a 90-day `since`, see `openListingFilters`), and
 * the spam rules in `utils/marketOpenScope` run after authenticating revision winners
 * and again on the final products.
 */
export async function fetchOpenMarketListings(
  relays: readonly string[],
  signal: AbortSignal,
  onFirstPage?: (products: MarketProduct[]) => void,
  options: MarketListingsOptions = {},
): Promise<MarketListingsResult> {
  if (signal.aborted) return { products: [], incomplete: false };
  return withSnapshotRelays(relays, false, (urls, relayPool, limited) =>
    runSnapshot(
      ANY_AUTHOR,
      limited,
      urls,
      relayPool,
      signal,
      onFirstPage,
      (options.carried ?? []).filter((event) => MARKET_LISTING_KINDS.includes(event.kind)),
      options.previousProducts ?? [],
      {
        filters: openListingFilters(openListingSince()),
        sampled: true,
        prefilter: (events, maybeYield, verify) =>
          curateOpenListingEvents(events, { verify, maybeYield, carried: options.carried }),
        curate: curateOpenListingProducts,
      },
    ),
  );
}

/** Plan the snapshot relays and lend the structure-only pool for one run. */
async function withSnapshotRelays(
  relays: readonly string[],
  initiallyLimited: boolean,
  run: (
    urls: string[],
    relayPool: Pick<AbstractSimplePool, 'ensureRelay'>,
    limited: boolean,
  ) => Promise<MarketListingsResult>,
): Promise<MarketListingsResult> {
  const planned = marketSnapshotRelays(relays);
  // Leave out relays parked as dead (#1326): they'd only burn a connect
  // timeout each. The healthiest 2 are always kept.
  const urls = selectHealthyRelays(planned.urls);
  if (urls.length === 0) return { products: [], incomplete: true, answeredRelays: [] };
  // A dedicated structure-only pool: every event is verified here before use
  // (see marketListingsPool). Its sockets close when the last snapshot ends.
  const lease = acquireMarketListingsPool(urls);
  try {
    return await run(urls, lease.pool, initiallyLimited || planned.dropped);
  } finally {
    lease.release();
  }
}

/** What pass 1 asks for, and how its results are judged. */
interface SnapshotPlan {
  filters: Filter[];
  /** Pass 1 is a deliberate newest-N sample: a reply that hits its `limit`
   * is the sample's edge, not a cut-off load. */
  sampled?: boolean;
  /** Authenticates revision winners before narrowing the candidates. */
  prefilter?: (
    events: Event[],
    maybeYield: () => Promise<void>,
    verify: (event: Event) => boolean,
  ) => Promise<Event[]>;
  /** Final say on the reduced products, before the display cap. */
  curate?: (products: MarketProduct[]) => MarketProduct[];
}

async function runSnapshot(
  scope: AuthorScope,
  initiallyLimited: boolean,
  urls: string[],
  relayPool: Pick<AbstractSimplePool, 'ensureRelay'>,
  signal: AbortSignal,
  onFirstPage: ((products: MarketProduct[]) => void) | undefined,
  carried: readonly Event[],
  previousProducts: readonly MarketProduct[],
  plan: SnapshotPlan,
): Promise<MarketListingsResult> {
  const curate = plan.curate ?? ((products: MarketProduct[]) => products);
  const startedAt = Date.now();
  const probe = PERF_LOGS_ENABLED ? startJsStallProbe() : null;
  const deadline = startedAt + TIMEOUT_MS;
  // Planning caps are deliberate, unlike dropping an unchecked candidate.
  let limited = false;
  let received = 0;
  const receivedAuthors = new Set<string>();
  const observedAuthors = new Set<string>();
  // Keyed by id AND signature: the id doesn't cover the signature, so a
  // bad-signature copy of a genuine payload must not displace the good copy.
  const events = new Map<string, Event>();
  let listingCount = 0;
  let deletionCount = 0;
  let deletionUnavailable = false;
  const withheldAuthors = new Set<string>();
  const budgetFull = (deletion: boolean) =>
    deletion ? deletionCount >= MAX_DELETIONS : listingCount >= MAX_EVENTS;
  // Oversized stand-ins are verified or fail closed after the work cap.
  const trusted = new WeakSet<Event>();
  // Verified-but-oversized events are never rendered, yet still take part in
  // revision ordering and deletion. Keep small, non-renderable stand-ins
  // (sharing their kind's budget) instead of the payloads.
  const suppressions = new Map<string, Event>();
  // Trust contract: this snapshot reads through its OWN structure-only pool
  // (marketListingsPool), so no event here has had its signature checked.
  // Listings are verified lazily below (winning revisions only); deletions in
  // a yielded loop before any can hide a listing; oversized events in a
  // bounded yielded queue. The SHARED pool still fully verifies listing kinds
  // for every other reader — don't add them to its SKIP_VERIFY_KINDS.
  // `verifyEventCached` skips the schnorr for ids already checked this
  // session, so a refetch doesn't pay for the snapshot again.
  const verified = verifyEventCached;
  // Keep sources per payload AND signature until that candidate authenticates.
  const candidateSources = new Map<string, Set<string>>();
  const seenOn = new Map<string, Set<string>>();
  const noteCandidateSource = (event: Event, url?: string) => {
    if (!url || !MARKET_LISTING_KINDS.includes(event.kind)) return;
    const key = `${event.id}:${event.sig}`;
    const sources = candidateSources.get(key);
    if (sources) sources.add(url);
    else candidateSources.set(key, new Set([url]));
  };
  // Only an authenticated revision at least as recent as the carried one
  // can rule it out. Signature validity alone does not establish ordering.
  const authenticatedListings = new Map<string, Event>();
  const carriedRevisions = new Map<string, Event>();
  for (const event of carried) {
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!d) continue;
    try {
      const id = marketListingProductId(event.kind, event.pubkey, d);
      if (isNewerRevision(event, carriedRevisions.get(id) ?? null)) carriedRevisions.set(id, event);
    } catch {
      // Malformed identifiers cannot name a renderable listing.
    }
  }
  const noteAuthenticatedListing = (event: Event) => {
    if (!MARKET_LISTING_KINDS.includes(event.kind)) return;
    receivedAuthors.add(event.pubkey);
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!d) return;
    try {
      const id = marketListingProductId(event.kind, event.pubkey, d);
      if (isNewerRevision(event, authenticatedListings.get(id) ?? null))
        authenticatedListings.set(id, event);
      const sources = candidateSources.get(`${event.id}:${event.sig}`);
      if (sources) {
        const relays = seenOn.get(id);
        if (relays) sources.forEach((url) => relays.add(url));
        else seenOn.set(id, new Set(sources));
      }
    } catch {
      // Malformed identifiers cannot name a renderable listing.
    }
  };
  // Each queued payload keeps the relay that served it; that relay is only
  // recorded as a source once the payload verifies (a forged oversized copy
  // must never become provenance for the genuine listing).
  const oversizedQueue: { event: Event; url: string | undefined }[] = [];
  // Retain queued id/signature pairs across both passes; at most MAX_OVERSIZED_CHECKS entries.
  const oversizedIds = new Set<string>();
  let oversizedChecks = 0;
  const idMatches = (event: Event) => {
    try {
      return nostrGetEventHash(event) === event.id;
    } catch {
      return false;
    }
  };
  // Ids and addresses of the listings pass 1 found. Deletions (pass 2) only
  // matter where they hit one of these.
  let knownTargets = new Set<string>();
  // The deletion's own targets among `knownTargets`: `e` ids, and `a`
  // addresses of the deletion author's OWN listings.
  const relevantTargets = (event: Event) =>
    event.tags
      .filter(
        (t) =>
          knownTargets.has(t[1] ?? '') &&
          (t[0] === 'e' || (t[0] === 'a' && t[1]?.split(':')[1] === event.pubkey)),
      )
      .map((t) => [t[0], t[1]] as [string, string]);
  // A bulk deletion over the tag limit still withdraws listings: keep a
  // trimmed copy with only its targets among the listings found.
  const suppressOversizedDeletion = (event: Event) => {
    if (suppressions.has(event.id)) return;
    if (budgetFull(true)) {
      deletionUnavailable = true;
      return;
    }
    const tags = relevantTargets(event);
    if (tags.length === 0) return;
    const standIn = { ...event, content: '', tags };
    trusted.add(standIn);
    suppressions.set(event.id, standIn);
    deletionCount++;
  };
  const suppressOversized = (event: Event) => {
    if (event.content.length > MAX_VERIFY_CHARS) {
      if (event.kind === 5) deletionUnavailable = true;
      else withheldAuthors.add(event.pubkey);
      // Never apply targets from a payload we cannot authenticate.
      return;
    }
    if (event.kind === 5) {
      suppressOversizedDeletion(event);
      return;
    }
    if (![30018, 30402].includes(event.kind)) return;
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    // Over-long ids are rejected as listings anyway, so there's nothing to hide.
    if (!d || new TextEncoder().encode(d).length > 255) return;
    const address = `${event.kind}:${event.pubkey}:${d}`;
    // Keep only the revision that would win this address (newest, then
    // lowest id — the reducer's own order), so a noisy relay can't grow this.
    const existing = suppressions.get(address);
    if (
      existing &&
      (existing.created_at > event.created_at ||
        (existing.created_at === event.created_at && existing.id <= event.id))
    )
      return;
    if (!existing && budgetFull(false)) {
      withheldAuthors.add(event.pubkey);
      return;
    }
    // Same id/kind/created_at as the real revision so it competes normally;
    // empty content + a non-active status make it non-renderable.
    const standIn = {
      ...event,
      content: '',
      tags: [
        ['d', d],
        ['status', 'oversized'],
      ],
    };
    trusted.add(standIn);
    suppressions.set(address, standIn);
    if (!existing) listingCount++;
  };
  const drainOversized = async () => {
    const scheduler = createYieldScheduler({ signal, safetyEvery: 32 });
    try {
      for (const { event, url: sourceUrl } of oversizedQueue) {
        await scheduler.maybeYield();
        if (signal.aborted) break;
        // Release the queued candidate's reserved slot before retaining its marker.
        if (event.kind === 5) deletionCount--;
        else listingCount--;
        oversizedChecks++;
        if (verified(event)) {
          noteCandidateSource(event, sourceUrl);
          noteAuthenticatedListing(event);
          suppressOversized(event);
        }
      }
      oversizedQueue.length = 0;
    } finally {
      scheduler.dispose();
    }
  };
  const ingest = (event: Event, url?: string) => {
    received++;
    if (!scope.has(event.pubkey) || event.created_at > Date.now() / 1000 + 300) return;
    if (MARKET_LISTING_KINDS.includes(event.kind)) observedAuthors.add(event.pubkey);
    if (event.content.length > 32768 || event.tags.length > 256) {
      const key = `${event.id}:${event.sig}`;
      if (oversizedIds.has(key)) {
        if (idMatches(event)) noteCandidateSource(event, url);
        return;
      }
      if (
        event.content.length > MAX_VERIFY_CHARS ||
        budgetFull(event.kind === 5) ||
        oversizedChecks + oversizedQueue.length >= MAX_OVERSIZED_CHECKS
      ) {
        limited = true;
        // Never trust an unchecked revision or deletion. Withhold every listing
        // of an affected author so an older revision cannot resurface.
        // Unchecked deletions still make the whole snapshot unavailable.
        if (event.kind === 5) deletionUnavailable = true;
        else withheldAuthors.add(event.pubkey);
      } else {
        // Queued payloads share the event budget with ordinary candidates.
        if (event.kind === 5) deletionCount++;
        else listingCount++;
        oversizedIds.add(key);
        oversizedQueue.push({ event, url });
      }
      return;
    }
    const key = `${event.id}:${event.sig}`;
    if (events.has(key)) {
      if (idMatches(event)) noteCandidateSource(event, url);
      return;
    }
    const deletion = event.kind === 5;
    if (budgetFull(deletion)) {
      limited = true;
      if (deletion) deletionUnavailable = true;
      // Dropping a possible withdrawal makes the snapshot unavailable.
      return;
    }
    // Listings are verified later (winners only); a payload that doesn't even
    // hash to its id is junk, so drop it now before it takes budget.
    if (!idMatches(event)) return;
    events.set(key, event);
    noteCandidateSource(event, url);
    if (deletion) deletionCount++;
    else listingCount++;
  };

  const listings = await collectRelaySnapshot({
    urls,
    filters: plan.filters,
    maxConcurrentFilters: 2,
    signal,
    deadline,
    graceMs: GRACE_MS,
    onEvent: ingest,
    relayPool,
  });
  await drainOversized();
  const listingsDoneAt = Date.now();
  const found = [...events.values(), ...suppressions.values()].filter((e) => e.kind !== 5);
  // Carried-over listings take part in the deletion lookup only.
  const candidates = [...found, ...carried];
  knownTargets = new Set(
    candidates.flatMap((e) => {
      const d = e.tags.find((t) => t[0] === 'd')?.[1];
      return d ? [e.id, `${e.kind}:${e.pubkey}:${d}`] : [e.id];
    }),
  );
  // Ask every relay that responded in pass 1 (not just those that finished
  // in time — one that served listings may hold their deletions too). Relays
  // that never answered at all are left out, so they can't stall pass 2.
  const deletions =
    candidates.length === 0 || signal.aborted
      ? { answered: urls, responded: urls, truncated: false, truncatedSince: null }
      : await collectRelaySnapshot({
          urls: listings.responded.length > 0 ? listings.responded : urls,
          filters: listingDeletionFilters(candidates),
          maxConcurrentFilters: 2,
          signal,
          deadline,
          graceMs: GRACE_MS,
          onEvent: ingest,
          relayPool,
        });

  await drainOversized();
  const scheduler = createYieldScheduler({ signal, safetyEvery: 32 });
  try {
    let firstPageAt = 0;
    // Authenticate deletions before they can hide listings. Exhausting the
    // failure budget withholds the snapshot rather than trusting unchecked targets.
    let failedDeletionChecks = 0;
    for (const [key, event] of events) {
      if (event.kind !== 5) continue;
      if (signal.aborted || failedDeletionChecks >= MAX_FAILED_DELETION_CHECKS) {
        events.delete(key);
        continue;
      }
      await scheduler.maybeYield();
      if (!verified(event)) {
        failedDeletionChecks++;
        events.delete(key);
      }
    }
    const deletionChecksGaveUp = failedDeletionChecks >= MAX_FAILED_DELETION_CHECKS;
    let failedListingChecks = 0;
    const verifyListing = (event: Event) => {
      if (signal.aborted || failedListingChecks >= MAX_FAILED_CHECKS) return false;
      const valid = trusted.has(event) || verified(event);
      if (valid) {
        trusted.add(event);
        noteAuthenticatedListing(event);
      } else failedListingChecks++;
      return valid;
    };
    const eligible =
      signal.aborted || deletionChecksGaveUp || deletionUnavailable
        ? []
        : [...events.values(), ...suppressions.values()].filter(
            (event) => !withheldAuthors.has(event.pubkey),
          );
    const selection = await selectVerifiedListings(
      plan.prefilter && eligible.length > 0
        ? await plan.prefilter(eligible, scheduler.maybeYield, verifyListing)
        : eligible,
      scope,
      {
        // Once aborted, fail fast instead of verifying the rest for nothing.
        verify: verifyListing,
        maybeYield: scheduler.maybeYield,
        cap: MAX_PRODUCTS,
        maxFailures: MAX_FAILED_CHECKS,
        firstPage: onFirstPage && {
          size: FIRST_PAGE,
          ready: (picked) => {
            if (signal.aborted) return;
            firstPageAt = Date.now();
            onFirstPage(curate(reduceMarketListings(picked, scope)));
          },
        },
      },
    );
    // Reserve a candidate beyond the newest-250 cut through the SAME verifier,
    // revision reducer and authenticated deletions, without expanding the rail.
    const safeEvents =
      signal.aborted ||
      deletionChecksGaveUp ||
      selection.gaveUp ||
      deletionUnavailable ||
      withheldAuthors.has(ROBOTECHY_PUBKEY)
        ? []
        : [...events.values(), ...suppressions.values()].filter(
            (event) => event.pubkey === ROBOTECHY_PUBKEY,
          );
    const reserved = await selectVerifiedListings(safeEvents, scope, {
      verify: verifyListing,
      maybeYield: scheduler.maybeYield,
      cap: 1,
      maxFailures: Math.max(0, MAX_FAILED_CHECKS - failedListingChecks),
    });
    const products = signal.aborted ? [] : curate(reduceMarketListings(selection.events, scope));
    // A sampled pass is cut at its limit by design (see SnapshotPlan.sampled).
    const cutMattered =
      !plan.sampled && listingsCutMattered(listings.truncatedSince, products, selection.overflow);
    const [robot] = signal.aborted ? [] : curate(reduceMarketListings(reserved.events, scope));
    const cappedProducts = products.slice(0, MAX_PRODUCTS);
    if (robot && !cappedProducts.some((product) => product.id === robot.id)) {
      if (cappedProducts.length === MAX_PRODUCTS) cappedProducts.pop();
      cappedProducts.push(robot);
    }
    const shown = new Set(cappedProducts.map((product) => product.id));
    const withheld = signal.aborted || deletionChecksGaveUp || deletionUnavailable;
    const result: MarketListingsResult = {
      products: cappedProducts.map((product) => ({
        ...product,
        listing: product.listing && {
          ...product.listing,
          seenOn: [...(seenOn.get(product.id) ?? [])],
        },
      })),
      answeredRelays: withheld || plan.sampled ? [] : [...listings.answered],
      withdrawn: withheld
        ? []
        : [
            ...[...authenticatedListings]
              .filter(([id, event]) => {
                const previous = carriedRevisions.get(id);
                return (
                  !shown.has(id) &&
                  (!previous || event.id === previous.id || isNewerRevision(event, previous))
                );
              })
              .map(([id]) => id),
            ...carriedWithdrawals(carried, [...events.values(), ...suppressions.values()], scope),
          ],
      // Unanswered passes or unchecked data. Reaching MAX_PRODUCTS is a deliberate display
      // cap (newest first), not a failed load — "could not be loaded, try
      // refreshing" would be untrue, and refreshing can't change it.
      incomplete:
        signal.aborted ||
        limited ||
        deletionChecksGaveUp ||
        deletionUnavailable ||
        withheldAuthors.size > 0 ||
        failedListingChecks >= MAX_FAILED_CHECKS ||
        selection.gaveUp ||
        reserved.gaveUp ||
        cutMattered ||
        deletions.truncated ||
        listings.answered.length === 0 ||
        deletions.answered.length === 0,
    };
    result.unreachableSellers =
      signal.aborted || !(scope instanceof Set)
        ? []
        : unreachableMarketSellers(
            scope,
            urls,
            listings.answered,
            // Unchecked candidates withheld by internal work/display limits
            // cannot establish a missing seller. Otherwise only authenticated
            // listings count: a forged payload must not hide a transport failure.
            withheld || limited || selection.gaveUp || reserved.gaveUp || selection.overflow
              ? new Set([...receivedAuthors, ...observedAuthors])
              : new Set([...receivedAuthors, ...withheldAuthors]),
            previousProducts,
            mergeMarketSnapshot(previousProducts, result),
          );
    // Diagnostics are optional so old cached envelopes remain valid.
    if (
      initiallyLimited ||
      limited ||
      deletionChecksGaveUp ||
      failedListingChecks >= MAX_FAILED_CHECKS ||
      selection.gaveUp ||
      deletions.truncated ||
      cutMattered
    )
      result.budgetLimited = true;
    if (listings.answered.length === 0 || deletions.answered.length === 0)
      result.transportFailed = true;
    if (probe) {
      const stall = probe.stop();
      console.log(
        `[PerfBlock] marketListings total=${Date.now() - startedAt}ms listings=${listingsDoneAt - startedAt}ms ` +
          `firstPage=${firstPageAt ? `${firstPageAt - startedAt}ms` : '-'} capped=${selection.overflow} ` +
          `truncated=${listings.truncated || deletions.truncated} cutMattered=${cutMattered} limited=${limited} ` +
          `received=${received} kept=${events.size} verified=${selection.checked} products=${result.products.length} incomplete=${result.incomplete} ` +
          `authors=${scope instanceof Set ? scope.size : 'any'} relays=${listings.answered.length}/${urls.length} ` +
          `jsMaxStall=${stall.maxMs}ms jsBlocked=${stall.blockedMs}ms`,
      );
    }
    return result;
  } finally {
    scheduler.dispose();
  }
}

/**
 * Carried-over listings that this round's authenticated deletions (or their
 * own expiry) now remove — the same reducer rules as the feed.
 */
function carriedWithdrawals(
  carried: readonly Event[],
  events: readonly Event[],
  scope: AuthorScope,
): string[] {
  if (carried.length === 0) return [];
  const deletions = events.filter((event) => event.kind === 5);
  const kept = new Set(reduceMarketListings([...carried, ...deletions], scope).map((p) => p.id));
  return carried.flatMap((event) => {
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    if (!d) return [];
    try {
      const id = marketListingProductId(event.kind, event.pubkey, d);
      return !kept.has(id) ? [id] : [];
    } catch {
      // Malformed identifiers cannot name a renderable listing.
      return [];
    }
  });
}

/**
 * Re-fetch ONE listing (pull-to-refresh on its product page, #1301): the
 * newest revision of `current`'s address plus its author's kind-5s, reduced
 * by the same rules as the feed. Resolves null when the listing is gone
 * (deleted, sold, expired) and rejects only when every relay failed.
 *
 * Every fetched event's signature is checked here rather than trusting the
 * pool's verifier: a forged "newer revision" (another price or shop URL) or
 * a forged deletion must never reach the page. Events the pool already
 * verified are memoised by nostr-tools, so this costs nothing extra then.
 */
export async function fetchListingRevision(
  current: Event,
  relays: string[],
  signal: AbortSignal,
  maxWait = 3000,
): Promise<MarketProduct | null> {
  const d = current.tags.find((t) => t[0] === 'd')?.[1];
  if (!d || relays.length === 0) return null;
  trackRelays(relays);
  const opts = { maxWait, signal };
  const revisions = await querySyncAbortable(
    pool,
    relays,
    { kinds: [current.kind], authors: [current.pubkey], '#d': [d], limit: 10 },
    { ...opts, rejectOnAllRelaysFailure: true },
  );
  // `#d` / `authors` are only relay-side requests — keep signed revisions of
  // THIS address only (reduceMarketListings re-checks the author too).
  const sameAddress = revisions.filter(
    (e) =>
      e.kind === current.kind &&
      e.pubkey === current.pubkey &&
      e.tags.find((t) => t[0] === 'd')?.[1] === d &&
      hasValidSignature(e),
  );
  // Then the seller's kind-5s naming the address or ANY of the revisions
  // (one deleted by `e` id only must still withdraw). Best-effort, like the
  // feed: a failed lookup just applies no deletion.
  const known = [current, ...sameAddress];
  const deletions = await Promise.all(
    [...deletionFilters('a', addressRefs([current])), ...deletionFilters('e', idRefs(known))].map(
      (filter) => querySyncAbortable(pool, relays, filter, opts),
    ),
  ).then(
    (batches) => batches.flat(),
    () => [] as Event[],
  );
  const [product] = reduceMarketListings(
    [current, ...sameAddress, ...deletions.filter(hasValidSignature)],
    new Set([current.pubkey]),
  );
  return product ?? null;
}
