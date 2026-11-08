import { perfLog, perfT0 } from '../utils/perfLog';

// Serial scheduler for deferred cold-start work. Several independent jobs
// (Marmot session, NIP-171 session, watcher push, Marmot push registration,
// swap recovery, the BTC Map cache parse) each used to wait their own ~3 s and
// so all fired in the same instant, stacking their JS-thread work on one
// frame. Here each gets a SLOT (its earliest fire time after app start), and
// the scheduler runs them one at a time: wait for the slot, wait for the JS
// thread to go idle, run, give the task up to SETTLE_CAP_MS to finish its
// async part, then move on. A slow (network-bound) task can't hold the queue
// longer than the cap; a fast one hands over straight away.
//
// Latency-sensitive work (the DM live sub, resume re-arms) does NOT go here.
// Slots are relative to app start (perf T0, anchored in index.ts) so a task
// registered later in the session (sign-in, account switch) runs after its
// own `minDelayMs` floor instead of a cold-start slot that has long passed.

/** Cold-start slots, ms after app start. Earlier = more user-visible. */
export const STARTUP_SLOTS = {
  /** Profile / contacts / relay-list refresh: cached copies already painted. */
  nostrRefresh: 1_500,
  /** Marmot (MLS) groups: new group messages land once this is up. */
  marmotSession: 3_000,
  /** NIP-171 groups: same, for the (rarer) NIP-171 groups. */
  nip171Session: 5_000,
  /** Boltz swap recovery: claims / refunds have hours of slack. */
  swapRecovery: 6_500,
  /** Server-side notification watcher registration: invisible on device. */
  watcherPush: 8_000,
  /** Marmot push token registration (MIP-05): invisible on device. */
  marmotPush: 10_000,
  /** BTC Map merchant cache parse; Explore / Map kick it on focus anyway. */
  placesHydration: 12_000,
} as const;

export interface StartupTask {
  /** Short stable name for the `[Perf]` fire line. */
  name: string;
  /** Earliest fire time, ms after app start (see STARTUP_SLOTS). */
  slotMs: number;
  /** Floor after registration, for tasks re-registered mid-session. */
  minDelayMs?: number;
  /** The work. A returned promise is awaited (capped) before the next task. */
  run: () => unknown;
}

/** Longest the queue waits on one task's promise before starting the next. */
export const SETTLE_CAP_MS = 2_000;
/** requestIdleCallback timeout: never wait longer than this for idle. */
const IDLE_TIMEOUT_MS = 1_000;

interface Entry {
  task: StartupTask;
  runAt: number;
  seq: number;
}

let queue: Entry[] = [];
let seq = 0;
let busy = false; // a task is waiting for idle, running or settling
let timer: ReturnType<typeof setTimeout> | null = null;

type IdleFn = (cb: () => void, opts: { timeout: number }) => unknown;

function whenIdle(cb: () => void): void {
  // RN installs requestIdleCallback lazily from a native module; if that ever
  // fails, fall back to a plain timer rather than wedging the whole queue.
  try {
    const ric = (globalThis as { requestIdleCallback?: IdleFn }).requestIdleCallback;
    if (typeof ric === 'function') {
      ric(cb, { timeout: IDLE_TIMEOUT_MS });
      return;
    }
  } catch {
    // fall through
  }
  setTimeout(cb, 0);
}

function next(): Entry | undefined {
  return queue.reduce<Entry | undefined>(
    (best, e) =>
      !best || e.runAt < best.runAt || (e.runAt === best.runAt && e.seq < best.seq) ? e : best,
    undefined,
  );
}

function pump(): void {
  if (busy) return;
  if (timer) clearTimeout(timer);
  timer = null;
  const entry = next();
  if (!entry) return;
  const wait = entry.runAt - Date.now();
  if (wait > 0) {
    timer = setTimeout(pump, wait);
    return;
  }
  busy = true;
  whenIdle(() => {
    // Cancelled while we waited for idle: hand over to whatever is next.
    if (!queue.includes(entry)) {
      busy = false;
      pump();
      return;
    }
    queue = queue.filter((e) => e !== entry);
    perfLog(`startup task ${entry.task.name} fired (slot ${entry.task.slotMs}ms)`);
    let result: unknown;
    try {
      result = entry.task.run();
    } catch (e) {
      if (__DEV__) console.warn(`[Startup] task ${entry.task.name} threw:`, e);
    }
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    const settled = Promise.race([
      Promise.resolve(result).catch((e) => {
        if (__DEV__) console.warn(`[Startup] task ${entry.task.name} failed:`, e);
      }),
      new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, SETTLE_CAP_MS);
      }),
    ]);
    void settled.then(() => {
      if (capTimer) clearTimeout(capTimer);
      busy = false;
      pump();
    });
  });
}

/**
 * Queue a deferred startup task. Returns a cancel function: cancelling a task
 * that hasn't started drops it; once it has started, the caller's own cleanup
 * (e.g. the `stop()` its run returned) is responsible for undoing it.
 */
export function scheduleStartupTask(task: StartupTask): () => void {
  const now = Date.now();
  const runAt = Math.max(perfT0() + task.slotMs, now + (task.minDelayMs ?? 0));
  const entry: Entry = { task, runAt, seq: seq++ };
  queue.push(entry);
  pump();
  return () => {
    if (!queue.includes(entry)) return;
    queue = queue.filter((e) => e !== entry);
    if (!busy) pump();
  };
}

/** Test-only: drop every queued task and reset the scheduler state. */
export function __resetStartupTasksForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  queue = [];
  busy = false;
}
