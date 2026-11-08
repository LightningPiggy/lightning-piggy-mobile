import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { subscribeGroupMessages } from '../contexts/NostrContext';
import { loadGroupMessages, type GroupMessage } from '../services/groupMessagesStorageService';

/**
 * One focused subscription and one coalesced read for relay bursts. Returns
 * whether the first read is still pending.
 *
 * Live group messages only re-read local history — never the relays. The
 * screen used to call refreshDmInbox({ force: true }) on mount to drain
 * pending group rumors first, which blocked the JS thread for 3-25 s (#286).
 * The live subscription delivers wraps that land while the screen is open;
 * ones missed before it opened drain on the next Messages focus or
 * app-foreground refresh.
 */
export function useGroupConversationLoader(
  owner: string | null,
  groupId: string | undefined,
  setMessages: (messages: GroupMessage[]) => void,
): boolean {
  const [loading, setLoading] = useState(true);
  useFocusEffect(
    useCallback(() => {
      if (!groupId) return;
      let cancelled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let revision = 0;
      const load = async () => {
        const current = ++revision;
        try {
          const messages = await loadGroupMessages(owner, groupId);
          if (!cancelled && current === revision) setMessages(messages);
        } finally {
          if (!cancelled && current === revision) setLoading(false);
        }
      };
      void load().catch(() => {});
      const unsubscribe = subscribeGroupMessages((id) => {
        if (id !== groupId || timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          void load().catch(() => {});
        }, 150);
      });
      return () => {
        cancelled = true;
        clearTimeout(timer);
        unsubscribe();
      };
    }, [owner, groupId, setMessages]),
  );
  return loading;
}
