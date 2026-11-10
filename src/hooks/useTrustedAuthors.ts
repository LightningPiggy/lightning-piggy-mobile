import { useMemo } from 'react';

// The trust set minus the signed-in user, as a sorted pubkey list whose
// identity only changes when its CONTENT changes (#1789).
//
// TrustGraphContext rebuilds `trustSet` whenever contacts or the
// friends-of-friends set are recomputed, which often yields a new Set with
// the same members. My Piglets keys its "Friends' finds" subscription on this
// list, and that REQ can carry up to 2,000 authors, so re-sending it for an
// identical set is pure waste. Keying on a joined string keeps the array
// stable across those no-op rebuilds.
export function useTrustedAuthors(
  trustSet: ReadonlySet<string>,
  pubkey: string | null | undefined,
): string[] {
  const key = useMemo(() => {
    if (!pubkey) return '';
    const self = pubkey.toLowerCase();
    return Array.from(trustSet)
      .filter((p) => p.toLowerCase() !== self)
      .sort()
      .join(',');
  }, [trustSet, pubkey]);
  return useMemo(() => (key ? key.split(',') : []), [key]);
}
