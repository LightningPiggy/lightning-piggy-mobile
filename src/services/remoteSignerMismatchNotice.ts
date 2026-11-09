import { Toast } from '../components/BrandedToast';
import { RemoteSignerMismatchError } from './remoteSignedEvent';

/** One notice per burst: a wrong-account signer refuses every request in a row. */
export const MISMATCH_NOTICE_COOLDOWN_MS = 10_000;

let lastShownAt = -Infinity;

/**
 * Tell the user their remote signer answered for the wrong account (or with a
 * changed / invalid event) on paths that otherwise just fail quietly: follow,
 * relay lists, profile, zaps, relay AUTH, Blossom, Piglets (#1779). No-op for
 * any other error. Returns whether a toast was shown.
 */
export function noticeRemoteSignerMismatch(error: unknown, now = Date.now()): boolean {
  if (!(error instanceof RemoteSignerMismatchError)) return false;
  if (now - lastShownAt < MISMATCH_NOTICE_COOLDOWN_MS) return false;
  lastShownAt = now;
  Toast.show({ type: 'error', text1: error.message });
  return true;
}

export function __resetMismatchNoticeForTests(): void {
  lastShownAt = -Infinity;
}
