// In-memory snapshot of the active account's Marmot chats whose latest
// group state couldn't be saved on this device (#1754), published by its
// MarmotSession (marmotStateSaves) and read by the chat info screen through
// `useMarmotUnsavedState` (useSyncExternalStore). Tagged with the owning
// account so a previous account's chats never show under the next one.

export interface UnsavedStateSnapshot {
  owner: string | null;
  /** MLS group ids (hex). */
  chatIds: ReadonlySet<string>;
}

const EMPTY: UnsavedStateSnapshot = { owner: null, chatIds: new Set() };
let snapshot: UnsavedStateSnapshot = EMPTY;
const listeners = new Set<() => void>();

const sameIds = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id));

export function publishMarmotUnsavedState(owner: string, chatIds: Iterable<string>): void {
  const next = new Set(chatIds);
  // Unchanged → keep the same snapshot object, so nothing re-renders.
  if (snapshot.owner === owner && sameIds(snapshot.chatIds, next)) return;
  snapshot = { owner, chatIds: next };
  for (const l of listeners) l();
}

/** Drop `owner`'s snapshot (their session stopped). */
export function clearMarmotUnsavedState(owner: string): void {
  if (snapshot.owner !== owner) return;
  snapshot = EMPTY;
  for (const l of listeners) l();
}

export function getMarmotUnsavedStateSnapshot(): UnsavedStateSnapshot {
  return snapshot;
}

export function subscribeMarmotUnsavedState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
