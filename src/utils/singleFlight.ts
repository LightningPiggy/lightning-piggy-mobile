// Wraps an async producer so that while one call is still pending, further calls
// are dropped (resolve to `undefined`) instead of starting a second run. Used to
// stop interval ticks stacking when the wrapped call outlasts the interval — e.g.
// a balance poll on a slow relay that takes longer than its tick cadence (#650) —
// and to stop a double-tapped Move running two transfers at once (#1778).
// Arguments are forwarded to `fn`.
export function singleFlight<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T | undefined> {
  let inFlight = false;
  return async (...args: A) => {
    if (inFlight) return undefined;
    inFlight = true;
    try {
      return await fn(...args);
    } finally {
      inFlight = false;
    }
  };
}
