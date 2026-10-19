import AsyncStorage from '@react-native-async-storage/async-storage';
import { isAttachmentPlaceholderText } from '../utils/attachmentPlaceholder';
import { isNewerEdit } from '../utils/marmotEditOrder';
import { isPollVoteMessage, parsePoll } from '../utils/pollMessage';
import { mutateGroupStorage } from './groupStorageQueue';
import type { MarmotEdit } from './marmotEdits';
import {
  groupMessagesKey,
  groupMessagesOwnerPrefix,
  normaliseGroupOwner,
} from './groupMessagesKeys';
import { ensureGroupMessagesMigrated, releaseLegacyGroupLogs } from './groupMessagesMigration';

/**
 * In-thread message stored locally, per-group. We persist what the user
 * has sent so the UI can re-render after relaunch even before the inbound
 * NIP-17 receive-side routing for groups lands (tracked as a follow-up
 * to PR #227).
 */
export interface GroupMessage {
  /** Stable id; for self-sent messages we use a generated wrap id. */
  id: string;
  /** Original optimistic ID, retained through echo replacement and rekeying. */
  localId?: string;
  /** Stored application kind, retained for unsupported Marmot messages. */
  wireKind?: number;
  /** Pubkey of the sender (lowercase hex). */
  senderPubkey: string;
  /** Text payload as authored (preserves casing); empty for system events. */
  text: string;
  /** Unix seconds — same convention as nostr `created_at`. */
  createdAt: number;
  /** Marmot reply: id of the message this one quotes. */
  replyTo?: string;
  /** Marmot edit: `created_at` of the edit `text` now holds. */
  editedAt?: number;
  /** Marmot edit: id of that edit event (breaks `editedAt` ties). */
  editId?: string;
  /** Marmot: pubkeys the message `p`-tags as mentions (#1295). Text mentions
   * (`nostr:npub…`) are read from `text` and not duplicated here. */
  mentions?: string[];
  /** Our own send that no relay took (or not every member got): the bubble
   * keeps a failed mark, with Re-publish, after a restart too. */
  sendFailed?: boolean;
}

// Account scoping (#1240): history is keyed per owner —
// `group_history_<owner>:<groupId>` (layout in groupMessagesKeys.ts). Two
// local accounts in the same group (synthetic NIP-17 rooms, kind-30200 and
// Marmot ids are the same for every member) each get their own log, and an
// account's sign-out deletes only its own logs (accountCacheWipe). Every
// function awaits the one-time legacy migration (groupMessagesMigration.ts)
// first and never falls back to a legacy device-wide key. A missing / invalid
// owner reads as empty and refuses to write.

function ownerKey(owner: string | null | undefined, groupId: string): string | null {
  const pk = normaliseGroupOwner(owner);
  return pk ? groupMessagesKey(pk, groupId) : null;
}

// Accounts signed out in this process. A write that lands after sign-out
// (a Marmot flush on unmount, a group rumor still being routed) must not
// recreate the deleted history; cleared when the account becomes active again.
const retiredOwners = new Set<string>();

/** Lift the sign-out write guard — call when `owner` becomes the active account. */
export function reviveGroupHistoryOwner(owner: string | null | undefined): void {
  const pk = normaliseGroupOwner(owner);
  if (pk) retiredOwners.delete(pk);
}

function requireOwnerKey(owner: string | null | undefined, groupId: string): string {
  const pk = normaliseGroupOwner(owner);
  if (!pk) throw new Error('Group history needs the signed-in account');
  if (retiredOwners.has(pk)) throw new Error('Group history write for a signed-out account');
  return groupMessagesKey(pk, groupId);
}

async function readLog(key: string, strict = false): Promise<GroupMessage[]> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as GroupMessage[];
    if (!Array.isArray(parsed) && strict) throw new Error('Invalid group history');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (strict) throw error;
    return [];
  }
}

export async function loadGroupMessages(
  owner: string | null | undefined,
  groupId: string,
  options: { strict?: boolean } = {},
): Promise<GroupMessage[]> {
  await ensureGroupMessagesMigrated();
  const key = ownerKey(owner, groupId);
  return key ? readLog(key, options.strict) : [];
}

// Window in seconds for matching an inbound real-event message against a
// pending optimistic local_* row (same sender + same text). Closes #402:
// without this, the sender's own NIP-17 self-wrap echo arrives with the
// gift-wrap hex id, which never collides with the local_<ts>_<rnd> id we
// optimistically appended on send — so both rows persisted and the user
// saw the same message (e.g. a GIF) twice.
const LOCAL_ECHO_MATCH_WINDOW_SECS = 30;
const CAP = 500;

export async function appendGroupMessage(
  owner: string | null | undefined,
  groupId: string,
  message: GroupMessage,
): Promise<GroupMessage[]> {
  requireOwnerKey(owner, groupId); // fail fast for a signed-out account
  await ensureGroupMessagesMigrated();
  const key = requireOwnerKey(owner, groupId);
  return mutateGroupStorage(key, async () => {
    requireOwnerKey(owner, groupId);
    const existing = await readLog(key);
    const map = new Map<string, GroupMessage>();
    for (const m of existing) map.set(m.id, m);

    // When a real (non-local_) event arrives, look for a pending optimistic
    // local_* row from the same sender with identical text and a close-enough
    // createdAt — and replace it with the real one rather than appending
    // alongside. Pick the closest createdAt match so back-to-back identical
    // sends are matched in order even when relay echoes arrive out-of-order.
    // senderPubkey is lowercased on both sides because inbound rumors are
    // lowercased upstream while optimistic locals may use the viewer pubkey
    // as-is.
    // Repeated delivery must not consume another pending send. Continue to
    // ID dedup below so replays can still repair stored metadata.
    if (!message.id.startsWith('local_') && !map.has(message.id)) {
      const targetSender = message.senderPubkey.toLowerCase();
      let bestKey: string | null = null;
      let bestDelta = Infinity;
      for (const [k, m] of map) {
        if (!k.startsWith('local_')) continue;
        if (m.senderPubkey.toLowerCase() !== targetSender) continue;
        if (m.text !== message.text) continue;
        // Identical replies can quote different parents. An echo must consume
        // the matching send, not whichever same-text row is closest in time.
        if (m.replyTo?.toLowerCase() !== message.replyTo?.toLowerCase()) continue;
        const delta = Math.abs(m.createdAt - message.createdAt);
        if (delta > LOCAL_ECHO_MATCH_WINDOW_SECS) continue;
        if (delta < bestDelta) {
          bestDelta = delta;
          bestKey = k;
        }
      }
      if (bestKey !== null) {
        message = { ...message, localId: map.get(bestKey)!.localId ?? bestKey };
        map.delete(bestKey);
      }
    }

    // Dedup on id; keep the newer copy when ids collide (createdAt wins). At the
    // same timestamp a replay can repair an attachment placeholder or restore
    // a missing reply reference, without rolling back an overlaid text edit.
    const prior = map.get(message.id);
    const repairs =
      prior?.createdAt === message.createdAt &&
      message.text !== '' &&
      message.text !== prior.text &&
      isAttachmentPlaceholderText(prior.text);
    if (!prior || prior.createdAt < message.createdAt || repairs) {
      map.set(message.id, { ...message, ...(prior?.localId ? { localId: prior.localId } : {}) });
    } else if (
      prior.createdAt === message.createdAt &&
      prior.senderPubkey.toLowerCase() === message.senderPubkey.toLowerCase()
    ) {
      // Authenticated replay repairs missing metadata, never overlaid text edits.
      map.set(message.id, {
        ...prior,
        ...(prior.wireKind === undefined && message.wireKind !== undefined
          ? { wireKind: message.wireKind }
          : {}),
        ...(!prior.replyTo && message.replyTo && /^[0-9a-f]{64}$/i.test(message.replyTo)
          ? { replyTo: message.replyTo.toLowerCase() }
          : {}),
      });
    }
    const all = Array.from(map.values()).sort((a, b) => a.createdAt - b.createdAt);
    const capped = all.length <= CAP ? all : all.slice(all.length - CAP);
    await AsyncStorage.setItem(key, JSON.stringify(capped));
    return capped;
  });
}

export async function clearGroupMessages(
  owner: string | null | undefined,
  groupId: string,
): Promise<void> {
  await ensureGroupMessagesMigrated();
  const key = ownerKey(owner, groupId);
  if (key) await mutateGroupStorage(key, () => AsyncStorage.removeItem(key));
}

/**
 * Sign-out / account wipe: delete every group log belonging to `owner`, and
 * every legacy device-wide blob no remaining account can claim
 * (`releaseLegacyGroupLogs`). Other accounts' logs — even for the same group
 * — are untouched. MUST run before the account's group list and Marmot state
 * are deleted, so attribution still sees them. From the first line on, writes
 * for `owner` are refused until it becomes active again.
 */
export async function deleteGroupMessagesForOwner(owner: string | null | undefined): Promise<void> {
  const pk = normaliseGroupOwner(owner);
  if (!pk) return;
  retiredOwners.add(pk);
  await ensureGroupMessagesMigrated();
  try {
    await releaseLegacyGroupLogs(pk);
  } finally {
    const prefix = groupMessagesOwnerPrefix(pk);
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(prefix));
    await Promise.all(
      keys.map((key) => mutateGroupStorage(key, () => AsyncStorage.removeItem(key))),
    );
  }
}

/**
 * Remove a single message row by id. Used by the group send failure path
 * (#1033) to retract the optimistic `local_*` row that was painted before
 * signing — mirrors the 1:1 path's "keep the bubble on failure" semantics
 * adapted for group storage: we show a BrandedAlert AND remove the row so
 * a never-published message doesn't linger in the thread. Returns the
 * updated message list on success (the unmodified list, unchanged, if
 * `messageId` wasn't found).
 *
 * On an AsyncStorage write error this REJECTS rather than returning `[]` —
 * matching `appendGroupMessage`'s propagate-on-failure contract elsewhere in
 * this module (and `identitiesStore`'s write-through functions). A transient
 * storage error must never be conflated with "the thread is now empty": a
 * caller that unconditionally did `setMessages(await removeGroupMessage(...))`
 * would otherwise wipe the visible thread on a blip that touched none of the
 * underlying data. Callers MUST catch and treat a rejection as "the row could
 * not be retracted from local storage" — leave any optimistic in-memory
 * removal as-is and do not call setMessages with this function's result.
 * Note: `loadGroupMessages` swallows its own read/parse errors and resolves
 * to `[]` rather than throwing, so in practice only the `setItem` write below
 * can cause this function to reject.
 */
export async function removeGroupMessage(
  owner: string | null | undefined,
  groupId: string,
  messageId: string,
): Promise<GroupMessage[]> {
  await ensureGroupMessagesMigrated();
  const key = requireOwnerKey(owner, groupId);
  return mutateGroupStorage(key, async () => {
    requireOwnerKey(owner, groupId);
    const existing = await readLog(key);
    const filtered = existing.filter((m) => m.id !== messageId);
    if (filtered.length === existing.length) return existing;
    await AsyncStorage.setItem(key, JSON.stringify(filtered));
    return filtered;
  });
}

/**
 * Mark our own optimistic row as a failed send (it stays in the thread, red,
 * with Re-publish — the 1:1 behaviour). Returns the updated list; rejects on
 * a storage write error, like `removeGroupMessage`.
 */
export async function markGroupMessageSendFailed(
  owner: string | null | undefined,
  groupId: string,
  messageId: string,
): Promise<GroupMessage[]> {
  await ensureGroupMessagesMigrated();
  const key = requireOwnerKey(owner, groupId);
  return mutateGroupStorage(key, async () => {
    requireOwnerKey(owner, groupId);
    const existing = await readLog(key);
    if (!existing.some((m) => m.id === messageId && !m.sendFailed)) return existing;
    const next = existing.map((m) => (m.id === messageId ? { ...m, sendFailed: true } : m));
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return next;
  });
}

/**
 * Give an optimistic `local_*` row the id its sent event really has (a Marmot
 * send learns it only once sent), so edits and deletes can target it (#1237).
 * If the real row is already stored, the local copy is just dropped. Runs
 * through the group storage queue. Returns the updated list.
 */
export async function rekeyGroupMessage(
  owner: string | null | undefined,
  groupId: string,
  localId: string,
  realId: string,
): Promise<GroupMessage[]> {
  await ensureGroupMessagesMigrated();
  const key = requireOwnerKey(owner, groupId);
  return mutateGroupStorage(key, async () => {
    requireOwnerKey(owner, groupId);
    const existing = await readLog(key);
    if (!existing.some((m) => m.id === localId)) return existing;
    const stableId = existing.find((m) => m.id === localId)!.localId ?? localId;
    const hasReal = existing.some((m) => m.id === realId);
    const next = existing.flatMap((m) => {
      if (m.id === realId) return [{ ...m, localId: stableId }];
      if (m.id !== localId) return [m];
      return hasReal ? [] : [{ ...m, id: realId, localId: stableId }];
    });
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return next;
  });
}

/**
 * Whether a stored group message is plain chat text its author may edit — not
 * a photo / voice note (an `#lpe=1` URL), a structured poll, vote or order
 * (stored as JSON), or a legacy text poll / vote. The DM store gets the same
 * guarantee from `wire_kind = 14`.
 */
export function isEditableGroupText(text: string, wireKind?: number): boolean {
  return (
    (wireKind === undefined || wireKind === 14) &&
    !text.trimStart().startsWith('[FILE]') &&
    !text.includes('#lpe=1') &&
    !text.trimStart().startsWith('{') &&
    !parsePoll(text) &&
    !isPollVoteMessage(text)
  );
}

/**
 * Apply Marmot edits to a group's stored messages: one load and at most one
 * write for the whole batch, through the group storage queue (so a concurrent
 * send or deletion can't interleave). Each edit replaces a message's text only
 * when its author sent it, the message is editable text, and it outranks any
 * edit already applied (isNewerEdit). Returns whether anything changed.
 */
export async function editGroupMessages(
  owner: string | null | undefined,
  groupId: string,
  edits: readonly MarmotEdit[],
): Promise<boolean> {
  if (edits.length === 0) return false;
  await ensureGroupMessagesMigrated();
  const key = requireOwnerKey(owner, groupId);
  return mutateGroupStorage(key, async () => {
    requireOwnerKey(owner, groupId);
    const next = await readLog(key);
    const indexById = new Map(next.map((m, i) => [m.id, i]));
    let changed = false;
    for (const edit of edits) {
      const i = indexById.get(edit.target);
      if (i === undefined) continue;
      const target = next[i];
      if (target.senderPubkey.toLowerCase() !== edit.editor.toLowerCase()) continue;
      if (!isEditableGroupText(target.text, target.wireKind) || !isNewerEdit(edit, target))
        continue;
      next[i] = { ...target, text: edit.content, editedAt: edit.editedAt, editId: edit.editId };
      changed = true;
    }
    if (changed) await AsyncStorage.setItem(key, JSON.stringify(next));
    return changed;
  });
}

/** One edit — see `editGroupMessages`. */
export function editGroupMessage(
  owner: string | null | undefined,
  groupId: string,
  messageId: string,
  editor: string,
  text: string,
  editedAt: number,
  editId = '',
): Promise<boolean> {
  return editGroupMessages(owner, groupId, [
    { target: messageId, editor, content: text, editedAt, editId },
  ]);
}

/**
 * Remove every stored message `shouldRemove` flags — a Marmot "delete for
 * everyone" erasing the plaintext at rest. Returns the remaining list; writes
 * only when something was removed.
 */
export async function removeGroupMessagesWhere(
  owner: string | null | undefined,
  groupId: string,
  shouldRemove: (message: GroupMessage) => boolean,
  options: { strict?: boolean } = {},
): Promise<GroupMessage[]> {
  await ensureGroupMessagesMigrated();
  const key = requireOwnerKey(owner, groupId);
  return mutateGroupStorage(key, async () => {
    requireOwnerKey(owner, groupId);
    const existing = await readLog(key, options.strict);
    const filtered = existing.filter((m) => !shouldRemove(m));
    if (filtered.length === existing.length) return existing;
    await AsyncStorage.setItem(key, JSON.stringify(filtered));
    return filtered;
  });
}

// Scan AsyncStorage for every one of `owner`'s group logs and return
// the set of message ids that look like NIP-17 wrap ids (64-char hex —
// `local_*` optimistic rows are excluded). Used by NostrContext to
// pre-seed `knownWrapIds` on cold start so the live DM sub doesn't
// redundantly decrypt + re-route group wraps it already processed in
// a previous session. Single AsyncStorage round-trip per stored group.
const WRAP_ID_PATTERN = /^[0-9a-f]{64}$/;
export async function listPersistedGroupWrapIds(
  owner: string | null | undefined,
): Promise<string[]> {
  await ensureGroupMessagesMigrated();
  const pk = normaliseGroupOwner(owner);
  if (!pk) return [];
  try {
    const prefix = groupMessagesOwnerPrefix(pk);
    const keys = await AsyncStorage.getAllKeys();
    const groupKeys = keys.filter((k) => k.startsWith(prefix));
    if (groupKeys.length === 0) return [];
    const pairs = await AsyncStorage.multiGet(groupKeys);
    const ids: string[] = [];
    for (const [, raw] of pairs) {
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as GroupMessage[];
        if (!Array.isArray(parsed)) continue;
        for (const m of parsed) {
          if (typeof m.id === 'string' && WRAP_ID_PATTERN.test(m.id)) ids.push(m.id);
        }
      } catch {
        // Skip malformed blob — better than aborting the whole scan.
      }
    }
    return ids;
  } catch {
    return [];
  }
}
