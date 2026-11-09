import { Toast } from '../components/BrandedToast';
import { getCurrentUserPubkey } from './nostrActiveAccount';
import { RemoteSignerMismatchError } from './remoteSignedEvent';

/** One notice per burst: a wrong-account signer refuses every request in a row. */
export const MISMATCH_NOTICE_COOLDOWN_MS = 10_000;

/** Per account, so account A's burst never hides account B's first refusal. */
const lastShownAt = new Map<string, number>();

/**
 * Tell the user their remote signer answered for the wrong account (or with a
 * changed / invalid event) on paths that otherwise just fail quietly: follow,
 * relay lists, profile, zaps, relay AUTH, Blossom, Piglets (#1779). No-op for
 * any other error, and for a late answer to an account that is no longer the
 * active one (the copy says "switch it to this account"). Returns whether a
 * toast was shown.
 */
export function noticeRemoteSignerMismatch(
  error: unknown,
  pubkey: string,
  now = Date.now(),
): boolean {
  if (!(error instanceof RemoteSignerMismatchError)) return false;
  if (getCurrentUserPubkey()?.toLowerCase() !== pubkey.toLowerCase()) return false;
  const last = lastShownAt.get(pubkey);
  if (last !== undefined && now - last < MISMATCH_NOTICE_COOLDOWN_MS) return false;
  lastShownAt.set(pubkey, now);
  Toast.show({ type: 'error', text1: error.message });
  return true;
}

export function __resetMismatchNoticeForTests(): void {
  lastShownAt.clear();
}
