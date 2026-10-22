import { AppState } from 'react-native';
import { yieldMacrotask } from '../utils/yieldingBatch';

/** Yield to the native event loop so UI interactions and paint can tick
 * between chunks of a synchronous decrypt loop (#177, #731).
 *
 * Why requestAnimationFrame instead of setTimeout(0):
 *   - `setTimeout(resolve, 0)` posts to the native timer queue; under load
 *     (83 active timers re-enqueued back-to-back by the decrypt loop) the
 *     Android Looper batches them into the same frame and fires them all
 *     inside a single `callTimers` JS→native→JS bridge call. The JS thread
 *     never actually returns to native between yields, inflating each
 *     "yield" to ~90 ms wall-clock (issue #731 audit Finding 2).
 *   - `requestAnimationFrame` is wired through the Choreographer vsync
 *     signal. Each RAF fires once per Choreographer tick; re-enqueueing
 *     from inside the callback schedules the NEXT tick, so the JS thread
 *     genuinely returns to native between iterations.
 *   - Do NOT use RN's `setImmediate`: RN shims it on top of
 *     `queueMicrotask`, which runs before the next task (no yield to
 *     native). Do NOT use `queueMicrotask` directly for the same reason.
 *   - `MessageChannel` is not reliably polyfilled in Hermes/RN.
 *
 * For the abort-aware scheduler in `createYieldScheduler` the RAF handle
 * is cancelable via `cancelAnimationFrame`, matching the
 * `clearTimeout` pattern used there. */
export function yieldToEventLoop(): Promise<void> {
  if (inBackground()) return yieldMacrotask();
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** After a send's `onRumorReady` has queued the optimistic bubble, give React
 * one frame to paint it before the send's signing / gift-wrap crypto (pure JS,
 * hundreds of ms) holds the JS thread. Without this the bubble — and the
 * cleared composer — only appeared once the send was done. No-op when nobody
 * painted anything (no hook). */
export async function paintOptimisticBubble(hooks?: { onRumorReady?: unknown }): Promise<void> {
  if (hooks?.onRumorReady) await yieldToEventLoop();
}

/** No frames are drawn while the app is backgrounded, so a RAF never fires
 * there: a loop yielding on it parks until the user reopens the app. Seen with
 * a live-location end marker sent from the background (#1300) — the NIP-17
 * send stalled between its recipient and self-copy wraps. Background loops
 * yield on a macro-task instead (nothing to paint, so #731 doesn't apply). */
const inBackground = () => AppState.currentState === 'background';

/** ~4 ms — under a quarter of a 60 fps frame (16.6 ms). The NIP-17 inbox
 * loops aim to stay under this many ms of unbroken JS work per yield. With the
 * old count-based yield (every 4 wraps) a slow path could still
 * blow past 50–200 ms in a single burst — enough to drop several
 * frames on tab-switch. See #532. */
export const DECRYPT_FRAME_BUDGET_MS = 4;

/** Cooperative-yield scheduler for the NIP-17 inbox loops (#532).
 *
 * Two improvements over the old `if (i % N === 0) await yieldToEventLoop()`
 * pattern:
 *
 * 1. **Time-budget yields.** We only pay for a `requestAnimationFrame`
 *    round-trip when wall-clock since the last yield exceeds
 *    `DECRYPT_FRAME_BUDGET_MS`. A run of cheap cache hits no longer
 *    forces a yield every Nth iteration even though there's been no
 *    blocking work. The count-based modulo still acts as a safety
 *    cap (set by the caller) so a pathological iteration that
 *    somehow underestimates its own runtime can't starve the thread.
 *
 * 2. **Hard-cancel on abort.** When the caller's `AbortSignal` fires
 *    mid-loop, an `abort` listener cancels the currently-pending RAF
 *    via `cancelAnimationFrame` and resolves the awaiter immediately.
 *    Without this, the loop would still drain one more vsync round-
 *    trip (plus whatever sync work follows it) before the next abort
 *    check — visible as a slug of pinned-thread time after a
 *    tab-switch blurs MessagesScreen.
 *
 * Returned object:
 * - `maybeYield()` — call once per loop iteration. No-op unless the
 *   frame budget is exceeded OR the safety-cap counter ticks.
 * - `yieldCount` — number of actual yields performed (perfLog).
 * - `dispose()` — detach the abort listener after the loop exits.
 */
export type YieldScheduler = {
  maybeYield: () => Promise<void>;
  readonly yieldCount: number;
  dispose: () => void;
};

export function createYieldScheduler(opts: {
  signal?: AbortSignal;
  /** Safety cap — always yield when iteration % safetyEvery === 0,
   * even if the frame budget hasn't been blown. */
  safetyEvery: number;
  /** ms of unbroken JS work before we force a yield. */
  budgetMs?: number;
  /** Cold-start mode (#788): yield via a `setTimeout(0)` macro-task instead
   * of `requestAnimationFrame`. RAF rides the Choreographer vsync signal,
   * which is the right primitive once the app is settled — but during cold
   * start the Choreographer hasn't stabilised, so RAF callbacks coalesce and
   * the decrypt loop runs 1.4–2.1 s synchronous bursts between actual yields
   * (the gaps Stev.ie measured). A macro-task drains on the next event-loop
   * tick regardless of vsync, so the loop reliably hands the thread back to
   * native (touch / render) between chunks while the app is still warming up.
   * The frame-budget gate below keeps the timer count low (one per ~budgetMs
   * of work, not one per iteration), so this does NOT reintroduce the #731
   * Looper timer-flood. Cryptography, dedup and ordering are untouched — only
   * the yield primitive changes. */
  coldStart?: boolean;
}): YieldScheduler {
  const { signal, safetyEvery, budgetMs = DECRYPT_FRAME_BUDGET_MS, coldStart = false } = opts;
  let iteration = 0;
  let yields = 0;
  let lastYieldAt = performance.now();
  let pendingHandle: ReturnType<typeof requestAnimationFrame> | null = null;
  let pendingReject: ((reason?: unknown) => void) | null = null;

  // On abort: cancel the in-flight RAF so the awaiter unwinds
  // immediately instead of waiting for the next vsync tick.
  const onAbort = () => {
    if (pendingHandle !== null) {
      cancelAnimationFrame(pendingHandle);
      pendingHandle = null;
    }
    if (pendingReject) {
      const reject = pendingReject;
      pendingReject = null;
      reject(new Error('aborted'));
    }
  };
  if (signal) {
    if (signal.aborted) {
      // Already aborted before the loop started — caller is expected
      // to check signal.aborted itself, but make maybeYield a no-op
      // resolver so we don't queue work.
    } else {
      signal.addEventListener('abort', onAbort);
    }
  }

  const maybeYield = async () => {
    iteration++;
    if (signal?.aborted) return;
    const now = performance.now();
    const overBudget = now - lastYieldAt >= budgetMs;
    const safetyHit = iteration % safetyEvery === 0;
    if (!overBudget && !safetyHit) return;
    yields++;
    if (coldStart || inBackground()) {
      // Cold start (#788): macro-task yield. `yieldMacrotask` owns its own
      // timer + abort-cancel, so the RAF pending-handle bookkeeping is
      // bypassed entirely on this path.
      await yieldMacrotask(signal);
    } else {
      await new Promise<void>((resolve, reject) => {
        pendingReject = reject;
        pendingHandle = requestAnimationFrame(() => {
          pendingHandle = null;
          pendingReject = null;
          resolve();
        });
      }).catch(() => {
        // Aborted — swallow; caller checks signal.aborted after maybeYield.
      });
    }
    lastYieldAt = performance.now();
  };

  const dispose = () => {
    if (signal) signal.removeEventListener('abort', onAbort);
    if (pendingHandle !== null) {
      cancelAnimationFrame(pendingHandle);
      pendingHandle = null;
    }
  };

  return {
    maybeYield,
    get yieldCount() {
      return yields;
    },
    dispose,
  };
}

/** Chunk size for yielding between decrypt attempts. Sized for the
 * nsec path: `nip04.decrypt` / `unwrapWrapNsec` are ~1 ms each on
 * mid-range mobile CPUs, so 15 iterations ≈ 15 ms of blocking work
 * per batch — just under a 60 fps frame budget. The Amber path uses
 * the same constant, but its decrypt is IPC-bound and already
 * yields per call, so the extra `setTimeout(0)` there is effectively
 * free. If you retune this, profile the nsec path with `Profiler`
 * in FriendsScreen as the canary. */
export const DECRYPT_YIELD_EVERY = 15;

/** Yield cadence for the kind-1059 (NIP-17 wrap) loops in
 * `refreshDmInbox`. Smaller than `DECRYPT_YIELD_EVERY` because this
 * counter ticks on EVERY wrap — cache hit, miss, follow-filter drop,
 * group-route, the lot — so even an inbox of pure cache hits still
 * yields the JS thread regularly. The cache-hit path itself is cheap
 * (~ms), but on a >1000-wrap inbox the bulk processing piles up to
 * tens of seconds of unbroken JS work without a periodic yield, which
 * starves UI events (back-tap appears frozen — #286). Lowered from 8
 * to 4 in 2026-05 — perf testing on a real Pixel showed the
 * post-cold-start "Send sheet feels frozen" window was dominated by
 * back-to-back NIP-17 inbox processing without enough JS-thread
 * breathing room for gorhom-bottom-sheet's open animation to schedule
 * frames. Halving this doubles yield frequency, drops the per-burst
 * blocking from ~8 ms to ~4 ms, and lets bottom-sheet opens stay
 * smooth during inbox drain.
 *
 * Lowered again 2026-05-16 from 4 → 2: tonight's instrumented Pixel
 * logs (issue #560) showed refreshDmInbox running for 8.6 s wall-clock
 * with 3 s heartbeat gaps stacking during the decrypt loop. Yielding
 * every 2 wraps cuts each per-burst block back to ~2 ms; the RAF
 * overhead is amortised across the still-significant per-wrap decrypt
 * work so the overhead is < 5%. */
export const NIP17_LOOP_YIELD_EVERY = 2;
