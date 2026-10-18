import type { NostrContact, NostrProfile } from '../types/nostr';

// Context replaces the contacts array on each coalesced profile batch. Share
// its index across rows so rendering a thread never scans all friends per row.
const indexes = new WeakMap<readonly NostrContact[], Map<string, NostrProfile>>();
export function cachedContactProfile(
  contacts: readonly NostrContact[] | undefined,
  pubkey: string,
): NostrProfile | null {
  if (!contacts) return null;
  let index = indexes.get(contacts);
  if (!index) {
    index = new Map();
    for (const contact of contacts) {
      if (contact.profile) index.set(contact.pubkey.toLowerCase(), contact.profile);
    }
    indexes.set(contacts, index);
  }
  return index.get(pubkey.toLowerCase()) ?? null;
}
