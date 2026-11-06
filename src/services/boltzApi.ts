// Low-level Boltz HTTP transport shared by boltzService and boltzSwapStatus.
// Kept as a leaf module (no imports from either of those) so the status layer
// can reuse the timeout-aware fetch without creating an import cycle.

/** Default/legacy provider only; new swaps read swapBackendService settings. */
export const BOLTZ_API = 'https://api.boltz.exchange/v2';

/**
 * The swap server didn't answer within the request's deadline. Deliberately
 * NOT an `AbortError`: callers treat `AbortError` as "the user cancelled" and
 * stay silent, so a server timeout reported as one left the Send overlay
 * spinning forever on "Creating Boltz swap" (Eden's 173k swap, 2026-11-01).
 */
export class SwapServerTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`The swap server didn't respond within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = 'SwapServerTimeoutError';
  }
}

export function isSwapServerTimeoutError(error: unknown): error is SwapServerTimeoutError {
  return (error as Error)?.name === 'SwapServerTimeoutError';
}

/** Fetch with a timeout to prevent hanging on slow/unreachable APIs.
 * Exported for swapRecoveryService — its recovery pass is single-flight, so
 * one bare `fetch` hanging there used to block every future recovery trigger
 * for the whole session (swap audit finding, 2026-07-02). */
export function fetchWithTimeout(
  url: string,
  init?: RequestInit,
  timeoutMs?: number,
): Promise<Response>;
export function fetchWithTimeout<T>(
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  consume: (response: Response) => Promise<T>,
): Promise<T>;
export async function fetchWithTimeout<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 10000,
  consume?: (response: Response) => Promise<T>,
): Promise<Response | T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  // Honour an external signal passed via `init.signal` — link it to the
  // internal controller so a caller-driven cancel aborts the in-flight fetch
  // too, not just the internal timeout. (Without this the internal signal
  // would silently override the caller's.)
  const external = init?.signal ?? undefined;
  const onExternalAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Keep the deadline and caller cancellation linked until the consumer has
    // finished reading the body, not just until response headers arrive.
    return consume ? await consume(response) : response;
  } catch (error) {
    // Our own deadline fired (and the caller didn't cancel): report a
    // timeout, never an AbortError a caller would mistake for its cancel.
    if (timedOut && !external?.aborted) throw new SwapServerTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onExternalAbort);
  }
}
