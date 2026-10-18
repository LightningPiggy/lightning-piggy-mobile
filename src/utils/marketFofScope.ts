// Author set for the Market's friends-of-friends seller scope. Pure so the
// ordering and cap are unit-testable.

/**
 * Ceiling on the scope's authors — the listings service queries at most this
 * many (`MAX_AUTHORS` in marketListingsService), in 64-author batches. Also
 * the ranked cap the shared FoF service builds the set with, so the
 * most-shared follows-of-follows are the ones that make the cut.
 */
export const MARKET_FOF_MAX = 1024;

/**
 * Follows first (they are the scope's core and must never be cut), then the
 * friends-of-friends in the service's rank order (most-shared first),
 * de-duplicated, lowercased and capped at MARKET_FOF_MAX.
 */
export function marketFofAuthors(
  friends: readonly string[],
  fof: readonly string[],
  max: number = MARKET_FOF_MAX,
): string[] {
  const out = new Set<string>();
  for (const pk of [...friends, ...fof]) {
    if (out.size >= max) break;
    out.add(pk.toLowerCase());
  }
  return [...out];
}
