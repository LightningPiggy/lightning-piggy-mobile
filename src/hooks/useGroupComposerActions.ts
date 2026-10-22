import { useNip17FileComposer } from './useNip17FileComposer';
import React, { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { Alert } from '../components/BrandedAlert';
import { useNostr, notifyGroupMessage } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import {
  appendGroupMessage,
  markGroupMessageSendFailed,
  rekeyGroupMessage,
  removeGroupMessage,
  type GroupMessage,
} from '../services/groupMessagesStorageService';
import { encodeEncryptedFileUrl } from '../utils/encryptedFileUrl';
import type { EncryptedUpload } from '../services/imageUploadService';
import type { Group } from '../types/groups';
import { useComposerActions } from './useComposerActions';
import type { SharedLocation } from '../services/locationService';
import { confirmGroupLocationShare } from '../utils/confirmLocationShare';
import { sendMarmotImage, type MarmotImage } from '../services/marmotSend';
import { isMarmotGroupId } from '../services/marmotSession';
import { trackGroupDelivery } from '../utils/groupDeliveryStore';
import { parseVote } from '../utils/pollMessage';

/**
 * Group GroupConversationScreen composer actions. A thin wrapper over the
 * shared `useComposerActions` (#235): it provides the group send strategy
 * (`sendGroupMessage` text / kind-15 file + an optimistic `local_…`-row append
 * with scroll) and re-exposes the shared handlers, plus the group-only
 * `handleSendInvoiceToGroup`. The 1:1 sibling is `useConversationComposerActions`.
 *
 * Optimistic-send semantics (#1033):
 *   The group path now mirrors the 1:1 path — the optimistic bubble is painted
 *   IMMEDIATELY when `onRumorReady` fires (before any signing), not after the
 *   full `sendGroupMessage` round-trip. The row is captured synchronously and
 *   the async storage write is exposed as a settle-promise, so outcomes stay
 *   truthful regardless of how the two races interleave:
 *   - Each optimistic row shows pending → sent / failed ticks from the send's
 *     per-relay result (session-scoped `groupDeliveryStore`, keyed by the
 *     row's optimistic id).
 *   - Text send FAILED → the bubble stays, marked failed (persisted as
 *     `sendFailed`), with Re-publish in the message-info sheet — the 1:1
 *     behaviour. File / photo / voice sends still alert and remove the row
 *     (Re-publish only re-sends text).
 *   - Relay send OK, storage write FAILED → 'Saved on relay, not on device'
 *     Alert (only now is "your message was sent" true) and return false so the
 *     caller keeps the draft for retry — the pre-#1033 semantics.
 */
export function useGroupComposerActions(params: {
  group: Group | undefined;
  draft: string;
  setDraft: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<GroupMessage[]>>;
  scrollToEnd: () => void;
  setAttachPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setGifPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setContactPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setVoiceSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** Rewrites the typed text before a composer send — `@Name` → `nostr:npub…` (#1295). */
  encodeMessage?: (text: string) => string;
  replyTo?: string;
  onReplySent?: (target: string | undefined) => void;
}) {
  const {
    group,
    draft,
    setDraft,
    setMessages,
    scrollToEnd,
    setAttachPanelOpen,
    setGifPickerOpen,
    setContactPickerOpen,
    setVoiceSheetOpen,
    encodeMessage,
    replyTo,
    onReplySent,
  } = params;

  const { sendGroupMessage, pubkey: myPubkey, signEvent } = useNostr();
  const t = useTranslation();

  // Latest group + identity, read at send time. A location send awaits a
  // consent dialog, during which a roster update can land; the send must go
  // to the roster the user just approved, not the one captured when the
  // share started (#1253 review).
  const latestRef = useRef({ group, myPubkey });
  useLayoutEffect(() => {
    latestRef.current = { group, myPubkey };
  }, [group, myPubkey]);

  // Optimistically append a `local_…` row (dup window vs the inbound self-wrap
  // is a known follow-up, PR #227) and scroll to it.
  //
  // With the #1033 optimistic-bubble change this is called from inside the
  // `onRumorReady` hook (synchronously, before signing), not after the send.
  // The in-memory row is painted immediately and returned synchronously so the
  // failure path always has its id; the async storage write is exposed as
  // `persisted` (never rejects) so callers can await it and judge the outcome
  // once the relay send has resolved.
  const appendOptimisticGroupRow = useCallback(
    (
      text: string,
      // sendText passes its send-time snapshot so the row lands in the thread
      // the message actually went to, not the one this callback closed over.
      targetGroup = group,
      targetPubkey = myPubkey,
      parent?: string,
      wireKind?: number,
    ): { row: GroupMessage; persisted: Promise<boolean> } | null => {
      if (!targetGroup || !targetPubkey) return null;
      const local: GroupMessage = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        senderPubkey: targetPubkey,
        ...(parent ? { replyTo: parent } : {}),
        text,
        ...(wireKind !== undefined ? { wireKind } : {}),
        createdAt: Math.floor(Date.now() / 1000),
      };
      // Paint the bubble immediately in UI state — storage is async. The
      // cross-screen `notifyGroupMessage` event, however, must NOT fire yet:
      // `GroupConversationScreen`/`GroupsContext` listeners reload from
      // AsyncStorage when it fires, so notifying before the append settles
      // can clobber the just-painted row with a storage snapshot that
      // doesn't include it yet (flicker). Notify only once the write has
      // actually landed, mirroring the pre-#1033 ordering.
      setMessages((prev) => [...prev, local]);
      setTimeout(scrollToEnd, 0);
      const persisted = appendGroupMessage(targetPubkey, targetGroup.id, local)
        .then((next) => {
          setMessages(next);
          notifyGroupMessage(targetGroup.id, local);
          return true;
        })
        .catch((err: unknown) => {
          if (__DEV__) console.warn('[GroupConversationScreen] appendGroupMessage failed:', err);
          return false;
        });
      return { row: local, persisted };
    },
    [group, myPubkey, setMessages, scrollToEnd],
  );

  const trackDelivery = trackGroupDelivery;

  // A text send no relay took: keep the bubble, marked failed (also on disk,
  // so it still reads as failed after a restart).
  const markOptimisticFailed = useCallback(
    async (rowId: string, targetGroup = group): Promise<void> => {
      if (!targetGroup) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === rowId || m.localId === rowId ? { ...m, sendFailed: true } : m)),
      );
      try {
        await markGroupMessageSendFailed(myPubkey, targetGroup.id, rowId);
      } catch (err) {
        if (__DEV__)
          console.warn('[GroupConversationScreen] markGroupMessageSendFailed failed:', err);
      }
    },
    [group, myPubkey, setMessages],
  );

  // Relay send succeeded but the local storage write didn't — only here is
  // "your message was sent" actually true, so the alert lives with the caller
  // outcome, not inside appendOptimisticGroupRow.
  const alertSavedOnRelayOnly = useCallback((): void => {
    Alert.alert(
      'Saved on relay, not on device',
      'Your message was sent, but we could not save it locally. Try again to refresh, or restart the app.',
    );
  }, []);

  // Remove a previously-appended optimistic row on a complete send failure.
  // Also used after a successful re-publish to retire the original failed row.
  // The row being removed is always from a failed send. Updates in-memory
  // state directly via the filter below (never from removeGroupMessage's return value — see that
  // function's doc: it rejects on a storage error rather than returning `[]`,
  // specifically so a transient AsyncStorage blip can't be mistaken for "the
  // thread is now empty"). A storage-write failure here just means the
  // retraction didn't persist; the row is still gone from the UI, and we
  // swallow the error since there's no user-facing action to take on a
  // failed cleanup of an already-failed send.
  const removeOptimisticRow = useCallback(
    async (rowId: string, targetGroup = group): Promise<void> => {
      if (!targetGroup) return;
      setMessages((prev) => prev.filter((m) => m.id !== rowId && m.localId !== rowId));
      try {
        await removeGroupMessage(myPubkey, targetGroup.id, rowId);
      } catch (err) {
        if (__DEV__) console.warn('[GroupConversationScreen] removeGroupMessage failed:', err);
      }
    },
    [group, myPubkey, setMessages],
  );

  // A Marmot send learns its event id only once sent: move the optimistic row
  // onto it so the message can be edited / deleted for everyone (#1237).
  const adoptRumorId = useCallback(
    async (
      rowId: string,
      rumorId: string | undefined,
      targetGroup = group,
      owner = myPubkey,
    ): Promise<void> => {
      if (!targetGroup || !owner || !rumorId) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === rowId ? { ...m, id: rumorId, localId: m.localId ?? rowId } : m)),
      );
      try {
        setMessages(await rekeyGroupMessage(owner, targetGroup.id, rowId, rumorId));
      } catch (err) {
        if (__DEV__) console.warn('[GroupConversationScreen] rekeyGroupMessage failed:', err);
      }
    },
    [group, myPubkey, setMessages],
  );

  const sendTextResult = useCallback(
    async (text: string, parent?: string): Promise<{ accepted: boolean; success: boolean }> => {
      const { group, myPubkey } = latestRef.current;
      if (!group || !myPubkey) return { accepted: false, success: false };

      // Optimistic bubble: painted synchronously from onRumorReady, before any
      // signing — the row id is captured synchronously (a `.current` box, not
      // narrowed away by TS closure analysis) so failure cleanup is reliable.
      const optimistic: { current: { row: GroupMessage; persisted: Promise<boolean> } | null } = {
        current: null,
      };
      // Boxed (like `optimistic`) so TS doesn't narrow it away in the closure.
      const settle: { current: ReturnType<typeof trackDelivery> | null } = { current: null };

      const result = await sendGroupMessage(
        {
          groupId: group.id,
          subject: group.name,
          memberPubkeys: group.memberPubkeys,
          text,
          replyTo: parent,
        },
        {
          onDeliveryFinalized: (delivery) => settle.current?.finalize(delivery),
          onRumorReady: ({ rumorId, kind, relays }) => {
            optimistic.current = appendOptimisticGroupRow(text, group, myPubkey, parent);
            if (optimistic.current) {
              settle.current = trackDelivery(optimistic.current.row.id, {
                eventId: rumorId,
                kind,
                relays,
              });
            }
          },
        },
      );
      settle.current?.settle(result);

      if (!result.success) {
        if (!optimistic.current) {
          Alert.alert('Send failed', result.error ?? 'Unknown error');
          return { accepted: false, success: false };
        }
        // The bubble stays, marked failed, with Re-publish in its info sheet.
        // Mark it once the storage write has settled, so that write's trailing
        // setMessages can't put back an unmarked row.
        await optimistic.current.persisted;
        // Replies need their parent restored; hidden vote rows must leave the tally.
        if (parent || parseVote(text)) {
          await removeOptimisticRow(optimistic.current.row.id, group);
          return { accepted: false, success: false };
        }
        await markOptimisticFailed(optimistic.current.row.id, group);
        return { accepted: true, success: false };
      }
      // Sent, but not saved locally: keep the draft so the user
      // can retry/refresh — pre-#1033 semantics.
      if (optimistic.current && !(await optimistic.current.persisted)) {
        alertSavedOnRelayOnly();
        return { accepted: false, success: false };
      }
      if (optimistic.current)
        await adoptRumorId(optimistic.current.row.id, result.rumorId, group, myPubkey);
      return { accepted: true, success: true };
    },
    [
      sendGroupMessage,
      appendOptimisticGroupRow,
      trackDelivery,
      markOptimisticFailed,
      removeOptimisticRow,
      alertSavedOnRelayOnly,
      adoptRumorId,
    ],
  );

  // The composer can clear a draft held by a failed bubble; a re-publish
  // needs confirmed success before it can replace the original failed row.
  const sendText = useCallback(
    async (text: string, parent?: string): Promise<boolean> =>
      (await sendTextResult(text, parent)).accepted,
    [sendTextResult],
  );
  const resendText = useCallback(
    async (text: string, failedRowId?: string): Promise<boolean> => {
      const { group } = latestRef.current;
      const result = await sendTextResult(text);
      // The replacement is sent and saved: the original goes from storage, then
      // the screen. If that delete fails it still leaves the screen, so its
      // Re-publish can't be tapped again to send a duplicate (a reload could
      // show it again, but only if storage failed right after a good write).
      if (result.success && failedRowId && group) {
        try {
          await removeGroupMessage(myPubkey, group.id, failedRowId);
        } catch (err) {
          if (__DEV__) console.warn('[GroupConversationScreen] removeGroupMessage failed:', err);
        }
        setMessages((prev) =>
          prev.filter((m) => m.id !== failedRowId && m.localId !== failedRowId),
        );
      }
      return result.success;
    },
    [sendTextResult, myPubkey, setMessages],
  );

  const sendFile = useCallback(
    async (file: EncryptedUpload, kind: 'voice' | 'image' | 'file'): Promise<boolean> => {
      if (!group || !myPubkey) return false;

      const fileText = encodeEncryptedFileUrl({
        url: file.url,
        mime: file.mime,
        keyHex: file.keyHex,
        nonceHex: file.nonceHex,
        filename: file.filename,
        size: file.size,
        sha256: file.sha256Hex,
      });

      const optimistic: { current: { row: GroupMessage; persisted: Promise<boolean> } | null } = {
        current: null,
      };
      // Boxed (like `optimistic`) so TS doesn't narrow it away in the closure.
      const settle: { current: ReturnType<typeof trackDelivery> | null } = { current: null };

      const result = await sendGroupMessage(
        {
          groupId: group.id,
          subject: group.name,
          memberPubkeys: group.memberPubkeys,
          file,
        },
        {
          onDeliveryFinalized: (delivery) => settle.current?.finalize(delivery),
          onRumorReady: ({ rumorId, kind: wireKind, relays }) => {
            optimistic.current = appendOptimisticGroupRow(
              fileText,
              group,
              myPubkey,
              undefined,
              wireKind,
            );
            if (optimistic.current) {
              settle.current = trackDelivery(optimistic.current.row.id, {
                eventId: rumorId,
                kind: wireKind,
                relays,
              });
            }
          },
        },
      );
      settle.current?.settle(result);

      if (!result.success) {
        if (kind === 'file') {
          Alert.alert(t('messageBubble.file'), t('messageBubble.fileShareFailed'));
        } else {
          const what = kind === 'image' ? 'image' : 'voice note';
          Alert.alert('Send failed', result.error ?? `Could not send ${what}.`);
        }
        if (optimistic.current) {
          await optimistic.current.persisted;
          await removeOptimisticRow(optimistic.current.row.id);
        }
        return false;
      }
      // Sent-but-not-saved: return false so the voice sheet / attach panel
      // stays open for retry, matching sendText's draft-keeping semantics.
      if (optimistic.current && !(await optimistic.current.persisted)) {
        alertSavedOnRelayOnly();
        return false;
      }
      if (optimistic.current) await adoptRumorId(optimistic.current.row.id, result.rumorId);
      return true;
    },
    [
      group,
      t,
      myPubkey,
      sendGroupMessage,
      appendOptimisticGroupRow,
      trackDelivery,
      removeOptimisticRow,
      alertSavedOnRelayOnly,
      adoptRumorId,
    ],
  );

  // A Marmot group's photos go the Marmot way (MIP-04) so White Noise and
  // other Marmot members can show them. Same optimistic-row semantics as sendText.
  const sendImage = useCallback(
    async (image: MarmotImage): Promise<boolean> => {
      if (!group || !myPubkey) return false;
      const optimistic: { current: { row: GroupMessage; persisted: Promise<boolean> } | null } = {
        current: null,
      };
      let rumorId: string | undefined;
      // Boxed (like `optimistic`) so TS doesn't narrow it away in the closure.
      const settle: { current: ReturnType<typeof trackDelivery> | null } = { current: null };
      const result = await sendMarmotImage(myPubkey, { groupId: group.id }, image, signEvent, {
        onDeliveryFinalized: (delivery) => settle.current?.finalize(delivery),
        onRumorReady: ({ text, eventId, kind, relays }) => {
          rumorId = eventId;
          optimistic.current = appendOptimisticGroupRow(text);
          if (optimistic.current) {
            settle.current = trackDelivery(optimistic.current.row.id, { eventId, kind, relays });
          }
        },
      });
      settle.current?.settle(result);
      if (!result.success) {
        Alert.alert(
          t('marmotSend.sendFailedTitle'),
          result.error ??
            t(
              image.mime.startsWith('audio/')
                ? 'marmotSend.couldNotSendVoice'
                : 'marmotSend.couldNotSendPhoto',
            ),
        );
        if (optimistic.current) {
          await optimistic.current.persisted;
          await removeOptimisticRow(optimistic.current.row.id);
        }
        return false;
      }
      if (optimistic.current && !(await optimistic.current.persisted)) {
        alertSavedOnRelayOnly();
        return false;
      }
      if (optimistic.current) await adoptRumorId(optimistic.current.row.id, rumorId);
      return true;
    },
    [
      group,
      myPubkey,
      signEvent,
      appendOptimisticGroupRow,
      trackDelivery,
      removeOptimisticRow,
      alertSavedOnRelayOnly,
      t,
      adoptRumorId,
    ],
  );

  // Preflight so the shared hook can skip an expensive encrypt+upload (voice /
  // image) when there's no valid group target to send to.
  const canSend = useCallback(() => !!group && !!myPubkey, [group, myPubkey]);

  // Memoise the strategy so the shared hook's callbacks (which depend on it)
  // keep stable identities across renders.
  const isMarmot = !!group && isMarmotGroupId(group.id);
  const confirmLocation = useCallback(
    (location: SharedLocation) =>
      confirmGroupLocationShare(location, () => {
        const { group, myPubkey } = latestRef.current;
        if (!group || !myPubkey) return null;
        return {
          group: group.name,
          groupId: group.id,
          memberPubkeys: group.memberPubkeys,
          myPubkey,
        };
      }),
    [],
  );

  // Composer sends only: polls, shares and re-publishes go out as built.
  const sendMessage = useMemo(
    () => async (text: string) => {
      const target = replyTo;
      const sent = await sendText(encodeMessage ? encodeMessage(text) : text, target);
      if (sent) onReplySent?.(target);
      return sent;
    },
    [encodeMessage, sendText, replyTo, onReplySent],
  );

  const strategy = useMemo(
    () => ({
      sendText,
      sendMessage,
      sendFile,
      ...(isMarmot ? { sendImage, gifEnvelope: true } : {}),
      canSend,
      confirmLocation,
    }),
    [sendText, sendMessage, sendFile, sendImage, isMarmot, canSend, confirmLocation],
  );

  const actions = useComposerActions({
    strategy,
    draft,
    setDraft,
    setAttachPanelOpen,
    setGifPickerOpen,
    setContactPickerOpen,
    setVoiceSheetOpen,
  });

  // Group-only: ReceiveSheet hands us a bolt11 via `onSendToGroup`. Post it
  // directly (NOT via the strategy's sendText, which raises its own Alert on
  // failure — ReceiveSheet shows a Toast too, and stacking both reads as a bug).
  const handleSendInvoiceToGroup = useCallback(
    async (payload: string): Promise<{ success: boolean; error?: string }> => {
      if (!group || !myPubkey) return { success: false, error: 'Group unavailable.' };

      const optimistic: { current: { row: GroupMessage; persisted: Promise<boolean> } | null } = {
        current: null,
      };

      const result = await sendGroupMessage(
        {
          groupId: group.id,
          subject: group.name,
          memberPubkeys: group.memberPubkeys,
          text: payload,
        },
        {
          onRumorReady: () => {
            optimistic.current = appendOptimisticGroupRow(payload);
          },
        },
      );

      if (!result.success) {
        // On failure: remove the optimistic row so the thread stays clean
        // (await the storage write first so it can't re-add the row).
        if (optimistic.current) {
          await optimistic.current.persisted;
          await removeOptimisticRow(optimistic.current.row.id);
        }
        return { success: false, error: result.error ?? 'Send failed' };
      }
      // Sent, but not saved locally: relay send is still a success (matches
      // pre-#1033 semantics — the invoice was published), but the user needs
      // to know it wasn't persisted, or a later reload can silently lose it.
      if (optimistic.current && !(await optimistic.current.persisted)) {
        alertSavedOnRelayOnly();
      }
      return { success: true };
    },
    [
      group,
      myPubkey,
      sendGroupMessage,
      appendOptimisticGroupRow,
      removeOptimisticRow,
      alertSavedOnRelayOnly,
    ],
  );

  // `sendText` is also exposed so poll-share / poll-vote can post arbitrary
  // serialised bodies through the same optimistic-append path as the composer.
  // `resendText` separately reports confirmed success and replaces a failed
  // original only after its fresh group send has succeeded.
  const fileComposer = useNip17FileComposer(
    isMarmot ? 'marmot' : 'nip17',
    sendFile,
    setAttachPanelOpen,
    canSend,
    group?.id,
  );
  return {
    ...actions,
    handlePickAndSendFile: fileComposer.pickFile,
    uploadingImage: actions.uploadingImage || fileComposer.uploading,
    sendText,
    handleSendInvoiceToGroup,
    resendText,
  };
}
