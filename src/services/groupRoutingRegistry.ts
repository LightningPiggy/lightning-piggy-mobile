import type { Group } from '../types/groups';

/**
 * Module-level registry of locally-known groups, keyed by groupId.
 * GroupsContext keeps this in sync via `setKnownGroups` whenever its
 * groups state changes. NostrContext consults `findGroupForParticipants`
 * inside its NIP-17 decrypt loop to route inbound kind-14 rumors with
 * 2+ participants to the right local group.
 *
 * The registry is RAM-only — it's a mirror of GroupsContext.groups, not
 * a persistence layer. AsyncStorage is the source of truth.
 *
 * Rationale for module state vs. context: GroupsContext is mounted INSIDE
 * NostrProvider, so NostrContext can't `useGroups()` directly. We could
 * pass groups via a ref-callback pattern, but a tiny module is simpler
 * and lets the Nostr decrypt loop stay synchronous (no React re-renders
 * to worry about for the lookup).
 */

let known: Group[] = [];
let knownOwner: string | null = null;
let knownLoaded = true;
let reconcilerOwner: string | null = null;
const loadedWaiters = new Set<() => void>();
// An owner whose groups already failed to load within one wait: later wraps
// don't each wait again (a stuck load costs one timeout, not one per wrap).
let timedOutOwner: string | null = null;

/** `loaded` false = the owner's stored groups haven't been read yet (#1830). */
export function setKnownGroups(
  groups: Group[],
  owner: string | null = null,
  loaded: boolean = true,
): void {
  if (loaded || owner !== timedOutOwner) timedOutOwner = null;
  known = groups;
  knownOwner = owner;
  knownLoaded = loaded;
  if (loaded) for (const wake of [...loadedWaiters]) wake();
}

/** True once `owner`'s stored groups are in the registry. */
export function areKnownGroupsLoaded(owner: string | null): boolean {
  return owner === knownOwner && knownLoaded;
}

/** Resolves when `owner`'s stored groups are in the registry, or after `ms`
 * (at once if an earlier wait for `owner` already timed out). */
export function whenKnownGroupsLoaded(owner: string | null, ms: number): Promise<boolean> {
  if (areKnownGroupsLoaded(owner)) return Promise.resolve(true);
  if (owner !== null && owner === timedOutOwner) return Promise.resolve(false);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      loadedWaiters.delete(check);
      const loaded = areKnownGroupsLoaded(owner);
      if (!loaded) timedOutOwner = owner;
      resolve(loaded);
    };
    const check = () => {
      if (areKnownGroupsLoaded(owner)) done();
    };
    const timer = setTimeout(done, ms);
    loadedWaiters.add(check);
  });
}

/**
 * Reconcile a synthetic NIP-17 room (kind-14 from a foreign client with
 * no matching kind-30200) into local state. GroupsContext registers a
 * handler at mount time; NostrContext invokes it from the route-rumor
 * fallback path when the registry's exact-match lookup misses but the
 * rumor carries a `subject` tag.
 *
 * Returns the resolved Group (existing or freshly-created) on success,
 * null when no handler is registered (typically only during cold
 * boot / logout) so callers can no-op cleanly.
 *
 * Implementation MUST be idempotent on (groupId, name): subsequent
 * kind-14s from the same room invoke this with the same id and the
 * latest subject — a no-op when nothing changed, a name update when
 * the subject was edited (NIP-17: "the newest subject in the chat
 * room is the subject of the conversation").
 */
export interface SyntheticRoomInput {
  groupId: string;
  name: string;
  /** All participants OTHER than the viewer (matches Group.memberPubkeys). */
  memberPubkeys: string[];
  /** seconds — the kind-14's created_at, for newest-wins subject resolution. */
  createdAtSec: number;
}

type SyntheticReconciler = (input: SyntheticRoomInput) => Promise<Group | null>;
let syntheticReconciler: SyntheticReconciler | null = null;
const pendingRooms = new Map<string, Set<Promise<Group | null>>>();

function pendingRoomKey(memberPubkeys: Iterable<string>, owner: string | null): string {
  return JSON.stringify([owner, ...Array.from(memberPubkeys, (pk) => pk.toLowerCase()).sort()]);
}

/** Wait only for this account's matching room, never unrelated room creation. */
export async function waitForPendingGroupReconciliation(
  otherParticipants: Set<string>,
  owner: string | null,
): Promise<void> {
  const pending = pendingRooms.get(pendingRoomKey(otherParticipants, owner));
  if (pending) await Promise.allSettled(Array.from(pending));
}

export function setSyntheticGroupReconciler(
  fn: SyntheticReconciler | null,
  owner: string | null = null,
): void {
  syntheticReconciler = fn;
  reconcilerOwner = owner;
}

export async function reconcileSyntheticGroup(
  input: SyntheticRoomInput,
  owner: string | null = null,
): Promise<Group | null> {
  if (owner !== reconcilerOwner || !syntheticReconciler) return null;
  const reconcile = syntheticReconciler;
  const key = pendingRoomKey(input.memberPubkeys, owner);
  const pending = pendingRooms.get(key) ?? new Set<Promise<Group | null>>();
  const task = (async () => {
    const group = await reconcile(input);
    // Publish before returning: React's state-mirroring effect may not have run
    // when the next deferred subjectless rumor starts routing.
    if (
      group &&
      owner === knownOwner &&
      owner === reconcilerOwner &&
      reconcile === syntheticReconciler
    ) {
      known = [group, ...known.filter((existing) => existing.id !== group.id)];
    }
    return group;
  })();
  pending.add(task);
  pendingRooms.set(key, pending);
  try {
    return await task;
  } finally {
    pending.delete(task);
    if (pending.size === 0) pendingRooms.delete(key);
  }
}

/**
 * Find a group whose membership matches the given participant set.
 *
 * `otherParticipants` is the rumor's full participant set with the
 * viewer EXCLUDED (see `classifyRumor`). A group matches when its
 * `memberPubkeys` (which by convention exclude the viewer too) form
 * an exact set-equality with `otherParticipants`.
 *
 * If no group matches, returns null. Callers should NOT auto-create
 * groups from inbound messages — that path is restricted to the
 * kind-30200 reconciliation in GroupsContext, which has the friend-graph
 * trust check.
 */
export function findGroupForParticipants(
  otherParticipants: Set<string>,
  owner: string | null = null,
): Group | null {
  if (owner !== knownOwner) return null;
  for (const group of known) {
    if (group.protocol === 'marmot') continue;
    if (group.memberPubkeys.length !== otherParticipants.size) continue;
    let mismatch = false;
    for (const pk of group.memberPubkeys) {
      if (!otherParticipants.has(pk.toLowerCase())) {
        mismatch = true;
        break;
      }
    }
    if (!mismatch) return group;
  }
  return null;
}
