// Who a DM may be delivered to at THEIR OWN inbox / read relays (#1749).
//
// Outbox delivery (#1570 / #1747) also publishes each wrap to the relays its
// recipient reads from. Whoever runs those relays sees the sender's IP and
// send timing, so that extra hop is only taken for people the user trusts:
//   - the user's own copy (their own inbox);
//   - anyone the user directly chose to message in this send (the recipient
//     of a 1:1, the seller of a Gamma order): messaging someone deliberately
//     is consent to reach them where they read;
//   - anyone the account's Web of Trust tier admits, the same rule message
//     notifications use (#1765):
//       'friends' → follows + people the user has replied to;
//       'fof'     → also the cached friends-of-friends set;
//       'all'     → everyone.
//     Only an explicit pick counts (#1765's `explicit` marker); a tier never
//     chosen — the #627 'all' default, or one the Groups migration / chip
//     stored — counts as 'friends'.
// Everyone else gets the usual set only (write relays ∪ defaults).
//
// Readable outside React: follows come from the session's follow gate once
// hydrated, else the per-account contacts cache; the tier and the
// friends-of-friends cache from per-account storage. A storage failure fails
// private (nobody beyond the user and the chosen recipients).
//
// #1765's `notificationAudience` reads the same tier + cached L2; it can switch
// to `loadPeerDeliveryTrust` once both have landed.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { CONTACTS_CACHE_KEY_BASE } from '../contexts/nostrCacheKeys';
import { buildFollowSet } from '../utils/followPubkeys';
import { peekAccountSetting } from './accountSettingsCache';
import { hasRepliedTo, loadRepliedPartners } from './dmRepliedPartners';
import { peekFollowSet } from './followSetEvents';
import { FOF_SHARED_MAX, loadFofCache } from './friendsOfFriendsService';
import { perAccountKey } from './perAccountStorage';
import { ensureSafetySettingsMigrated } from './safetySettingsMigration';
import { parseChosenWotTier, WOT_STORAGE_KEY_BASE, type WotTier } from './wotSettingsService';

export interface PeerDeliveryTrust {
  owner: string;
  tier: WotTier;
  /** Lowercase-hex follows. */
  follows: ReadonlySet<string>;
  /** Lowercase-hex friends-of-friends set, 'fof' only. null = not cached. */
  fof: ReadonlySet<string> | null;
}

/** The explicitly chosen tier; anything else → 'friends'. Throws on storage errors. */
async function readTier(owner: string): Promise<WotTier> {
  await ensureSafetySettingsMigrated(owner);
  const known = peekAccountSetting(WOT_STORAGE_KEY_BASE, owner);
  const raw =
    known !== undefined
      ? known
      : await AsyncStorage.getItem(perAccountKey(WOT_STORAGE_KEY_BASE, owner));
  return parseChosenWotTier(raw) ?? 'friends';
}

// The last parsed contacts cache per account, keyed by its raw string, so a
// send (prefetch + delivery) doesn't parse the same JSON twice. Bounded by the
// accounts on the device; a changed cache is re-parsed.
const parsedContacts = new Map<string, { raw: string; follows: ReadonlySet<string> }>();

/** Follows from the live gate, else the contacts cache (none cached → empty). Throws on storage errors. */
async function readFollows(owner: string): Promise<ReadonlySet<string>> {
  const live = peekFollowSet(owner);
  if (live) return live;
  const raw = await AsyncStorage.getItem(perAccountKey(CONTACTS_CACHE_KEY_BASE, owner));
  if (!raw) return new Set();
  const memo = parsedContacts.get(owner);
  if (memo?.raw === raw) return memo.follows;
  const parsed: unknown = JSON.parse(raw);
  const follows = Array.isArray(parsed)
    ? buildFollowSet(
        parsed
          .map((c) => (c as { pubkey?: unknown })?.pubkey)
          .filter((pk): pk is string => typeof pk === 'string'),
      )
    : new Set<string>();
  parsedContacts.set(owner, { raw, follows });
  return follows;
}

/** Test hook. */
export function __resetPeerDeliveryTrustForTests(): void {
  parsedContacts.clear();
}

/**
 * The account's delivery trust, or null when it can't be read (fail private:
 * nobody beyond the user and the chosen recipients). Never rejects.
 */
export async function loadPeerDeliveryTrust(
  ownerPubkey: string,
): Promise<PeerDeliveryTrust | null> {
  const owner = ownerPubkey.toLowerCase();
  try {
    const [tier, follows] = await Promise.all([
      readTier(owner),
      readFollows(owner),
      loadRepliedPartners(owner),
    ]);
    if (tier !== 'fof' || follows.size === 0) return { owner, tier, follows, fof: null };
    // The last good set, even past its 24 h refresh, like the Messages list.
    const cached = await loadFofCache(owner, [...follows], FOF_SHARED_MAX, { allowStale: true });
    return { owner, tier, follows, fof: cached?.set ?? null };
  } catch {
    return null;
  }
}

/** Whether the tier admits `pubkey` (lowercase hex). No trust admits nobody. Pure. */
export function trustAdmits(trust: PeerDeliveryTrust | null, pubkey: string): boolean {
  if (!trust) return false;
  if (trust.tier === 'all') return true;
  if (trust.follows.has(pubkey) || hasRepliedTo(trust.owner, pubkey)) return true;
  return trust.tier === 'fof' && !!trust.fof?.has(pubkey);
}

/**
 * The subset of `recipients` that may be reached at their own relays, in
 * order: the sender's own copy, the chosen recipients, and whoever the tier
 * admits. Only loads the trust state when someone is left to decide. Never
 * rejects.
 */
export async function trustedPeerRecipients(
  senderPubkey: string,
  recipients: readonly string[],
  chosenRecipients: readonly string[] = [],
): Promise<string[]> {
  const sender = senderPubkey.toLowerCase();
  const chosen = new Set(chosenRecipients.map((pk) => pk.toLowerCase()));
  const consented = (pk: string) => pk === sender || chosen.has(pk);
  const undecided = recipients.filter((pk) => !consented(pk.toLowerCase()));
  const trust = undecided.length > 0 ? await loadPeerDeliveryTrust(sender) : null;
  return recipients.filter((pk) => {
    const key = pk.toLowerCase();
    return consented(key) || trustAdmits(trust, key);
  });
}
