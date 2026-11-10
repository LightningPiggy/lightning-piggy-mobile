import { useCallback, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { idleScheduler } from '../utils/idleScheduler';
import { useFocusEffect } from '@react-navigation/native';

import { useNostr } from '../contexts/NostrContext';
import {
  reconcileKeyBackupReminders,
  shouldShowKeyBackupBanner,
  snoozeKeyBackupBanner,
} from '../services/keyBackupReminder';

// Off the startup / resume hot path (CLAUDE.md → AppState handlers stagger).
const STAGGER_MS = 3000;

/**
 * Weekly key-backup reminder (#1546), driven from the Wallets tab: keeps the
 * scheduled notifications in line with the accounts on this phone (staggered
 * after focus / resume), and reports whether the in-app fallback banner
 * should show for the active account (notifications not allowed).
 */
export function useKeyBackupReminder(): {
  visible: boolean;
  pubkey: string | null;
  dismiss: () => void;
} {
  const { isLoggedIn, pubkey, signerType, identities } = useNostr();
  const [banner, setBanner] = useState<{ pubkey: string | null; show: boolean }>({
    pubkey: null,
    show: false,
  });
  const accountsKey = useMemo(
    () =>
      identities
        .map((i) => `${i.pubkey}:${i.signerType}`)
        .sort()
        .join(','),
    [identities],
  );

  useFocusEffect(
    useCallback(() => {
      if (!isLoggedIn || !pubkey) return;
      let alive = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const checkBanner = () =>
        shouldShowKeyBackupBanner(pubkey, signerType)
          .then((show) => alive && setBanner({ pubkey, show }))
          .catch(() => undefined);
      const reconcile = () => {
        if (AppState.currentState !== 'active') return;
        // Account removal can wipe an anchor even if the same key is re-added,
        // and permission can change while backgrounded. Re-read both on every
        // focus / resume; reconciliation preserves unchanged OS reminders.
        void reconcileKeyBackupReminders();
      };
      const staggered = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          reconcile();
          void checkBanner();
        }, STAGGER_MS);
      };
      // The banner check is a few local reads — after the tab transition, so
      // returning from Back up your key clears it straight away.
      const handle = idleScheduler.runWhenIdle(() => void checkBanner());
      staggered();
      // Notifications may have been allowed / blocked in system settings.
      const sub = AppState.addEventListener('change', (state) => {
        if (timer) clearTimeout(timer);
        if (state === 'active') staggered();
      });
      return () => {
        alive = false;
        handle.cancel();
        if (timer) clearTimeout(timer);
        sub.remove();
      };
      // Registry changes must re-arm reconciliation even if the active account is unchanged.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isLoggedIn, pubkey, signerType, accountsKey]),
  );

  const dismiss = useCallback(() => {
    if (!pubkey) return;
    setBanner({ pubkey, show: false });
    void snoozeKeyBackupBanner(pubkey).catch(() => undefined);
  }, [pubkey]);

  return { visible: banner.show && banner.pubkey === pubkey && isLoggedIn, pubkey, dismiss };
}
