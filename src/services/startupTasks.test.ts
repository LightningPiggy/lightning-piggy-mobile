type Mod = typeof import('./startupTasks');

/** Simulated idle lag: requestIdleCallback fires this long after it's asked. */
const IDLE_LAG_MS = 50;

let mod: Mod;
let perf: typeof import('../utils/perfLog');
let start: number;
let fired: { name: string; at: number }[];

const g = globalThis as { requestIdleCallback?: unknown };
const originalRic = g.requestIdleCallback;

beforeEach(() => {
  jest.useFakeTimers();
  g.requestIdleCallback = (cb: () => void) => setTimeout(cb, IDLE_LAG_MS);
  jest.isolateModules(() => {
    // perf T0 (the slot anchor) = "app start" = now.
    perf = require('../utils/perfLog');
    perf.perfAnchor();
    mod = require('./startupTasks');
  });
  start = Date.now();
  fired = [];
});

afterEach(() => {
  mod.__resetStartupTasksForTests();
  g.requestIdleCallback = originalRic;
  jest.useRealTimers();
});

/** A task that records when it fires and returns `result`. */
const task = (name: string, slotMs: number, result?: () => unknown, minDelayMs?: number) => ({
  name,
  slotMs,
  minDelayMs,
  run: () => {
    fired.push({ name, at: Date.now() - start });
    return result?.();
  },
});

/** Advance fake time and flush the promise chains timers kick off. */
async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

describe('startup task scheduler', () => {
  it('fires each task at its slot (after idle), earliest slot first, whatever the registration order', async () => {
    mod.scheduleStartupTask(task('late', 8_000));
    mod.scheduleStartupTask(task('early', 3_000));
    mod.scheduleStartupTask(task('middle', 5_000));
    await advance(2_999);
    expect(fired).toEqual([]);
    await advance(20_000);
    expect(fired).toEqual([
      { name: 'early', at: 3_000 + IDLE_LAG_MS },
      { name: 'middle', at: 5_000 + IDLE_LAG_MS },
      { name: 'late', at: 8_000 + IDLE_LAG_MS },
    ]);
  });

  it('the production slots are distinct and ordered by how visible the work is', () => {
    const slots = Object.values(mod.STARTUP_SLOTS);
    expect(new Set(slots).size).toBe(slots.length);
    expect(Object.entries(mod.STARTUP_SLOTS).sort((a, b) => a[1] - b[1])[0][0]).toBe(
      'nostrRefresh',
    );
  });

  it('runs one task at a time: a due task waits for the running one to settle', async () => {
    let finish!: () => void;
    mod.scheduleStartupTask(
      task('slow', 1_000, () => new Promise<void>((resolve) => (finish = resolve))),
    );
    mod.scheduleStartupTask(task('next', 1_100));
    await advance(1_500);
    expect(fired.map((f) => f.name)).toEqual(['slow']);
    finish();
    await advance(IDLE_LAG_MS);
    expect(fired.map((f) => f.name)).toEqual(['slow', 'next']);
  });

  it('a never-settling task holds the queue for at most SETTLE_CAP_MS', async () => {
    mod.scheduleStartupTask(task('hang', 1_000, () => new Promise(() => {})));
    mod.scheduleStartupTask(task('after', 1_000));
    await advance(10_000);
    expect(fired).toEqual([
      { name: 'hang', at: 1_000 + IDLE_LAG_MS },
      { name: 'after', at: 1_000 + IDLE_LAG_MS + mod.SETTLE_CAP_MS + IDLE_LAG_MS },
    ]);
  });

  it('same slot: registration order, one idle wait each', async () => {
    mod.scheduleStartupTask(task('a', 2_000));
    mod.scheduleStartupTask(task('b', 2_000));
    await advance(5_000);
    expect(fired).toEqual([
      { name: 'a', at: 2_000 + IDLE_LAG_MS },
      { name: 'b', at: 2_000 + 2 * IDLE_LAG_MS },
    ]);
  });

  it('cancel before it fires drops the task; the rest still run on time', async () => {
    const cancel = mod.scheduleStartupTask(task('dropped', 1_000));
    mod.scheduleStartupTask(task('kept', 2_000));
    cancel();
    await advance(5_000);
    expect(fired).toEqual([{ name: 'kept', at: 2_000 + IDLE_LAG_MS }]);
  });

  it('cancel while waiting for idle drops the task too', async () => {
    const cancel = mod.scheduleStartupTask(task('dropped', 1_000));
    mod.scheduleStartupTask(task('kept', 1_000));
    await advance(1_000); // slot reached, idle wait in flight
    cancel();
    await advance(5_000);
    expect(fired.map((f) => f.name)).toEqual(['kept']);
  });

  it('a task registered after its slot (mid-session sign-in) waits its minDelayMs floor', async () => {
    await advance(60_000);
    start = Date.now();
    mod.scheduleStartupTask(task('session', 3_000, undefined, 3_000));
    mod.scheduleStartupTask(task('noFloor', 1_000));
    await advance(10_000);
    expect(fired).toEqual([
      { name: 'noFloor', at: IDLE_LAG_MS },
      { name: 'session', at: 3_000 + IDLE_LAG_MS },
    ]);
  });

  it('a throwing or rejecting task does not wedge the queue', async () => {
    mod.scheduleStartupTask(
      task('throws', 1_000, () => {
        throw new Error('boom');
      }),
    );
    mod.scheduleStartupTask(task('rejects', 1_000, () => Promise.reject(new Error('nope'))));
    mod.scheduleStartupTask(task('fine', 1_000));
    await advance(5_000);
    expect(fired.map((f) => f.name)).toEqual(['throws', 'rejects', 'fine']);
  });

  it('emits a perfLog fire line per task', async () => {
    const log = jest.spyOn(perf, 'perfLog').mockImplementation(() => {});
    mod.scheduleStartupTask(task('marmotSession', 3_000));
    await advance(4_000);
    expect(log).toHaveBeenCalledWith('startup task marmotSession fired (slot 3000ms)');
  });

  it('falls back to a 0 ms timer when requestIdleCallback throws', async () => {
    g.requestIdleCallback = () => {
      throw new Error('native module missing');
    };
    mod.scheduleStartupTask(task('a', 1_000));
    mod.scheduleStartupTask(task('b', 1_000));
    await advance(1_010);
    expect(fired.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('falls back to a 0 ms timer when requestIdleCallback is missing', async () => {
    g.requestIdleCallback = undefined;
    mod.scheduleStartupTask(task('a', 1_000));
    await advance(999);
    expect(fired).toEqual([]);
    await advance(2);
    expect(fired.map((f) => f.name)).toEqual(['a']);
  });
});
