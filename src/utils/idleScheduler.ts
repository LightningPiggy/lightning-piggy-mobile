/** Defer non-urgent work until JS is idle; this does not track native animations. */
export const idleScheduler = {
  runWhenIdle(task: () => void): { cancel: () => void } {
    const id = requestIdleCallback(() => task());
    return { cancel: () => cancelIdleCallback(id) };
  },
};
