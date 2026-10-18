import { enabledAppRelays } from './appRelayPrefs';
import { buildCacheListing } from './nostrPlacesService';
import { GC_RELAYS } from './geocacheRelays';
import { publishCacheEvent, type SignedEventLike } from './nostrPlacesPublisher';
import { savePiggy, type HiddenPiggy } from './piggyStorageService';

// Default lifetime stamped onto a republished listing when the
// original window can't be recovered (pre-#21 Piggies, or the
// "Never" picker option set expiresAt to undefined). One year
// matches the wizard's default for a fresh hide.
const DEFAULT_WINDOW_SECONDS = 365 * 24 * 60 * 60;

/**
 * Decide the new NIP-40 expiration timestamp for a republished Piggy.
 *
 * Strategy: preserve the original window length when discoverable
 * (createdAt → expiresAt delta) so a hider who picked 30 days the
 * first time gets another 30 days; otherwise fall back to one year.
 * The result is always anchored to `nowSec`, never to the stale
 * `createdAt`, so an Expired badge that prompted this republish
 * actually clears.
 *
 * Pure function — no side effects — so the contract is easy to
 * unit-test independently of the publish pipeline.
 */
export const computeNextExpiresAt = (piggy: HiddenPiggy, nowSec: number): number => {
  // HiddenPiggy.createdAt is in milliseconds (Date.now()); expiresAt is
  // in unix-seconds (NIP-40 contract). Normalise both to seconds before
  // computing the window — otherwise the subtraction silently produces
  // a near-billion-second negative and we always fall back to 1 year.
  const createdAtSec = Math.floor(piggy.createdAt / 1000);
  if (typeof piggy.expiresAt === 'number' && piggy.expiresAt > createdAtSec) {
    const window = piggy.expiresAt - createdAtSec;
    return nowSec + window;
  }
  return nowSec + DEFAULT_WINDOW_SECONDS;
};

export interface RepublishResult {
  piggy: HiddenPiggy;
  newExpiresAt: number;
}

/**
 * Re-emit the kind 37516 listing for an existing HiddenPiggy with a
 * refreshed NIP-40 expiration tag. Local state is updated first so a
 * mid-publish crash still leaves the on-device record consistent;
 * the relays then receive a replacement event under the same `d`
 * tag (NIP-33 addressable replacement) and finders see the longer
 * shelf life next time their client refreshes.
 *
 * The LNURL bearer NEVER goes on the published event — same
 * security invariant as the initial publish in `HuntCreateScreen`.
 * `buildCacheListing` is the single chokepoint that enforces it; a
 * unit test in `nostrPlacesService.test.ts` asserts the absence.
 */
export const republishPiggy = async (
  piggy: HiddenPiggy,
  signEvent: (template: {
    kind: number;
    created_at: number;
    tags: string[][];
    content: string;
  }) => Promise<SignedEventLike | null>,
  writeRelays?: string[],
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<RepublishResult> => {
  const newExpiresAt = computeNextExpiresAt(piggy, nowSec);
  const refreshed: HiddenPiggy = { ...piggy, expiresAt: newExpiresAt };
  await savePiggy(refreshed);
  const unsigned = buildCacheListing(refreshed);
  const signed = await signEvent(unsigned);
  if (!signed) {
    throw new Error('No signature from your signer — Piggy not republished.');
  }
  // GC_RELAYS is the geo-cache fallback (publishCacheEvent unions it in
  // regardless, but passing it here keeps the no-user-relays path explicit
  // and off the generic defaults that silently drop kind-37516). See #907.
  const relays =
    writeRelays && writeRelays.length > 0 ? writeRelays : enabledAppRelays('geocache', GC_RELAYS);
  await publishCacheEvent(signed, relays);
  return { piggy: refreshed, newExpiresAt };
};
