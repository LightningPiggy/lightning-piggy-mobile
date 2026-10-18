import AsyncStorage from '@react-native-async-storage/async-storage';
import { REPLY_WIRE_KINDS, selectRepliedConversations, subscribeDmStorage } from './dmDb';
import { perAccountKey } from './perAccountStorage';

// "You replied to them" as a follow-gate pass (#1623). Opening a thread with
// someone you don't follow shows their messages (the thread fetch bypasses
// the gate), and you can reply. Once you have, the rest of that conversation
// must arrive like any other: before this, the live gate dropped their later
// messages and reactions while the thread was on screen.
//
// Only the receive gates use this. The Messages list keeps its own trust
// tiers, so a parent-managed account still sees only followed people there.

const repliedByOwner = new Map<string, Set<string>>();
const loads = new Map<string, Promise<void>>();
// Bumped by `forgetRepliedPartners`, so a read that started before an
// account wipe can't put its result back afterwards.
const epochs = new Map<string, number>();
// Replying to someone new leaves their earlier wraps in the inbox skip-set,
// rejected from when they didn't pass the gate. A recheck stays pending (and
// persisted, so a restart keeps it) until a refresh has re-read them. The
// number changes on every new reply, so finishing an older recheck can't
// clear a newer one.
const pendingRecheck = new Map<string, number>();
// Rechecks a refresh has already started this session. Each gets one forced
// pass (TTL and skip-set bypass), even if that pass is cut short; the
// persisted flag retries it after a restart.
const attemptedRecheck = new Map<string, number>();
let recheckSeq = 0;
/** A sent row this recent is a reply just made; older ones are history the
 * inbox ingest is filling in (a fresh sign-in), which needs no recheck. */
const FRESH_REPLY_SECS = 10 * 60;
const RECHECK_KEY = 'dm_replied_skip_recheck_v1';
let unsubscribe: (() => void) | null = null;

function markRecheckPending(owner: string): void {
  pendingRecheck.set(owner, ++recheckSeq);
  AsyncStorage.setItem(perAccountKey(RECHECK_KEY, owner), '1').catch(() => undefined);
}

// Keep the sets current as we send. Rows written before an owner's first load
// are covered by that load's query.
function watchSends(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeDmStorage((owner, rows) => {
    for (const row of rows) {
      if (!row.fromMe || !REPLY_WIRE_KINDS.includes(row.wireKind)) continue;
      const set = repliedByOwner.get(owner) ?? new Set<string>();
      const partner = row.conversation.toLowerCase();
      if (set.has(partner)) continue;
      set.add(partner);
      repliedByOwner.set(owner, set);
      if (row.createdAt >= Date.now() / 1000 - FRESH_REPLY_SECS) markRecheckPending(owner);
    }
  });
}

/** Read who `owner` has replied to (and any pending skip-set recheck) from
 * storage. Once per owner; a failed read is retried by the next call. Never
 * rejects. */
export function loadRepliedPartners(owner: string): Promise<void> {
  watchSends();
  const pending = loads.get(owner);
  if (pending) return pending;
  const epoch = epochs.get(owner) ?? 0;
  const load = Promise.all([
    selectRepliedConversations(owner),
    AsyncStorage.getItem(perAccountKey(RECHECK_KEY, owner)).catch(() => null),
  ])
    .then(([partners, recheck]) => {
      if ((epochs.get(owner) ?? 0) !== epoch) return;
      const set = repliedByOwner.get(owner) ?? new Set<string>();
      for (const p of partners) set.add(p.toLowerCase());
      repliedByOwner.set(owner, set);
      if (recheck && !pendingRecheck.has(owner)) pendingRecheck.set(owner, ++recheckSeq);
    })
    .catch(() => {
      if (loads.get(owner) === load) loads.delete(owner);
    });
  loads.set(owner, load);
  return load;
}

/** Whether `owner` has sent `partner` a 1:1 message. False until loaded. */
export function hasRepliedTo(owner: string, partner: string): boolean {
  return repliedByOwner.get(owner)?.has(partner.toLowerCase()) ?? false;
}

/** A pending skip-set recheck no refresh has started this session, or null. */
export function pendingSkipSetRecheck(owner: string): number | null {
  const recheck = pendingRecheck.get(owner);
  return recheck !== undefined && attemptedRecheck.get(owner) !== recheck ? recheck : null;
}

/** Start the pending recheck's one forced pass, or null if there is none.
 * Pass the value to `completeSkipSetRecheck` once the refresh completes. */
export function beginSkipSetRecheck(owner: string): number | null {
  const recheck = pendingSkipSetRecheck(owner);
  if (recheck !== null) attemptedRecheck.set(owner, recheck);
  return recheck;
}

/** A refresh re-read the skip-set for `recheck`. A newer reply since keeps
 * its own recheck pending. */
export function completeSkipSetRecheck(owner: string, recheck: number): void {
  if (pendingRecheck.get(owner) !== recheck) return;
  pendingRecheck.delete(owner);
  AsyncStorage.removeItem(perAccountKey(RECHECK_KEY, owner)).catch(() => undefined);
}

/** Did a refresh's wrap ingest finish the recheck? Yes if it ran to the end,
 * or if there was nothing to re-read (no wraps / no NIP-17 path for the signer). */
export function skipSetRecheckDone(ingestRan: boolean, ingestAborted: boolean): boolean {
  return !ingestRan || !ingestAborted;
}

/** Forget an account's replies (its DM store was wiped). */
export function forgetRepliedPartners(owner: string): void {
  repliedByOwner.delete(owner);
  loads.delete(owner);
  pendingRecheck.delete(owner);
  attemptedRecheck.delete(owner);
  epochs.set(owner, (epochs.get(owner) ?? 0) + 1);
  AsyncStorage.removeItem(perAccountKey(RECHECK_KEY, owner)).catch(() => undefined);
}

export function __resetRepliedPartnersForTests(): void {
  repliedByOwner.clear();
  loads.clear();
  epochs.clear();
  pendingRecheck.clear();
  attemptedRecheck.clear();
  unsubscribe?.();
  unsubscribe = null;
}
