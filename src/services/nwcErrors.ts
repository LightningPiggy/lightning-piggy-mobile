// NWC error classification + abort/cancellation primitives, shared by the NWC
// service layer. Kept separate so nwcService stays focused on connection +
// command logic.

/** Standard DOMException-shape abort error: `name === 'AbortError'`.
 * Callers can detect via `error.name === 'AbortError'` or by checking
 * `signal.aborted` after await. */
export function createAbortError(message = 'Payment cancelled'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export const REPLY_TIMEOUT_ERROR_NAME = 'ReplyTimeoutError';

export function createReplyTimeoutError(
  message = 'Wallet did not reply in time; payment may still be in flight',
): Error {
  const err = new Error(message);
  err.name = REPLY_TIMEOUT_ERROR_NAME;
  return err;
}

export function isReplyTimeoutError(error: unknown): boolean {
  return (error as Error)?.name === REPLY_TIMEOUT_ERROR_NAME;
}

// True when the failure is a relay/transport connectivity problem rather
// than a confirmed payment outcome — e.g. the relay was unreachable
// ("Failed to connect to wss://…", NWC code OTHER) or a publish never
// completed. Like a reply-timeout, the payment status is UNKNOWN: it may
// well have settled. Callers must NOT present these as "Payment failed"
// (#648) — a user who trusts that may re-send and double-pay.
export function isConnectionError(error: unknown): boolean {
  const msg = (
    (error as { message?: string } | undefined)?.message ?? String(error ?? '')
  ).toLowerCase();
  return (
    msg.includes('failed to connect') ||
    msg.includes('publish timed out') ||
    msg.includes('publish failed') ||
    msg.includes('could not connect') ||
    msg.includes('network request failed') ||
    msg.includes('websocket') ||
    msg.includes('connection closed') ||
    msg.includes('connection lost') ||
    // Relay rate-limit / abuse rejection (e.g. CoinOS "temp-banned <ip>"). Treat
    // as a connectivity failure so the cooldown (#656) parks the relay and we
    // stop publishing into a ban instead of hammering it (#737). Match the
    // narrow "temp-banned" anchor, not bare "banned", so a wallet-side error
    // that happens to contain "banned" (e.g. "user account banned") still
    // surfaces as a confirmed failure to the user (Copilot review #738).
    msg.includes('temp-banned') ||
    msg.includes('rate-limit') ||
    msg.includes('rate limit')
  );
}

/**
 * The request never got an answer from the wallet service: our typed
 * reply-timeout, a relay connectivity error, OR the @getalby/sdk's own
 * `Nip47ReplyTimeoutError` / `Nip47PublishTimeoutError` / `Nip47PublishError`.
 * The SDK classes set no `name` and their messages ("reply timeout: event …",
 * "publish timeout: …", "failed to publish: …") slip past both matchers above,
 * so without this an SDK-level timeout read as "the wallet answered" and kept
 * the card green while the NWC provider was offline (#1768).
 */
export function isUnansweredError(error: unknown): boolean {
  if (isReplyTimeoutError(error) || isConnectionError(error)) return true;
  const msg = (error as { message?: string } | undefined)?.message ?? String(error ?? '');
  return /reply timeout|publish timeout|failed to publish/i.test(msg);
}

/**
 * NIP-47 error codes a wallet service sends back in a response. Deliberately an
 * allow-list: the SDK also attaches codes to errors it raises LOCALLY, before
 * anything is published — e.g. `Nip47UnsupportedEncryptionError`
 * (`UNSUPPORTED_ENCRYPTION`) — and those must not read as "the wallet answered"
 * (#1768 review). `RATE_LIMITED` is left out on purpose: it's handled as relay
 * back-off (`isConnectionError` / `isRateLimitError`), not as a healthy reply.
 */
const NIP47_RESPONSE_CODES = new Set([
  'NOT_IMPLEMENTED',
  'INSUFFICIENT_BALANCE',
  'QUOTA_EXCEEDED',
  'RESTRICTED',
  'UNAUTHORIZED',
  'INTERNAL',
  'OTHER',
  'PAYMENT_FAILED',
  'NOT_FOUND',
]);

/**
 * Did the wallet service actually respond, just with a NIP-47 error (e.g.
 * `NOT_IMPLEMENTED`, `INSUFFICIENT_BALANCE`, `NOT_FOUND`)? The SDK raises those
 * as `Nip47WalletError` carrying the response's `code`. Only allow-listed
 * response codes count. Errors raised locally carry no code ("Not connected",
 * AbortError, …) or a code outside the list (`UNSUPPORTED_ENCRYPTION`), and the
 * SDK's own timeouts / publish / network errors, which reuse `INTERNAL` /
 * `OTHER`, are excluded by `isUnansweredError`. None of those count as a reply
 * (#1768).
 */
export function isWalletAnswer(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && NIP47_RESPONSE_CODES.has(code) && !isUnansweredError(error);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

/** Sleep that rejects with AbortError if the signal fires, instead of
 * resolving on schedule. Without this the 5-minute poll loop below
 * ignores cancellation between polls. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Race a non-cancellable promise against an AbortSignal so the caller
 * can stop waiting even while the underlying SDK call keeps running.
 * The background promise is allowed to complete; its result is just
 * discarded if abort wins the race. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(createAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(createAbortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}
