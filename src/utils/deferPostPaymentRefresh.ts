import { idleScheduler } from './idleScheduler';

// Why this exists (#859, #828): when a payment lands (send-success or
// receive), the success/receive overlay paints, but the post-payment
// refresh (tx fetch, the tx-blob JSON.stringify, zap-sender resolution)
// runs synchronously on the same single JS thread that has to service the
// OK / tap-to-close press. The thread is busy, so the dismiss tap is
// dropped until the heavy work finishes — the overlay looks frozen, then
// snaps closed (same class as the cold-start DM freeze, #846).
//
// The dismiss must NEVER be gated behind the refresh. We push the refresh
// to an idle JS turn with idleScheduler.runWhenIdle:
// React paints the overlay and any queued touch (the OK tap) is serviced
// first, THEN the refresh runs and the balance / tx list / zaps catch up
// underneath. The user-facing guarantee: the moment the card is up, OK
// works instantly.

// The slice of idleScheduler we depend on — narrowed so tests can
// pass a fake scheduler without dragging in the whole RN module.
export interface InteractionScheduler {
  runWhenIdle(task: () => void): { cancel: () => void };
}

export interface DeferredRefreshHandle {
  // Cancel a not-yet-run deferred refresh (effect cleanup / unmount).
  cancel(): void;
}

// Schedule `refresh` for an idle JS turn without blocking the current tap. Returns a handle
// whose cancel() drops the task if it hasn't run yet.
//
// `refresh` is invoked fire-and-forget; if it returns a promise its
// rejection is swallowed (a failed background refresh must not crash the
// app — the next organic refresh picks the data up).
export function deferPostPaymentRefresh(
  refresh: () => void | Promise<unknown>,
  scheduler: InteractionScheduler = idleScheduler,
): DeferredRefreshHandle {
  const handle = scheduler.runWhenIdle(() => {
    try {
      const maybePromise = refresh();
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.catch(() => {});
      }
    } catch {
      // Non-fatal: swallow so a throwing refresh can't take down the UI.
    }
  });
  return { cancel: () => handle.cancel() };
}
