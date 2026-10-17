import { useCallback, useEffect, useRef } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { InteractionManager } from 'react-native';
import { useNostrDmInbox } from '../contexts/NostrContext';
import { useGroups } from '../contexts/GroupsContext';

/**
 * Opening a chat directly (from a notification, or a cold start that restores
 * it) skips the Messages list, which is what arms the live DM sub and catches
 * up on messages that arrived while the app was closed (#1325). This arms the
 * sub, then runs an inbox refresh once the chat has painted. The refresh's
 * own freshness TTL makes it a no-op when Messages refreshed recently; it is
 * aborted if the chat closes first. On a cold start the chat can mount before
 * sign-in finishes, so it waits for `isLoggedIn`.
 */
export function useDmCatchUpOnOpen(isLoggedIn: boolean): void {
  const { armLiveDmSub, refreshDmInbox } = useNostrDmInbox();
  const { effectiveWotTier } = useGroups();
  // Latest values, read once when the deferred refresh fires.
  const latest = useRef({ refreshDmInbox, includeNonFollows: effectiveWotTier === 'all' });
  useEffect(() => {
    latest.current = { refreshDmInbox, includeNonFollows: effectiveWotTier === 'all' };
  }, [refreshDmInbox, effectiveWotTier]);

  useEffect(() => {
    armLiveDmSub();
  }, [armLiveDmSub]);

  // On focus, not mount: a chat kept underneath another screen does nothing.
  useFocusEffect(
    useCallback(() => {
      if (!isLoggedIn) return;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | null = null;
      // After the open animation and first paint, like the Messages tab (#731).
      const handle = InteractionManager.runAfterInteractions(() => {
        timer = setTimeout(() => {
          const { refreshDmInbox: refresh, includeNonFollows } = latest.current;
          void refresh({ includeNonFollows, signal: controller.signal }).catch(() => {});
        }, 120);
      });
      return () => {
        handle.cancel();
        if (timer) clearTimeout(timer);
        controller.abort();
      };
    }, [isLoggedIn]),
  );
}
