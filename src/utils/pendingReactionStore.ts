// Reactions sent but not yet confirmed by a relay (#1656), per conversation
// owner. Shared rather than per-hook, so a chat reopened mid-confirmation
// still shows them as pending — and still learns if one turns out lost.
import { dropCachedReaction } from './conversationReactionCache';
import type { ReactionSettlement } from './reactions';

type Listener = (lost?: { owner: string; id: string }) => void;

const NONE: ReadonlySet<string> = new Set();
const byOwner = new Map<string, ReadonlySet<string>>();
// Lost ids stay known, so a later restore (a failed retraction) or a stale
// read can't merge one back as a ghost pill. Bounded per owner.
const lostByOwner = new Map<string, Set<string>>();
const MAX_LOST_PER_OWNER = 200;
const listeners = new Set<Listener>();

function rememberLost(owner: string, id: string): void {
  const lost = lostByOwner.get(owner) ?? new Set<string>();
  lost.add(id);
  if (lost.size > MAX_LOST_PER_OWNER) lost.delete(lost.values().next().value!);
  lostByOwner.set(owner, lost);
}

/** Whether `id` was a reaction that definitely never went out. */
export const isLostReaction = (owner: string | null, id: string): boolean =>
  !!owner && !!lostByOwner.get(owner)?.has(id);

// Copy-on-write, so each owner's set is a stable snapshot between changes.
function update(owner: string, change: (ids: Set<string>) => void): void {
  const next = new Set(byOwner.get(owner));
  change(next);
  if (next.size > 0) byOwner.set(owner, next);
  else byOwner.delete(owner);
}

/** Show `id` as pending until `settled` resolves; a lost reaction leaves the
 * thread's warm cache too, so reopening the chat can't bring it back. */
export function trackPendingReaction(
  owner: string,
  id: string,
  settled: Promise<ReactionSettlement>,
): void {
  update(owner, (ids) => ids.add(id));
  listeners.forEach((l) => l());
  void settled.then((outcome) => {
    update(owner, (ids) => ids.delete(id));
    if (outcome === 'lost') {
      rememberLost(owner, id);
      dropCachedReaction(owner, id);
    }
    const lost = outcome === 'lost' ? { owner, id } : undefined;
    listeners.forEach((l) => l(lost));
  });
}

export const pendingReactionIds = (owner: string | null): ReadonlySet<string> =>
  (owner && byOwner.get(owner)) || NONE;

/** Called on every change; with `lost` when a tracked reaction was lost. */
export function subscribePendingReactions(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
