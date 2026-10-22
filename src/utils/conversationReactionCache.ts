import { isOptimisticReactionId, type ReactionRecord } from './reactions';

export interface ConversationReactionSnapshot {
  records: ReactionRecord[];
  retractions: Map<string, Set<string>>;
}

// Warm opens must not wait for relay EOSE / another MLS history read. Account
// and protocol/group are part of the caller's key. Bound both retained threads
// and events; pending local publishes are never resurrected by reopening.
interface CachedSnapshot extends ConversationReactionSnapshot {
  verifiedRetractions: Map<string, Set<string>>;
}
const snapshots = new Map<string, CachedSnapshot>();
const MAX_THREADS = 30;
const MAX_EVENTS = 2000;
let generation = 0;

export function reactionCacheGeneration(): number {
  return generation;
}

export function clearConversationReactions(): void {
  generation++;
  snapshots.clear();
}

export function isReactionCacheGenerationCurrent(token: number): boolean {
  return token === generation;
}

// Bound pairs, not just IDs. Keep verified author tombstones ahead of unknown
// authors so forged deletion floods cannot displace a known reactor's deletion.
function boundedRetractions(snapshot: ConversationReactionSnapshot, previous?: CachedSnapshot) {
  const verifiedRetractions = new Map<string, Set<string>>();
  const retained = new Map<string, Set<string>>();
  let pairs = 0;
  const add = (id: string, author: string) => {
    if (pairs >= MAX_EVENTS || retained.get(id)?.has(author)) return;
    const authors = retained.get(id) ?? new Set<string>();
    authors.add(author);
    retained.set(id, authors);
    pairs++;
  };
  const verify = (id: string, author: string) => {
    add(id, author);
    if (!retained.get(id)?.has(author)) return;
    const authors = verifiedRetractions.get(id) ?? new Set<string>();
    authors.add(author);
    verifiedRetractions.set(id, authors);
  };
  // A deleted record leaves the list; keep its verified tombstone prioritized
  // on subsequent writes, even when the list no longer contains that reactor.
  for (const [id, authors] of previous?.verifiedRetractions ?? []) {
    for (const author of authors) {
      if (snapshot.retractions.get(id)?.has(author)) verify(id, author);
    }
  }
  for (const record of snapshot.records.slice(-MAX_EVENTS)) {
    const id = record.id.toLowerCase();
    if (snapshot.retractions.get(id)?.has(record.reactorPubkey)) verify(id, record.reactorPubkey);
  }
  for (const [id, authors] of [...snapshot.retractions].reverse()) {
    for (const author of authors) {
      if (pairs >= MAX_EVENTS) break;
      add(id, author);
    }
    if (pairs >= MAX_EVENTS) break;
  }
  return { retractions: retained, verifiedRetractions };
}

export function readConversationReactions(key: string | null): ConversationReactionSnapshot {
  return (key && snapshots.get(key)) || { records: [], retractions: new Map() };
}

/** Drop one reaction from a cached thread: it definitely never went out (#1656). */
export function dropCachedReaction(key: string, id: string): void {
  const snapshot = snapshots.get(key);
  if (snapshot) snapshot.records = snapshot.records.filter((r) => r.id !== id);
}

export function cacheConversationReactions(
  key: string | null,
  snapshot: ConversationReactionSnapshot,
  token: number,
) {
  if (!key || !isReactionCacheGenerationCurrent(token)) return;
  const bounded = boundedRetractions(snapshot, snapshots.get(key));
  snapshots.delete(key);
  snapshots.set(key, {
    records: snapshot.records
      .filter(
        (r) =>
          !isOptimisticReactionId(r.id) &&
          !snapshot.retractions.get(r.id.toLowerCase())?.has(r.reactorPubkey),
      )
      .slice(-MAX_EVENTS),
    ...bounded,
  });
  while (snapshots.size > MAX_THREADS) snapshots.delete(snapshots.keys().next().value!);
}
