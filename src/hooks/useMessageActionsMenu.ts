import type React from 'react';
import { useCallback, useMemo } from 'react';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from '../contexts/LocaleContext';
import { useAccountState } from '../contexts/useAccountState';
import { messageEditDelete } from '../utils/messageEditDelete';
import { appendSharedText } from '../utils/incomingShare';
import {
  sendMarmotMessageAction,
  type MarmotActionTarget,
  type MarmotMessageAction,
} from '../services/marmotMessageActions';

/** The message rows a chat screen holds (1:1 `ConversationMessage`, group `GroupMessage`). */
interface EditableRow {
  text: string;
  editedAt?: number;
}

interface Params<T extends EditableRow> {
  myPubkey: string | null;
  /** Account + thread this menu belongs to (e.g. `${me}:${groupId}`). A screen
   * instance can be reused for another thread or account: an edit started
   * under one scope is invisible, and inert, under any other. */
  scope: string | null;
  /** The Marmot 1:1 peer, or the Marmot group id. Neither (NIP-04 / NIP-17
   * thread): no Edit / Delete, and every action is a no-op. */
  marmotPeer?: string | null;
  marmotGroupId?: string | null;
  messages: T[];
  setMessages: React.Dispatch<React.SetStateAction<T[]>>;
  /** A row's Marmot event id (1:1: its rumor id). */
  idOf: (message: T) => string | undefined;
  draft: string;
  setDraft: (value: string) => void;
  /** The long-pressed message (null = menu closed), and how to close the menu. */
  actioned: ActionedMessage | null;
  closeActions: () => void;
  /** The composer's normal send — Send saves the edit instead while editing. */
  onSend: () => void;
}

export interface ActionedMessage {
  /** Marmot event id (1:1: rumor id). */
  targetId: string;
  fromMe: boolean;
  /** Copyable chat text or a sanitized attachment filename. */
  copyText?: string;
  /** False when Copy exposes only a sanitized attachment filename. */
  isPlainText?: boolean;
  /** Still sending (or failed): nothing to point an edit / delete at yet. */
  pending?: boolean;
}

interface EditingState {
  targetId: string;
  /** What the composer held before Edit took it over — restored after. */
  priorDraft: string;
  previousEditedAt?: number;
  originalText: string;
}

const NOT_EDITING: EditingState | null = null;

/**
 * The long-press message menu's text actions — Copy text, plus "Edit" and
 * "Delete for everyone" for your own messages in a Marmot chat (#1237).
 * Returns ready-made props for `MessageActionsSheet` and
 * `ConversationComposer`. Edit borrows the composer (an "Editing message" state the screen
 * renders via `editing`); Delete confirms first. Both update the thread at
 * once and roll back with a Toast if the send fails; on success the store is
 * updated by the inbound path (see `sendMarmotMessageAction`), and the
 * screen's usual store re-read takes over from the optimistic copy.
 */
export function useMessageActionsMenu<T extends EditableRow>({
  myPubkey,
  scope,
  marmotPeer,
  marmotGroupId,
  messages,
  setMessages,
  idOf,
  draft,
  setDraft,
  actioned,
  closeActions,
  onSend,
}: Params<T>) {
  const t = useTranslation();
  const target = useMemo<MarmotActionTarget | null>(
    () => (marmotGroupId ? { groupId: marmotGroupId } : marmotPeer ? { peer: marmotPeer } : null),
    [marmotPeer, marmotGroupId],
  );
  const [editing, setEditing] = useAccountState<EditingState | null>(scope, NOT_EDITING);

  // Optimistically apply `change` to the thread; returns the undo.
  const applyOptimistic = useCallback(
    (targetId: string, change: { text: string; editedAt: number } | null): (() => void) => {
      const index = messages.findIndex((m) => idOf(m) === targetId);
      const original = messages[index];
      if (!original) return () => {};
      setMessages((prev) =>
        change
          ? prev.map((m) => (idOf(m) === targetId ? { ...m, ...change } : m))
          : prev.filter((m) => idOf(m) !== targetId),
      );
      return () =>
        setMessages((prev) => {
          // Only undo our own change: a later edit (or a store reload) wins.
          if (change) {
            return prev.map((m) => (idOf(m) === targetId && m.text === change.text ? original : m));
          }
          if (prev.some((m) => idOf(m) === targetId)) return prev;
          const next = [...prev];
          next.splice(Math.min(index, next.length), 0, original);
          return next;
        });
    },
    [messages, setMessages, idOf],
  );

  const send = useCallback(
    async (targetId: string, action: MarmotMessageAction, undo: () => void) => {
      if (!myPubkey || !target) return;
      const result = await sendMarmotMessageAction(myPubkey, target, targetId, action);
      if (result.success) return;
      undo();
      Toast.show({
        type: 'error',
        text1: t(action.type === 'edit' ? 'messageEdit.editFailed' : 'messageEdit.deleteFailed'),
        text2: result.error,
      });
    },
    [myPubkey, target, t],
  );

  const deleteNow = useCallback(
    (targetId: string) => {
      const undo = applyOptimistic(targetId, null);
      void send(targetId, { type: 'delete' }, undo);
    },
    [applyOptimistic, send],
  );

  /** Ask, then delete `targetId` for everyone. */
  const confirmDelete = useCallback(
    (targetId: string) => {
      if (!target) return;
      Alert.alert(t('messageEdit.deleteTitle'), t('messageEdit.deleteBody'), [
        { text: t('messageEdit.cancel'), style: 'cancel' },
        {
          text: t('messageEdit.deleteConfirm'),
          style: 'destructive',
          onPress: () => deleteNow(targetId),
        },
      ]);
    },
    [target, t, deleteNow],
  );

  /** Put `targetId`'s text in the composer to edit it. */
  const startEdit = useCallback(
    (targetId: string) => {
      const message = messages.find((m) => idOf(m) === targetId);
      if (!target || !message) return;
      setEditing({
        targetId,
        priorDraft: editing ? editing.priorDraft : draft,
        previousEditedAt: message.editedAt,
        originalText: message.text,
      });
      setDraft(message.text);
    },
    [target, messages, idOf, editing, draft, setDraft, setEditing],
  );

  const cancelEdit = useCallback(() => {
    if (!editing) return;
    setEditing(null);
    setDraft(editing.priorDraft);
  }, [editing, setDraft, setEditing]);

  /** Text shared in from another app (#1692) goes on the new-message draft,
   *  after anything typed. Mid-edit it waits on the draft the edit hands back
   *  — never in the edit, where Save would write it into an old message. */
  const appendDraftText = useCallback(
    (text: string) => {
      if (editing) {
        setEditing({ ...editing, priorDraft: appendSharedText(editing.priorDraft, text) });
      } else {
        setDraft(appendSharedText(draft, text));
      }
    },
    [editing, draft, setDraft, setEditing],
  );

  /** Send the composer's text as the edit (unchanged or empty = just stop editing). */
  const submitEdit = useCallback(() => {
    if (!editing) return;
    const text = draft.trim();
    const { targetId, previousEditedAt } = editing;
    // The message is gone (deleted meanwhile): stop editing but keep the typed text.
    if (!messages.some((m) => idOf(m) === targetId)) {
      setEditing(null);
      return;
    }
    cancelEdit();
    if (text === '' || text === editing.originalText.trim()) return;
    // Display-only stamp: the edit's real `created_at` replaces it on success.
    const editedAt = Math.max(Math.floor(Date.now() / 1000), (previousEditedAt ?? 0) + 1);
    const undo = applyOptimistic(targetId, { text, editedAt });
    void send(targetId, { type: 'edit', text, previousEditedAt }, undo);
  }, [editing, draft, messages, idOf, setEditing, cancelEdit, applyOptimistic, send]);

  const copyText = actioned?.copyText;
  const onCopyText = useCallback(async () => {
    if (!copyText) return;
    await Clipboard.setStringAsync(copyText);
    Toast.show({ type: 'success', text1: t('messageActionsSheet.copied') });
    closeActions();
  }, [copyText, t, closeActions]);

  const { canEdit, canDelete } = messageEditDelete({
    isMarmot: target !== null,
    fromMe: !!actioned?.fromMe,
    targetId: actioned?.targetId,
    isPlainText: actioned?.isPlainText ?? !!copyText,
    pending: !!actioned?.pending,
  });
  const targetId = actioned?.targetId;
  const onEdit = useCallback(() => {
    closeActions();
    if (targetId) startEdit(targetId);
  }, [closeActions, targetId, startEdit]);
  const onDelete = useCallback(() => {
    closeActions();
    if (targetId) confirmDelete(targetId);
  }, [closeActions, targetId, confirmDelete]);

  const isEditing = editing !== null;
  return useMemo(
    () => ({
      sheet: {
        onCopyText: copyText ? onCopyText : undefined,
        onEdit: canEdit ? onEdit : undefined,
        onDelete: canDelete ? onDelete : undefined,
      },
      composer: {
        onSend: isEditing ? submitEdit : onSend,
        editing: isEditing ? { onCancel: cancelEdit } : undefined,
      },
      appendDraftText,
    }),
    [
      appendDraftText,
      copyText,
      onCopyText,
      canEdit,
      onEdit,
      canDelete,
      onDelete,
      isEditing,
      submitEdit,
      onSend,
      cancelEdit,
    ],
  );
}
