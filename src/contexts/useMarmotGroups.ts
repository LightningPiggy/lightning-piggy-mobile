import { logUnsupportedMarmotKind } from '../utils/unsupportedMarmotKind';
import { sanitizeDisplayText } from '../utils/sanitizeDisplayText';
import { getAppFormatLocale } from '../utils/appFormatLocale';
import { useAccountState } from './useAccountState';
import { useCallback, useEffect, useMemo } from 'react';

import {
  appendGroupMessages,
  editGroupMessages,
  isEditableGroupText,
  loadGroupMessages,
  removeGroupMessagesWhere,
  type GroupMessage,
} from '../services/groupMessagesStorageService';
import { mayDelete, parseMarmotDeletion, type MarmotDeletion } from '../services/marmotDeletions';
import { MarmotDeletionTracker } from '../services/marmotDeletionTracker';
import { EditLedger, parseMarmotEdit, type MarmotEdit } from '../services/marmotEdits';
import {
  isMarmotMessageKind,
  marmotRumorToGroupMessage,
  storedKindForMarmot,
  storedMarmotContent,
} from '../services/marmotInbox';
import { dmRowPreview } from '../utils/dmRowPreview';
import { requireMarmotSession } from '../services/marmotSend';
import {
  MARMOT_CHAT_KIND,
  subscribeMarmotSession,
  type MarmotGroupSummary,
  type MarmotMessageEvent,
} from '../services/marmotSession';
import { fireMessageNotification } from '../services/notificationService';
import { Toast } from '../components/BrandedToast';
import type { Group } from '../types/groups';
import { undeliveredInviteNotice, type UndeliveredInvites } from '../utils/marmotInviteNotice';
import { notifyGroupMessage } from './nostrEventBus';

const EMPTY_SUMMARIES: MarmotGroupSummary[] = [];

const FLUSH_MS = 150;
const NOTIFY_SKEW_SEC = 120;

const toGroup = (g: MarmotGroupSummary): Group => ({
  id: g.id,
  name: sanitizeDisplayText(g.name, { maxLen: 64 }),
  memberPubkeys: g.memberPubkeys,
  createdAt: g.createdAt,
  updatedAt: g.createdAt,
  protocol: 'marmot',
  adminPubkeys: g.adminPubkeys,
});

export interface MarmotGroupsApi {
  /** Multi-member Marmot groups (1:1 DM groups live in the DM inbox). */
  groups: Group[];
  create: (name: string, memberPubkeys: string[]) => Promise<Group>;
  rename: (groupId: string, name: string) => Promise<boolean>;
  addMembers: (groupId: string, pubkeys: string[]) => Promise<Group | null>;
  removeMember: (groupId: string, pubkey: string) => Promise<Group | null>;
  setAdmins: (groupId: string, update: (current: string[]) => string[]) => Promise<void>;
  leave: (groupId: string) => Promise<void>;
}

/**
 * GroupsContext's Marmot half: mirrors the session's multi-member groups as
 * app `Group`s, runs membership ops through MLS commits, and stores inbound
 * group messages (coalesced: one append pass + one notify per group per
 * ≤150 ms burst — #perf).
 */
export function useMarmotGroups(
  pubkey: string | null,
  /** Display name for a pubkey (for "invitation not delivered yet"). */
  nameOf: (pubkey: string) => string = (pk) => pk.slice(0, 8),
  /** Amber / NIP-46: retries wait for a send, so the notice says that. */
  remoteSigner = false,
): MarmotGroupsApi {
  const [summaries, setSummaries] = useAccountState(pubkey, EMPTY_SUMMARIES);

  useEffect(() => {
    if (!pubkey) {
      setSummaries([]);
      return;
    }
    const openedAtSec = Math.floor(Date.now() / 1000);
    let disposed = false;
    let pending: MarmotMessageEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribeMessages: (() => void) | null = null;

    // Flushes run strictly one after another so a batch's append, edits,
    // deletions and notify for a group stay in order with the next batch.
    let chain: Promise<void> = Promise.resolve();
    const flush = () => {
      timer = null;
      const batch = pending;
      pending = [];
      if (batch.length === 0) return chain;
      chain = chain
        .then(() => writeBatch(batch))
        .catch((e) => {
          if (__DEV__) console.warn('[Marmot] group message write failed:', e);
        });
      return chain;
    };
    // "Delete for everyone": what has been deleted per group (arrival order
    // and history replays can put a delete before its target).
    const deletions = new MarmotDeletionTracker(pubkey, openedAtSec);
    // Edits (kind 1009): the latest per message, for one arriving before (or
    // replayed after) its target.
    const edits = new EditLedger();
    type Incoming =
      | { event: MarmotMessageEvent; message: GroupMessage }
      | { groupId: string; edit: MarmotEdit };
    const writeBatch = async (batch: MarmotMessageEvent[]) => {
      const byGroup = new Map<string, GroupMessage[]>();
      const deletedIn = new Map<string, MarmotDeletion[]>();
      const incoming: Incoming[] = [];
      for (const event of batch) {
        const { group, rumor, mediaKeys } = event;
        if (!byGroup.has(group.id)) byGroup.set(group.id, []);
        const edit = parseMarmotEdit(rumor);
        if (edit) {
          incoming.push({ groupId: group.id, edit });
          continue;
        }
        const deletion = parseMarmotDeletion(rumor, group);
        if (deletion) {
          deletedIn.set(group.id, [...(deletedIn.get(group.id) ?? []), deletion]);
          continue;
        }
        let message = marmotRumorToGroupMessage(rumor, mediaKeys);
        logUnsupportedMarmotKind(event.rumor.kind, event.rumor.pubkey, event.group.id);
        // An edit may have arrived first (or the history replays).
        const overlay =
          storedMarmotContent(rumor, mediaKeys).kind === storedKindForMarmot(MARMOT_CHAT_KIND) &&
          isEditableGroupText(message.text, message.wireKind)
            ? edits.latestFor(message.id, message.senderPubkey, group.id)
            : undefined;
        if (overlay) {
          message = {
            ...message,
            text: overlay.content,
            editedAt: overlay.editedAt,
            editId: overlay.editId,
          };
        }
        incoming.push({ event, message });
      }
      // Deleted messages (arrived after their delete, or replayed) and edits of
      // deleted messages are dropped: one tombstone query for the whole batch,
      // after this batch's deletions are durable. Fails closed (the history
      // replays them next start), and the removals below still run.
      let live: Incoming[] = [];
      try {
        await deletions.persist();
        live = await deletions.filterLive(incoming, (item) =>
          'edit' in item
            ? { scope: item.groupId, id: item.edit.target, sender: item.edit.editor }
            : {
                scope: item.event.group.id,
                id: item.message.id,
                sender: item.message.senderPubkey,
              },
        );
      } catch (e) {
        if (__DEV__) console.warn('[Marmot] deletion check failed:', e);
      }
      const editsIn = new Map<string, MarmotEdit[]>();
      const arrived: MarmotMessageEvent[] = [];
      for (const item of live) {
        if ('edit' in item) {
          editsIn.set(item.groupId, [...(editsIn.get(item.groupId) ?? []), item.edit]);
        } else {
          byGroup.get(item.event.group.id)!.push(item.message);
          arrived.push(item.event);
        }
      }
      for (const [groupId, messages] of byGroup) {
        // One read-modify-write for the whole batch, not one per message (#1786).
        if (messages.length > 0) await appendGroupMessages(pubkey, groupId, messages);
        // Edits to messages stored by earlier batches / sessions: one pass.
        const edited = await editGroupMessages(pubkey, groupId, editsIn.get(groupId) ?? []);
        // Erase what's already stored (earlier batches / sessions).
        const groupDeletions = deletedIn.get(groupId);
        if (groupDeletions) {
          await removeGroupMessagesWhere(pubkey, groupId, (m) =>
            groupDeletions.some((d) => d.targets.includes(m.id) && mayDelete(d, m.senderPubkey)),
          );
        }
        if (messages.length > 0 || groupDeletions || edited) {
          const remaining = await loadGroupMessages(pubkey, groupId);
          if (!disposed) notifyGroupMessage(groupId, remaining[remaining.length - 1]);
        }
      }
      for (const event of arrived) notifyMessage(event);
    };

    const onMessage = (event: MarmotMessageEvent) => {
      if (event.group.isDm) return; // useMarmotDmInbound owns these
      const deletion = parseMarmotDeletion(event.rumor, event.group);
      if (deletion) {
        deletions.note(event.group.id, deletion, event.rumor.created_at);
        pending.push(event);
        if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
        return;
      }
      const edit = parseMarmotEdit(event.rumor);
      if (edit) {
        edits.add(edit, event.group.id);
        pending.push(event);
        if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
        return;
      }
      if (!isMarmotMessageKind(event.rumor.kind)) return; // plumbing, not a message
      pending.push(event);
      if (!timer) timer = setTimeout(() => void flush(), FLUSH_MS);
    };

    const notifyMessage = (event: MarmotMessageEvent) => {
      if (disposed) return;
      const { rumor, group } = event;
      const fromMe = rumor.pubkey.toLowerCase() === pubkey.toLowerCase();
      if (deletions.blocks(group.id, rumor.id, rumor.pubkey)) return; // already deleted
      if (!fromMe && rumor.created_at >= openedAtSec - NOTIFY_SKEW_SEC) {
        // Redacted like the DM inbox: a photo's stored text embeds its keys.
        const stored = storedMarmotContent(rumor, event.mediaKeys);
        const text = dmRowPreview(stored.text, stored.kind, getAppFormatLocale());
        void fireMessageNotification({
          kind: 'group',
          threadId: group.id,
          title: group.name || 'New group message',
          body: text,
          data: {
            groupId: group.id,
            messageId: rumor.id,
            marmotGroupId: group.id,
            senderPubkey: rumor.pubkey,
          },
          shouldSuppress: async () =>
            disposed || (await deletions.isDeleted(group.id, rumor.id, rumor.pubkey)),
          owner: pubkey,
          // Which push placeholders this message stands for (marmotPushWake).
          sentAt: rumor.created_at * 1000,
        });
      }
    };

    const unsubscribeSession = subscribeMarmotSession((session) => {
      unsubscribeMessages?.();
      if (!session || session.pubkey !== pubkey) {
        unsubscribeMessages = null;
        setSummaries([]);
        return;
      }
      setSummaries(session.listGroups());
      unsubscribeMessages = session.subscribe({ onMessage, onGroupsChanged: setSummaries });
    });
    return () => {
      disposed = true;
      unsubscribeSession();
      unsubscribeMessages?.();
      if (timer) clearTimeout(timer);
      void flush();
      deletions.dispose();
    };
  }, [pubkey, setSummaries]);

  const groups = useMemo(() => summaries.filter((g) => !g.isDm).map(toGroup), [summaries]);

  const session = useCallback(() => {
    if (!pubkey) throw new Error('Not logged in');
    return requireMarmotSession(pubkey);
  }, [pubkey]);
  const current = useCallback(
    (groupId: string) => {
      const g = session().getGroup(groupId);
      return g ? toGroup(g) : null;
    },
    [session],
  );

  // Their Welcome is retried; say when (and why it waits, #1402).
  const reportUndelivered = useCallback(
    (outcome: UndeliveredInvites) => {
      const notice = undeliveredInviteNotice(outcome, nameOf, remoteSigner);
      if (notice) Toast.show({ type: 'info', text1: notice.title, text2: notice.body });
    },
    [nameOf, remoteSigner],
  );
  const create = useCallback(
    async (name: string, memberPubkeys: string[]) => {
      const group = await session().createGroup(name.trim(), [...new Set(memberPubkeys)]);
      reportUndelivered(group);
      return toGroup(group);
    },
    [session, reportUndelivered],
  );
  const rename = useCallback(
    async (groupId: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return false;
      await session().rename(groupId, trimmed);
      return true;
    },
    [session],
  );
  const addMembers = useCallback(
    async (groupId: string, pubkeys: string[]) => {
      const existing = new Set(current(groupId)?.memberPubkeys ?? []);
      const toAdd = [...new Set(pubkeys)].filter((pk) => !existing.has(pk));
      if (toAdd.length > 0) reportUndelivered(await session().addMembers(groupId, toAdd));
      return current(groupId);
    },
    [session, current, reportUndelivered],
  );
  const removeMember = useCallback(
    async (groupId: string, pubkey: string) => {
      await session().removeMember(groupId, pubkey);
      return current(groupId);
    },
    [session, current],
  );
  const setAdmins = useCallback(
    (groupId: string, update: (current: string[]) => string[]) =>
      session().setAdmins(groupId, update),
    [session],
  );
  const leave = useCallback((groupId: string) => session().leave(groupId), [session]);

  return useMemo(
    () => ({ groups, create, rename, addMembers, removeMember, setAdmins, leave }),
    [groups, create, rename, addMembers, removeMember, setAdmins, leave],
  );
}
