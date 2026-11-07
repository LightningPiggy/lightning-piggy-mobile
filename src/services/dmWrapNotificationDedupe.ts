// Shared claim table so one gift wrap never yields two OS notifications.
// The foreground live DM sub (contexts/nostrLiveDmSub.ts) and the background
// watch (backgroundDmService.ts) can both be armed in the SAME JS context —
// the Android headless task runs in the app's existing React instance — so a
// fresh kind-1059 arrives at both callbacks. Whichever processes it first
// claims the wrap id here; the other skips its notification (#279).
//
// The background watch can't decrypt for a remote signer (Amber / NIP-46),
// so its alert is contentless — and would fire for wraps that never become a
// visible message (the self-copy of a message we sent, a stranger's wrap, a
// reaction, a Marmot invite). When the live sub is armed in the same context
// it CAN decrypt them, so the watch first gives it a moment: a wrap the live
// sub has decoded ("handled") is its call, not the watch's. A contentless
// alert that still went out is remembered, so the live sub can replace it
// with the real one — or retract it — once it has decrypted the wrap.
// An nsec watch, which CAN decrypt, defers the same way: a wrap the live sub
// has handled is not decrypted a second time on the one JS thread.
import { removeNotificationsWhere } from './notificationHistory';
import { cancelInFlightNotifications, dismissNotificationsFor } from './notificationService';

const claimed = new Set<string>();
const handled = new Set<string>();
const contentless = new Set<string>();
let liveSubsArmed = 0;

// Bounded so a long-lived watch session can't grow the sets unboundedly.
// Insertion-ordered Set: when full, evict the oldest half in one pass.
const MAX_CLAIMED = 512;

function addBounded(set: Set<string>, id: string): void {
  set.add(id);
  if (set.size <= MAX_CLAIMED) return;
  let toDrop = MAX_CLAIMED / 2;
  for (const old of set) {
    if (toDrop-- <= 0) break;
    set.delete(old);
  }
}

/**
 * True exactly once per non-empty wrap id — the caller that gets `true`
 * fires. A missing/empty id always returns `true` (no dedupe possible, and
 * bad data must never suppress a real notification).
 */
export function claimWrapNotification(wrapId: string | null | undefined): boolean {
  if (!wrapId) return true;
  if (claimed.has(wrapId)) return false;
  addBounded(claimed, wrapId);
  return true;
}

/** The live sub decoded this event — a gift wrap, a kind-4 DM or an order —
 * or already had it stored: whether it deserves an alert is now its decision. */
export function markWrapHandled(wrapId: string): void {
  if (wrapId) addBounded(handled, wrapId);
}

/** The live sub gave this wrap back undecided (torn down mid-wrap, a failed
 * write): any "handled" mark it picked up meanwhile — e.g. a re-opened sub
 * that saw the in-flight claim and took it for "already stored" — no longer
 * holds, so the background watch must handle it again. */
export function unmarkWrapHandled(wrapId: string): void {
  handled.delete(wrapId);
}

export function wasWrapHandled(wrapId: string): boolean {
  return handled.has(wrapId);
}

/** Count live DM subs armed in this JS context (+1 on open, -1 on teardown). */
export function noteLiveDmSubArmed(armed: boolean): void {
  liveSubsArmed = Math.max(0, liveSubsArmed + (armed ? 1 : -1));
}

/** A live DM sub (which can decrypt with any signer) runs in this context. */
export function isLiveDmSubArmed(): boolean {
  return liveSubsArmed > 0;
}

/** The background watch posted a contentless alert for this wrap. */
export function noteContentlessWrapAlert(wrapId: string): void {
  if (wrapId) addBounded(contentless, wrapId);
}

/** True once if a contentless alert went out for this wrap — the caller now
 * owns replacing or retracting it. */
export function takeContentlessWrapAlert(wrapId: string): boolean {
  return contentless.delete(wrapId);
}

/** Remove the contentless alert for a now-decrypted wrap — tray entry and
 * history row. Best-effort. */
export async function retractContentlessWrapAlert(owner: string, wrapId: string): Promise<void> {
  // One still being posted (awaiting permission / scheduling) is cancelled too.
  cancelInFlightNotifications((data) => data.wrapId === wrapId);
  await dismissNotificationsFor({ wrapId });
  await removeNotificationsWhere(owner, (e) => e.data.wrapId === wrapId);
}

/** Test hook: clear the claim table between tests. */
export function __resetForTests(): void {
  claimed.clear();
  handled.clear();
  contentless.clear();
  liveSubsArmed = 0;
}
