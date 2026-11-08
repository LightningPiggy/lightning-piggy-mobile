/**
 * Strips payment-relevant fields from a profile fetched via the
 * unverified batch path (`fetchProfiles` → the `pool.verifyEvent` kind-0
 * fast-path in `services/nostrService`).
 *
 * A batch-fetched kind-0 event skips signature verification, so a
 * malicious relay could forge any field. A forged name/avatar is only
 * cosmetic, but a forged `lud16` (lightning address) would silently
 * redirect a zap to the attacker. The batch consumers — the zap-sender
 * resolver and the contacts list — are display-only and never pay
 * `lud16` directly; the screens that actually zap a contact re-fetch the
 * profile through the verified single `fetchProfile`. So the `lud16` value
 * is dropped here, but its *presence* is recorded in `hasLud16` so display
 * surfaces can show/grey the zap affordance correctly without exposing the
 * forgeable value (the real address is re-resolved + verified at zap time).
 *
 * `banner` and `about` are KEPT: both are purely cosmetic (a forged image
 * or bio carries no payment risk), and display surfaces do read them — the
 * quick-profile sheet renders the banner (#666/#18) and the bio should not
 * be empty just because a profile arrived via the batch path.
 */
import { npubEncode } from 'nostr-tools/nip19';
import type { NostrProfile } from '../types/nostr';
import { parseProfileContent } from './profileContent';

export function slimDisplayProfile(profile: NostrProfile): NostrProfile {
  // `|| profile.hasLud16 === true` keeps the function idempotent: re-slimming
  // an already-slim profile (lud16 already null) must not lose the recorded
  // presence.
  return { ...profile, lud16: null, hasLud16: profile.lud16 != null || profile.hasLud16 === true };
}

/**
 * A display profile from a batch-fetched kind-0 (see above), slimmed.
 * `verified`: the event passed a full signature check, so its `created_at`
 * may be trusted for newest-wins merging (utils/profileFreshness). An
 * UNVERIFIED event is never dated — a relay could otherwise forge a
 * far-future timestamp and pin a fake name or avatar past every legitimate
 * refresh — so it merges as the latest fetch, as before.
 */
export function displayProfile(
  event: { pubkey: string; content: string; created_at: number },
  verified = false,
): NostrProfile {
  return slimDisplayProfile({
    pubkey: event.pubkey,
    npub: npubEncode(event.pubkey),
    ...parseProfileContent(event.content),
    ...(verified ? { createdAt: event.created_at } : {}),
  });
}
