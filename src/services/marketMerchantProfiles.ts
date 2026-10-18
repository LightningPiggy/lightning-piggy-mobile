import { nip19 } from 'nostr-tools';
import { pool, trackRelays } from './nostrPool';
import { PROFILE_RELAYS } from './nostrRelayDefaults';
import { querySyncAbortable } from './relayQuery';
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
        const events = await querySyncAbortable(
          pool,
          PROFILE_RELAYS,
          { kinds: [0], authors: chunk, limit: chunk.length * 2 },
          { signal, maxWait: 8000, rejectOnAllRelaysFailure: true, rejectOnTimeout: true },
        );
        const wanted = new Set(chunk);
        const best = new Map<string, (typeof events)[number]>();
        for (const event of events) {
          if (event.kind !== 0 || !wanted.has(event.pubkey) || event.content.length > 32768)
            continue;
          const previous = best.get(event.pubkey);
          if (!previous || event.created_at > previous.created_at) best.set(event.pubkey, event);
        }
        return best;
      }),
    );
    for (const [index, result] of results.entries()) {
      if (result.status !== 'fulfilled') {
        for (const author of batches[i + index]) unresolved.add(author);
        continue;
      }
      for (const [pubkey, event] of result.value) {
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
