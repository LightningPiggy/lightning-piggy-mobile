import { isWrapInFlight } from '../services/dmWrapNotificationDedupe';

type KnownWrapIdsRef = { current: { pubkey: string | null; set: Set<string> } };

/**
 * The inbox fetch's pre-parse skip (#1759): ids in the live sub's
 * `knownWrapIds` (stored wraps + group wraps, and kind-4 ids once persisted)
 * cost one Set lookup instead of parse + verify. That keeps a kind-4 cursor
 * pinned by a partial read cheap to re-read.
 *
 * Wraps still IN FLIGHT are fetched as before: the live sub claimed them but
 * hasn't stored them, and a remote-signer unwrap failure leaves its claim in
 * the set for the session — the refresh must still be able to ingest those.
 * Only the owner's set counts (an account switch swaps it).
 */
export function knownInboxEvent(ref: KnownWrapIdsRef, owner: string): (id: string) => boolean {
  return (id) => {
    const known = ref.current;
    return known.pubkey === owner && known.set.has(id) && !isWrapInFlight(id);
  };
}
