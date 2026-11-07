import { shareCopies, type IncomingShare } from '../utils/incomingShare';
import { deleteShareCopies } from './sharedFiles';

/**
 * Hand-off between the share picker and the chat it opens (#1692). The picker
 * stages the share for one chat and one account, then navigates; that chat's
 * composer takes it (prefilling text, staging images for the user to send).
 * The chat may already be open — navigation then reuses its screen — so
 * composers subscribe rather than only reading on mount.
 *
 * Nothing here sends: the composer only prefills, and the user taps Send.
 */

/** A share nobody opened within this window is dropped, files and all. */
export const PENDING_SHARE_TTL_MS = 10 * 60_000;

interface PendingShare {
  target: string;
  /** Active account (hex pubkey) when the user picked the chat. */
  owner: string;
  share: IncomingShare;
  at: number;
}

let pending: PendingShare | null = null;
const listeners = new Set<() => void>();

export function stagePendingShare(
  target: string,
  owner: string,
  share: IncomingShare,
  now = Date.now(),
): void {
  if (pending) deleteShareCopies(shareCopies(pending.share));
  pending = { target, owner: owner.toLowerCase(), share, at: now };
  for (const listener of [...listeners]) listener();
}

/**
 * The share staged for `target`, once. Returns null for any other chat. A share
 * staged under a different account (the user switched in between) or past its
 * TTL is dropped instead: it must only ever go out from the account that chose
 * the chat.
 */
export function takePendingShare(
  target: string,
  owner: string,
  now = Date.now(),
): IncomingShare | null {
  if (!pending || pending.target !== target) return null;
  const entry = pending;
  pending = null;
  if (entry.owner !== owner.toLowerCase() || now - entry.at > PENDING_SHARE_TTL_MS) {
    deleteShareCopies(shareCopies(entry.share));
    return null;
  }
  return entry.share;
}

export function subscribePendingShare(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Drop whatever is staged (and its files). */
export function clearPendingShare(): void {
  if (pending) deleteShareCopies(shareCopies(pending.share));
  pending = null;
}
