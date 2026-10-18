import { enabledAppRelays } from './appRelayPrefs';
import { GC_LISTING_KIND, buildCacheListing } from './nostrPlacesService';
import { GC_RELAYS } from './geocacheRelays';
import { publishCacheEvent, type SignedEventLike } from './nostrPlacesPublisher';
import type { HiddenPiggy } from './piggyStorageService';

/**
 * "Delete a Piglet" — the belt-and-suspenders removal of an owned
 * kind-37516 listing (#777):
 *
 *   1. (belt) Republish the listing with its NIP-40 `expiration` tag
 *      pinned to now, so the app's own client-side expiry filter
 *      (`HuntScreen` / `MapScreen` drop `expiresAt <= now`) hides it
 *      everywhere immediately — even on relays that ignore NIP-09.
 *   2. (suspenders) THEN send a NIP-09 kind-5 deletion request so
 *      compliant relays purge the event outright.
 *
 * Strictly ordered: expire first, delete second. The pure builders are
 * exported (and unit-tested) independently of the publish pipeline; the
 * `deletePiggy` orchestrator wires them to the signer + relay layer.
 *
 * Only the owner (the local signer) can do this — the caller gates on
 * `author == pubkey` before invoking. Orphaned dev events we no longer
 * hold a key for go through `devEventDenylist.ts` instead.
 */

/** NIP-09 deletion-request event kind. */
export const NIP09_DELETION_KIND = 5;

/** Unsigned Nostr event template — the shape `signEvent` consumes. */
export interface UnsignedEventTemplate {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

type SignEvent = (template: UnsignedEventTemplate) => Promise<SignedEventLike | null>;

/**
 * Pure — step 1's payload. Rebuild the kind-37516 listing for a Piglet
 * with its NIP-40 `expiration` pinned to `nowSec`, re-emitted under the
 * same `d` tag (NIP-33 addressable replacement). Once relays hold this
 * replacement, the app's `expiresAt <= now` filter drops the Piglet
 * from every surface regardless of whether the relay honours NIP-09.
 *
 * `created_at` is also pinned to `nowSec` (overriding `buildCacheListing`'s
 * internal `Date.now()` stamp) so it never drifts a second past the kind-5
 * deletion — which stamps `nowSec` too. If the listing ended up *newer*
 * than the deletion, NIP-09 relays that ignore a deletion older than its
 * target could leave the replacement standing. Equal timestamps keep the
 * deletion's `created_at <= target` covering the replacement we just made.
 *
 * The LNURL bearer never reaches the wire — `buildCacheListing` is the
 * single chokepoint that enforces that invariant (asserted in
 * `nostrPlacesService.test.ts`).
 */
export const buildExpireNowListing = (
  piggy: HiddenPiggy,
  nowSec: number,
): UnsignedEventTemplate => ({
  ...buildCacheListing({ ...piggy, expiresAt: nowSec }),
  created_at: nowSec,
});

/**
 * Pure — step 2's payload. Build the NIP-09 kind-5 deletion request for
 * one or more addressable coords (`<kind>:<pubkey>:<d>`).
 *
 * Kind 37516 is a parameterized-replaceable event, so NIP-09 references
 * it by an `a` tag (the addressable coord) plus a `k` kind hint — NOT
 * an `e` event-id tag: a replaceable event has no single immutable id,
 * and an `a`-tag deletion tells the relay to drop every revision under
 * that coord.
 */
export const buildDeletionRequest = (
  coords: string[],
  nowSec: number,
  reason = '',
): UnsignedEventTemplate => {
  const tags: string[][] = coords.map((coord) => ['a', coord]);
  tags.push(['k', String(GC_LISTING_KIND)]);
  return { kind: NIP09_DELETION_KIND, created_at: nowSec, tags, content: reason };
};

export interface DeletePiggyParams {
  /** Addressable coord of the listing to delete (`37516:<pubkey>:<d>`). */
  coord: string;
  /**
   * Local record for the listing, when held on this device. Needed to
   * rebuild the kind-37516 for the expire-now republish (step 1). When
   * absent (e.g. a listing published from another device) step 1 is
   * skipped and only the kind-5 deletion request (step 2) is sent —
   * the deletion alone still works because it only needs the coord and
   * the owner's signature.
   */
  piggy?: HiddenPiggy;
  signEvent: SignEvent;
  /** The user's write relays; falls back to `GC_RELAYS` when empty. */
  writeRelays?: string[];
  nowSec?: number;
}

export interface DeletePiggyResult {
  /** True when the expire-now republish (step 1) was signed + published. */
  expired: boolean;
  /** True when the kind-5 deletion request (step 2) was signed + published. */
  deletionRequested: boolean;
}

/**
 * Delete an owned Piglet: expire-now republish (belt) THEN kind-5
 * deletion request (suspenders), strictly in that order. Throws if the
 * signer returns no signature for either step (declined, no response or
 * busy — `signEvent` doesn't say which, so the copy doesn't guess) so the
 * caller can surface a failure toast and leave the row in place.
 */
export const deletePiggy = async ({
  coord,
  piggy,
  signEvent,
  writeRelays,
  nowSec = Math.floor(Date.now() / 1000),
}: DeletePiggyParams): Promise<DeletePiggyResult> => {
  // GC_RELAYS is the geo-cache backbone; publishCacheEvent unions it in
  // regardless, but passing it explicitly keeps the no-user-relays path
  // off the generic defaults that silently drop kind-37516. See #907.
  const relays =
    writeRelays && writeRelays.length > 0 ? writeRelays : enabledAppRelays('geocache', GC_RELAYS);

  // Step 1 (belt) — expire-now republish. Only possible when we hold the
  // local record (buildCacheListing needs the piggy's lat/lon etc).
  let expired = false;
  if (piggy) {
    const signedListing = await signEvent(buildExpireNowListing(piggy, nowSec));
    if (!signedListing) {
      throw new Error('No signature from your signer — Piglet not deleted.');
    }
    await publishCacheEvent(signedListing, relays);
    expired = true;
  }

  // Step 2 (suspenders) — NIP-09 kind-5 deletion request. Published to
  // the same relay set so compliant relays purge the listing they hold.
  const signedDeletion = await signEvent(buildDeletionRequest([coord], nowSec));
  if (!signedDeletion) {
    throw new Error('No signature from your signer — deletion request not sent.');
  }
  await publishCacheEvent(signedDeletion, relays);

  return { expired, deletionRequested: true };
};
