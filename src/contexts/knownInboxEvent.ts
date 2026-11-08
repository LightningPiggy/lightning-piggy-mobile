import { capKnownWrapIds } from './knownWrapIdsCap';

/**
 * The live sub's in-memory id state for one account (`knownWrapIdsRef`).
 *
 * - `set` (`knownWrapIds`): every id the live sub has CLAIMED — stored rows,
 *   but also wraps it dropped without storing (follow gate, a stranger's
 *   wrap, an undecryptable one) and wraps still in flight. Right for the live
 *   sub's own redelivery dedupe, wrong for a fetch.
 * - `persisted`: only ids actually written to a store — the DB seed
 *   (DM wrap ids + persisted group wraps) plus ids added after a successful
 *   upsert. Absent until the live sub arms (logout resets the whole state).
 */
export type KnownWrapIdsState = {
  pubkey: string | null;
  set: Set<string>;
  persisted?: Set<string>;
};

type KnownWrapIdsRef = { current: KnownWrapIdsState };

/** The persisted-id set for the ref's current account, created on first use. */
export function persistedInboxIds(ref: KnownWrapIdsRef): Set<string> {
  return (ref.current.persisted ??= new Set());
}

/** Record ids that are now in a store (after the write succeeded). */
export function notePersistedInboxIds(persisted: Set<string>, ids: Iterable<string>): void {
  for (const id of ids) persisted.add(id);
  capKnownWrapIds(persisted);
}

/**
 * The inbox fetch's pre-parse skip (#1759): an id already written to a store
 * costs one Set lookup instead of parse + verify. Only PERSISTED ids count —
 * a wrap the follow gate dropped without storing must still reach ingest, so
 * following / replying to its sender later surfaces it on the next refresh.
 * Only the owner's set counts (an account switch swaps it).
 */
export function knownInboxEvent(ref: KnownWrapIdsRef, owner: string): (id: string) => boolean {
  return (id) => {
    const known = ref.current;
    return known.pubkey === owner && known.persisted?.has(id) === true;
  };
}
