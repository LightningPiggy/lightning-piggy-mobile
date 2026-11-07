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
const stored = new Set<string>();
const contentless = new Set<string>();
const inFlight = new Set<string>();
let liveSubsArmed = 0;

// Bounded so a long-lived watch session can't grow the sets unboundedly.
// Insertion-ordered Set: when full, evict the oldest half in one pass.
const MAX_CLAIMED = 512;
// In-flight wraps get a much larger cap. Evicting one a live sub still holds
// (decrypting, or parked in the follow gate) would let a re-opened sub take it
// for "already stored" and silence the watch for a message nobody alerted for.
// The set isn't naturally bounded — an undecryptable wrap stays in it for the
// session — but a held wrap lives at most ~FOLLOW_GATE_TIMEOUT_MS (15 s), so
// evicting it needs thousands of new wraps inside that window.
const MAX_IN_FLIGHT = 4096;

function addBounded(set: Set<string>, id: string, max: number = MAX_CLAIMED): void {
  set.add(id);
  if (set.size <= max) return;
  let toDrop = max / 2;
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

/** The live sub DECIDED this event — a gift wrap, a kind-4 DM or an order:
 * it alerted for it, or there is nothing to alert (our own copy, a stranger,
 * a reaction). Final: a later give-back (teardown, failed write) never undoes
 * it, or the background sync would ping a duplicate / phantom for it. */
export function markWrapHandled(wrapId: string): void {
  if (!wrapId) return;
  inFlight.delete(wrapId);
  addBounded(handled, wrapId);
}

/** The live sub got this wrap and already had it stored (knownWrapIds), so it
 * shows in the app. NOT a decision: nobody may have alerted for it (stored
 * silently as not fresh, or ingested by a silent refresh). */
export function markWrapAlreadyStored(wrapId: string): void {
  if (!wrapId) return;
  inFlight.delete(wrapId);
  addBounded(stored, wrapId);
}

/** The live sub gave this wrap back (torn down mid-wrap, a failed write): an
 * "already stored" mark it picked up meanwhile — e.g. a re-opened sub that saw
 * the claim and took it for stored — no longer holds. A decision does: if it
 * already alerted (or found nothing to see), the wrap stays handled. */
export function unmarkWrapHandled(wrapId: string): void {
  inFlight.delete(wrapId);
  stored.delete(wrapId);
}

/** A live sub took this wrap in and hasn't decided or stored it yet (still
 * decrypting / routing, or held by the follow gate). Its id is already in the
 * shared knownWrapIds, so a re-opened sub must not take it for "stored". */
export function noteWrapInFlight(wrapId: string): void {
  if (wrapId) addBounded(inFlight, wrapId, MAX_IN_FLIGHT);
}

/** The wrap is now stored: a redelivery is "already stored" from here on. */
export function noteWrapStored(wrapId: string): void {
  inFlight.delete(wrapId);
}

export function isWrapInFlight(wrapId: string): boolean {
  return inFlight.has(wrapId);
}

/** Decided or already stored: the app has it, so a contentless alert or a
 * generic background-sync ping would be noise. */
export function wasWrapHandled(wrapId: string): boolean {
  return handled.has(wrapId) || stored.has(wrapId);
}

/** Decided only (alerted, or nothing to alert). The nsec watch skips just
 * these: an "already stored" wrap may never have been alerted for, and the
 * watch can decrypt it and apply its own freshness gate. */
export function wasWrapDecided(wrapId: string): boolean {
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
  stored.clear();
  contentless.clear();
  inFlight.clear();
  liveSubsArmed = 0;
}
