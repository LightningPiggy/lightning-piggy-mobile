// State behind the Ark wallet screen: is Ark available, is there a wallet,
// and the latest overview. Armed with useFocusEffect so a blurred screen
// stops polling (CLAUDE.md → Performance rules); the bark daemon keeps
// syncing natively while the app is open, so polling only refreshes what
// the screen shows.
import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import {
  createArkWallet,
  hasArkWallet,
  isArkAvailable,
  removeArkWallet,
  restoreArkWallet,
} from '../services/arkService';
import {
  getArkOverview,
  progressEmergencyExit,
  type ArkOverview,
} from '../services/arkMaintenance';

const POLL_MS = 30_000;

export type ArkWalletStatus = 'unavailable' | 'loading' | 'none' | 'ready' | 'error';

export interface ArkWalletState {
  status: ArkWalletStatus;
  overview: ArkOverview | null;
  /** Set when the last load failed (server unreachable, etc.). */
  error: string | null;
  busy: boolean;
  reload: () => Promise<void>;
  create: () => Promise<void>;
  restore: (phrase: string) => Promise<void>;
  remove: () => Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function useArkWallet(): ArkWalletState {
  const [status, setStatus] = useState<ArkWalletStatus>(() =>
    isArkAvailable() ? 'loading' : 'unavailable',
  );
  const [overview, setOverview] = useState<ArkOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const focused = useRef(false);

  const reload = useCallback(async () => {
    if (!isArkAvailable()) {
      setStatus('unavailable');
      return;
    }
    try {
      if (!(await hasArkWallet())) {
        if (focused.current) setStatus('none');
        return;
      }
      await progressEmergencyExit().catch(() => {});
      const next = await getArkOverview();
      if (!focused.current) return;
      setOverview(next);
      setError(null);
      setStatus('ready');
    } catch (err) {
      if (!focused.current) return;
      setError(message(err));
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void reload();
      const id = setInterval(() => void reload(), POLL_MS);
      return () => {
        focused.current = false;
        clearInterval(id);
      };
    }, [reload]),
  );

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        setStatus('loading');
        await reload();
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const create = useCallback(() => run(() => createArkWallet()), [run]);
  const restore = useCallback((phrase: string) => run(() => restoreArkWallet(phrase)), [run]);
  const remove = useCallback(
    () =>
      run(async () => {
        await removeArkWallet();
        setOverview(null);
      }),
    [run],
  );

  return { status, overview, error, busy, reload, create, restore, remove };
}
