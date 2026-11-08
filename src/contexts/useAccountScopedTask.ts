import { useCallback, useEffect, useRef } from 'react';

/**
 * Ties a deferred, cancellable task (e.g. a startup-queue slot) to the account
 * it was scheduled for: it is cancelled as soon as the active account moves
 * off `owner` (switch, add-account login, logout). Returns `track(owner,
 * cancel)`; tracking a new task cancels the previous one. Once a task has
 * started, `cancel` is a no-op, so this only drops work that hasn't begun.
 */
export function useAccountScopedTask(
  pubkey: string | null,
): (owner: string, cancel: () => void) => void {
  const pending = useRef<{ owner: string; cancel: () => void } | null>(null);
  // The last committed account. Null until one commits, so a task tracked on
  // cold start before `setPubkey` lands isn't mistaken for a stale one.
  const committed = useRef<string | null>(null);

  useEffect(() => {
    committed.current = pubkey;
    if (pending.current && pending.current.owner !== pubkey) {
      pending.current.cancel();
      pending.current = null;
    }
  }, [pubkey]);

  return useCallback((owner, cancel) => {
    pending.current?.cancel();
    if (committed.current !== null && committed.current !== owner) {
      // The account already moved on while the caller was getting here.
      cancel();
      pending.current = null;
      return;
    }
    pending.current = { owner, cancel };
  }, []);
}
