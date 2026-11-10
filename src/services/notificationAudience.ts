// Who may raise a message notification: the account's Web of Trust tier —
// as explicitly CHOSEN. An unchosen tier (the #627 'all' default, or one the
// legacy migration derived) notifies like Friends; see `notificationTierFor`.
//
// The follow gate (the live DM sub, the background watch) decides what is
// STORED in Messages, and passes follows and people we've replied to. This
// module only widens who may NOTIFY beyond them, following the same tier as
// the Web of Trust sheet:
//   - 'friends': nobody extra (follows only, as before);
//   - 'fof':     the cached friends-of-friends set. Not built or not cached
//                yet → nobody extra, never "everyone";
//   - 'all':     any sender.
// Muted senders never alert under any tier: `fireMessageNotification` drops
// them centrally.
//
// Two sources, one shape:
//   - in the app, TrustGraphProvider publishes the live tier + set per account
//     (`publishNotificationAudience`), so a tier change applies at once;
//   - with no React tree (the headless background watch), the tier and the
//     friends-of-friends cache are read from per-account storage.
// Lookups are one `Set.has` per message; the set is built once per tier/set
// change (or per watch arm), never per event.

import { FOF_SHARED_MAX, loadFofCache } from './friendsOfFriendsService';
import { readStoredNotificationTier, type WotTier } from './wotSettingsService';

export interface NotificationAudience {
  tier: WotTier;
  /** Lowercase-hex friends-of-friends set, 'fof' only. null = not built yet. */
  fof: ReadonlySet<string> | null;
}

/**
 * True when the tier lets `pubkey` notify although the follow gate kept their
 * message out. No audience (unknown / failed read) admits nobody extra.
 */
export function audienceAdmits(
  audience: NotificationAudience | null | undefined,
  pubkey: string,
): boolean {
  if (!audience) return false;
  if (audience.tier === 'all') return true;
  if (audience.tier === 'fof') return !!audience.fof?.has(pubkey.toLowerCase());
  return false;
}

// The in-app audience, per account (a shared family phone keeps each person's
// own tier). Bounded by the accounts signed in on the device.
const live = new Map<string, NotificationAudience>();

/** TrustGraphProvider: the account's current tier and friends-of-friends set. */
export function publishNotificationAudience(owner: string, audience: NotificationAudience): void {
  live.set(owner.toLowerCase(), audience);
  for (const listener of listeners) listener(owner.toLowerCase(), audience);
}

/** True while the audience can't answer yet: not published, or a
 * friends-of-friends set that hasn't loaded. */
export function audiencePending(audience: NotificationAudience | null | undefined): boolean {
  return !audience || (audience.tier === 'fof' && !audience.fof);
}

type AudienceListener = (owner: string, audience: NotificationAudience) => void;
const listeners = new Set<AudienceListener>();

/** Called on every publish (the tier or its friends-of-friends set changed). */
export function onNotificationAudience(listener: AudienceListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tier unknown again (account switched away / signed out): admit nobody extra. */
export function unpublishNotificationAudience(owner: string): void {
  live.delete(owner.toLowerCase());
}

/** The in-app audience for `owner`, or null when the app hasn't published one. */
export function liveNotificationAudience(owner: string | null): NotificationAudience | null {
  return owner ? (live.get(owner.toLowerCase()) ?? null) : null;
}

/**
 * The audience from storage, for a reader with no React tree. `follows` is the
 * cached follow list: with no friends there are no friends of friends. A
 * failed tier read returns null (follows only).
 */
export async function loadNotificationAudience(
  owner: string,
  follows: ReadonlySet<string> | null,
): Promise<NotificationAudience | null> {
  const tier = await readStoredNotificationTier(owner);
  if (!tier) return null;
  if (tier !== 'fof' || !follows || follows.size === 0) return { tier, fof: null };
  // The last good set, even past its 24 h refresh — the Messages list shows
  // the same one while the app rebuilds it.
  const cached = await loadFofCache(owner, [...follows], FOF_SHARED_MAX, { allowStale: true });
  return { tier, fof: cached?.set ?? null };
}

/** Test hook. */
export function __resetNotificationAudiences(): void {
  live.clear();
}
