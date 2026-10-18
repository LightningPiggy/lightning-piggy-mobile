import type { DmMessageRow } from './dmDb';

// Change notifications for the DM store (dmDb): who wants to hear about
// committed writes and deletes. Listener failures never fail the write.

/** Post-commit updates: consumers must not resolve wraps before their rows exist. */
type DmStorageListener = (owner: string, rows: readonly DmMessageRow[]) => void;
const dmStorageListeners = new Set<DmStorageListener>();
/** `rows` are the committed rows for `owner` (empty when not row-specific). */
export function subscribeDmStorage(listener: DmStorageListener): () => void {
  dmStorageListeners.add(listener);
  return () => {
    dmStorageListeners.delete(listener);
  };
}

/** Row deletions, kept apart from upserts so the inbox can drop removed
 * rows without re-rendering on every write. Fired after the deletes land. */
type DmDeletionListener = (owner: string, eventIds: readonly string[]) => void;
const dmDeletionListeners = new Set<DmDeletionListener>();
export function subscribeDmDeletions(listener: DmDeletionListener): () => void {
  dmDeletionListeners.add(listener);
  return () => {
    dmDeletionListeners.delete(listener);
  };
}

export function notifyDmDeletions(owner: string, eventIds: readonly string[]): void {
  for (const listener of dmDeletionListeners) {
    try {
      listener(owner, eventIds);
    } catch {
      // A consumer failure must not turn a committed delete into a failed one.
    }
  }
}

export function notifyDmStorage(rows: readonly DmMessageRow[]): void {
  for (const owner of new Set(rows.map((row) => row.owner))) {
    const ownerRows = rows.filter((row) => row.owner === owner);
    for (const listener of dmStorageListeners) {
      try {
        listener(owner, ownerRows);
      } catch {
        // A consumer failure must not turn a committed write into a failed one.
      }
    }
  }
}
