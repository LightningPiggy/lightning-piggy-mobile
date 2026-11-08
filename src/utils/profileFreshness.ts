import type { NostrContact, NostrProfile } from '../types/nostr';

// Newest-wins for two copies of one person's profile, on the `created_at` of
// the kind-0 each came from (#1390). A copy that arrives late — e.g. from the
// background outbox fallback — must never replace a newer one already shown
// or cached.

/**
 * The copy to keep. `incoming` wins unless both copies are dated and it's
 * older (an undated copy can't prove it's stale, so the latest fetch wins as
 * before); a missing `incoming` keeps `existing`.
 */
export function newerProfile(
  existing: NostrProfile | null | undefined,
  incoming: NostrProfile | null | undefined,
): NostrProfile | null {
  if (!incoming) return existing ?? null;
  if (
    existing &&
    typeof existing.createdAt === 'number' &&
    typeof incoming.createdAt === 'number' &&
    incoming.createdAt < existing.createdAt
  ) {
    return existing;
  }
  return incoming;
}

/** Fold fetched profiles into contacts, newest-wins; untouched contacts keep their identity. */
export function mergeContactProfiles(
  contacts: NostrContact[],
  fetched: ReadonlyMap<string, NostrProfile>,
): NostrContact[] {
  return contacts.map((c) => {
    const profile = newerProfile(c.profile, fetched.get(c.pubkey));
    return profile === c.profile ? c : { ...c, profile };
  });
}
