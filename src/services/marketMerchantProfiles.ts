import { nip19 } from 'nostr-tools';
import { pool, trackRelays } from './nostrPool';
import { PROFILE_RELAYS } from './nostrRelayDefaults';
import { querySyncAbortable } from './relayQuery';
import { activeAccountRelays } from './testRelayRouting';
import * as cache from './zapSenderProfileStorage';
import { parseProfileContent } from '../utils/profileContent';

/** One cached, bounded kind-0 pass for ALL loaded merchants. No per-author requests
 * or event-driven state updates; at most three 50-author chunks run at once. */
export async function fetchMarketMerchantProfiles(
  pubkeys: string[],
  signal: AbortSignal,
  onUnresolved?: (authors: ReadonlySet<string>) => void,
) {
  const authors = [...new Set(pubkeys)].filter((pk) => /^[a-f0-9]{64}$/.test(pk));
  const profiles = await cache.getMany(authors);
  const missing = authors.filter((pk) => {
    const hit = profiles.get(pk);
    return (
      !hit ||
      ![hit.name, hit.displayName, hit.nip05].some(
        (value) => typeof value === 'string' && value.trim(),
      )
    );
  });
  const batches: string[][] = [];
  for (let i = 0; i < missing.length; i += 50) batches.push(missing.slice(i, i + 50));
  if (missing.length && !signal.aborted) trackRelays(PROFILE_RELAYS);
  const unresolved = new Set<string>();
  const fetched = new Map<string, cache.CachedZapSenderProfile>();
  for (let i = 0; i < batches.length && !signal.aborted; i += 3) {
    const results = await Promise.allSettled(
      batches.slice(i, i + 3).map(async (chunk) => {
        // Per relay: one slow relay must not discard what the others already
        // returned (a whole-query timeout used to mark every seller in the
        // chunk unresolved, which the All scope's rule 3 then hides). Rejects
        // only when no relay completed.
        const completed = new Set<string>();
        const events = await querySyncAbortable(
          pool,
          PROFILE_RELAYS,
          { kinds: [0], authors: chunk, limit: chunk.length * 2 },
          { signal, maxWait: 8000, completedRelays: completed },
        );
        const wanted = new Set(chunk);
        const best = new Map<string, (typeof events)[number]>();
        for (const event of events) {
          if (event.kind !== 0 || !wanted.has(event.pubkey) || event.content.length > 32768)
            continue;
          const previous = best.get(event.pubkey);
          if (!previous || event.created_at > previous.created_at) best.set(event.pubkey, event);
        }
        // A seller missing from the relays that answered may still be on one
        // that didn't: unresolved, not "no profile".
        const partial = completed.size < new Set(activeAccountRelays(PROFILE_RELAYS)).size;
        const missingHere = partial ? chunk.filter((pk) => !best.has(pk)) : [];
        return { best, missingHere };
      }),
    );
    for (const [index, result] of results.entries()) {
      if (result.status !== 'fulfilled') {
        for (const author of batches[i + index]) unresolved.add(author);
        continue;
      }
      for (const author of result.value.missingHere) unresolved.add(author);
      for (const [pubkey, event] of result.value.best) {
        const p = parseProfileContent(event.content);
        // Display-only metadata: never cache unverified payment fields.
        fetched.set(pubkey, {
          npub: nip19.npubEncode(pubkey),
          name: p.name,
          displayName: p.displayName,
          nip05: p.nip05,
          picture: p.picture,
        });
      }
    }
  }
  if (!signal.aborted) await cache.setMany(fetched);
  onUnresolved?.(unresolved);
  return new Map([...profiles, ...fetched]);
}
