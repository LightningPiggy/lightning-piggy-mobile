import { deferPostPaymentRefresh, type InteractionScheduler } from './deferPostPaymentRefresh';

// A controllable fake of idleScheduler: it captures the queued task
// instead of running it, so a test can assert the refresh is scheduled
// off the interaction path (deferred) rather than run synchronously —
// the core guarantee of #859 / #828 (the overlay dismiss is never gated
// behind the refresh).
function makeFakeScheduler() {
  // Model real idleScheduler semantics: cancel() removes the task from
  // the queue so a later "interactions settled" tick (runQueued) does NOT run
  // it. This lets the cancel test verify the contract behaviourally, not just
  // that cancel was forwarded (Copilot review on #875).
  const tasks = new Set<() => void>();
  let cancelled = 0;
  const scheduler: InteractionScheduler = {
    runWhenIdle(task: () => void) {
      tasks.add(task);
      return {
        cancel() {
          cancelled += 1;
          tasks.delete(task);
        },
      };
    },
  };
  return {
    scheduler,
    runQueued: () => [...tasks].forEach((t) => t()),
    pendingCount: () => tasks.size,
    cancelledCount: () => cancelled,
  };
}

describe('deferPostPaymentRefresh', () => {
  it('does NOT run the refresh synchronously — it schedules it after interactions', () => {
    const refresh = jest.fn();
    const fake = makeFakeScheduler();

    deferPostPaymentRefresh(refresh, fake.scheduler);

    // The dismiss tap path is never blocked: nothing ran inline.
    expect(refresh).not.toHaveBeenCalled();
    expect(fake.pendingCount()).toBe(1);
  });

  it('runs the refresh once the interaction frame settles', () => {
    const refresh = jest.fn();
    const fake = makeFakeScheduler();

    deferPostPaymentRefresh(refresh, fake.scheduler);
    fake.runQueued();

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('cancel() drops a not-yet-run refresh (effect cleanup / unmount)', () => {
    const refresh = jest.fn();
    const fake = makeFakeScheduler();

    const handle = deferPostPaymentRefresh(refresh, fake.scheduler);
    handle.cancel();

    // cancel was forwarded to the scheduler handle...
    expect(fake.cancelledCount()).toBe(1);
    expect(fake.pendingCount()).toBe(0);

    // ...and crucially, a later "interactions settled" tick does NOT run the
    // cancelled refresh — the contract effect cleanup relies on.
    fake.runQueued();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('swallows a synchronous throw from the refresh so the UI cannot crash', () => {
    const refresh = jest.fn(() => {
      throw new Error('refresh boom');
    });
    const fake = makeFakeScheduler();

    deferPostPaymentRefresh(refresh, fake.scheduler);

    expect(() => fake.runQueued()).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('swallows a rejected promise from an async refresh', async () => {
    const refresh = jest.fn(() => Promise.reject(new Error('async boom')));
    const fake = makeFakeScheduler();

    deferPostPaymentRefresh(refresh, fake.scheduler);
    fake.runQueued();

    // Give the rejected promise a tick to settle; no unhandled rejection.
    await Promise.resolve();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('defaults to the real idleScheduler when no scheduler is passed', () => {
    const refresh = jest.fn();
    // Should not throw and should return a handle with cancel().
    const handle = deferPostPaymentRefresh(refresh);
    expect(typeof handle.cancel).toBe('function');
    handle.cancel();
  });
});
