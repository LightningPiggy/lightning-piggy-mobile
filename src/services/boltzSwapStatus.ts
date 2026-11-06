// Boltz swap-status subscription layer.
//
// A single cohesive responsibility: watch a Boltz swap's status over a
// WebSocket (with a polling fallback), expose a real cancellation path so a
// caller can tear the WS/poller down on close/unmount, and classify the raw
// submarine-swap statuses into the coarse UI phases the Receive sheet renders.
//
// Extracted from boltzService so that file stays under the size cap and this
// concern is independently testable.

import { fetchWithTimeout } from './boltzApi';
import { getSwapBackendForId, swapWebSocketUrl } from './swapBackendService';
import { abortableSleep, createAbortError, throwIfAborted } from './nwcErrors';
import { closeSocketNowOrOnOpen } from './relaySocketGuard';

/**
 * End a swap-status socket we're done with. Detach its handlers first (a late
 * open must not send the subscribe or settle anything), then close it now or,
 * while it is still CONNECTING, as soon as it opens: React Native ignores
 * close() during the handshake, and an orphaned open socket holds one of
 * OkHttp's per-host slots, which the Boltz host's fetches share.
 */
function endSocket(ws: WebSocket): void {
  ws.onmessage = ws.onerror = ws.onclose = null;
  closeSocketNowOrOnOpen(ws);
}

/**
 * Subscribe to swap status updates via WebSocket, falling back to polling.
 * Calls onStatus for each status update until it returns true (terminal).
 *
 * Pass `signal` to tear the subscription down immediately (close the socket,
 * stop the poller) instead of leaving it alive until the terminal status or
 * `timeoutMs`. On abort the returned promise rejects with an AbortError.
 */
export async function waitForSwapStatus(
  swapId: string,
  isTerminal: (status: string, data: any) => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<any> {
  throwIfAborted(signal);
  const backend = await getSwapBackendForId(swapId);
  return new Promise((resolve, reject) => {
    let settled = false;
    // `fellBack` guards against onerror + onclose both starting a poller
    // (which happens on every WebSocket error — onerror fires, then onclose
    // fires a moment later). Track elapsed time properly from `start` so the
    // fallback poller gets the correct remaining window; previously we used
    // `timeoutMs - (Date.now() % timeoutMs)` which is wall-clock modulo and
    // bore no relation to actual elapsed time, making the fallback either
    // exit early or run far too long.
    let fellBack = false;
    // The live WebSocket, tracked so an abort can tear it down even from
    // outside the try block (e.g. an abort that fires while we're polling).
    let activeWs: WebSocket | undefined;
    const start = Date.now();
    const remaining = () => Math.max(0, timeoutMs - (Date.now() - start));

    // Full teardown: stop the timeout, detach the abort listener, and close
    // the socket. Called on every terminal path (resolve/reject/timeout/abort)
    // so we never leave a WebSocket or listener dangling.
    const teardown = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (activeWs) endSocket(activeWs);
      activeWs = undefined;
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      teardown();
      // Reject with AbortError so callers can distinguish a caller-driven
      // cancel (sheet closed/unmounted) from a genuine swap failure and stay
      // silent. The poll fallback, if running, sees the same signal and stops.
      reject(createAbortError('Swap watch cancelled'));
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      teardown();
      reject(new Error(`Timeout waiting for swap ${swapId} after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    // Already cancelled before we even started — settle immediately.
    if (signal?.aborted) {
      settled = true;
      clearTimeout(timer);
      reject(createAbortError('Swap watch cancelled'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    const fallbackToPoll = (ws?: WebSocket) => {
      if (settled || fellBack) return;
      fellBack = true;
      // The poller manages its own remaining window; drop the main timer and
      // the now-dead socket, but keep the abort listener so a cancel mid-poll
      // still rejects promptly.
      clearTimeout(timer);
      if (ws) endSocket(ws);
      activeWs = undefined;
      pollSwapStatus(swapId, isTerminal, remaining(), backend, signal)
        .then((data) => {
          if (!settled) {
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(data);
          }
        })
        .catch((err) => {
          if (!settled) {
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            reject(err);
          }
        });
    };

    // Try WebSocket first
    try {
      const ws = new WebSocket(swapWebSocketUrl(backend));
      activeWs = ws;
      let wsConnected = false;

      ws.onopen = () => {
        wsConnected = true;
        ws.send(JSON.stringify({ op: 'subscribe', channel: 'swap.update', args: [swapId] }));
        console.log(`[Boltz] WebSocket subscribed to swap ${swapId}`);
      };

      ws.onmessage = (event) => {
        if (settled) return;
        // Parse the frame first. A malformed / non-JSON frame is not a swap
        // failure — ignore it and keep listening.
        let data: any;
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : '');
          if (msg.channel !== 'swap.update' || !msg.args?.[0]) return;
          data = msg.args[0];
        } catch {
          return;
        }
        // `isTerminal` may intentionally throw (e.g. waitForLockup rejects on a
        // Boltz fail status). Let that propagate to a reject — mirroring the
        // polling path — instead of swallowing it, which would leave callers
        // hanging until the timeout on WS updates (#92).
        try {
          console.log(`[Boltz] WS swap ${swapId} status: ${data.status}`);
          if (isTerminal(data.status, data)) {
            settled = true;
            teardown();
            resolve(data);
          }
        } catch (err) {
          settled = true;
          teardown();
          reject(err);
        }
      };

      ws.onerror = () => {
        if (settled) return;
        if (!wsConnected) {
          console.warn('[Boltz] WebSocket failed, falling back to polling');
          fallbackToPoll(ws);
        }
      };

      ws.onclose = () => {
        if (settled) return;
        console.warn('[Boltz] WebSocket closed, falling back to polling');
        fallbackToPoll(ws);
      };
    } catch {
      // WebSocket constructor failed — fall back to polling
      fallbackToPoll();
    }
  });
}

/**
 * One-shot read of a swap's current Boltz status (`GET /swap/{id}` on the
 * swap's pinned backend). Throws on a non-OK response or a missing status, so
 * callers can tell "Boltz said X" apart from "couldn't ask".
 */
export async function fetchSwapStatus(swapId: string, signal?: AbortSignal): Promise<string> {
  const backend = await getSwapBackendForId(swapId);
  return fetchWithTimeout(`${backend}/swap/${swapId}`, { signal }, 10_000, async (res) => {
    if (!res.ok) throw new Error(`Boltz status check failed: ${res.status}`);
    const data = await res.json();
    if (typeof data?.status !== 'string') throw new Error('Boltz status missing');
    return data.status as string;
  });
}

/** Polling fallback for swap status. Honours `signal` so a caller-driven
 * cancel stops the loop between polls (and before the next fetch) instead of
 * running until the terminal status or timeout. */
async function pollSwapStatus(
  swapId: string,
  isTerminal: (status: string, data: any) => boolean,
  timeoutMs: number,
  backend: string,
  signal?: AbortSignal,
): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    throwIfAborted(signal);
    const res = await fetchWithTimeout(`${backend}/swap/${swapId}`, { signal });
    if (!res.ok) throw new Error(`Boltz status check failed: ${res.status}`);
    const data = await res.json();
    console.log(`[Boltz] Poll swap ${swapId} status: ${data.status}`);
    if (isTerminal(data.status, data)) return data;
    // Rejects with AbortError the moment the signal fires, so a cancel during
    // the 3s inter-poll wait is honoured immediately rather than 3s later.
    await abortableSleep(3000, signal);
  }
  throw new Error(`Timeout polling swap ${swapId}`);
}

/**
 * Phase a Boltz submarine-swap status into a coarse UI bucket.
 *
 * The Receive sheet doesn't need to render every Boltz state verbatim —
 * what the sender (and the recipient watching) cares about is "where in
 * the pipeline are we and is anything wrong?". This collapses the
 * 10+ raw statuses into 4 buckets the UI can drive a single label off.
 *
 * `failed` is terminal-error; the caller should surface a Refund affordance.
 * `complete` is terminal-success; the caller can dismiss.
 */
export type SubmarineSwapPhase =
  | 'awaiting-payment' // No on-chain tx detected yet
  | 'detected' // Lockup tx in mempool, waiting for Boltz to pay LN invoice
  | 'paying-invoice' // Boltz is paying the LN invoice
  | 'complete' // LN invoice paid + swap claimed
  | 'failed' // swap.expired / invoice.failedToPay / transaction.lockupFailed / refunded
  | 'unknown';

const SUBMARINE_FAIL_STATUSES = new Set<string>([
  'swap.expired',
  'transaction.refunded',
  'invoice.failedToPay',
  'transaction.lockupFailed',
  'transaction.failed',
]);

export function classifySubmarineSwapStatus(status: string | undefined): SubmarineSwapPhase {
  if (!status) return 'unknown';
  if (
    status === 'invoice.settled' ||
    status === 'transaction.claimed' ||
    status === 'invoice.paid'
  ) {
    return 'complete';
  }
  if (SUBMARINE_FAIL_STATUSES.has(status)) return 'failed';
  if (status === 'transaction.claim.pending' || status === 'invoice.pending') {
    return 'paying-invoice';
  }
  if (status === 'transaction.mempool' || status === 'transaction.confirmed') {
    return 'detected';
  }
  // swap.created / invoice.set / anything else = still awaiting the on-chain payment
  return 'awaiting-payment';
}

/**
 * Subscribe to submarine-swap status updates and emit a phase to the
 * caller every time it changes. Resolves when a terminal phase
 * (`complete` or `failed`) is reached, or when the timeout elapses.
 *
 * Wraps `waitForSwapStatus` so we get the same WebSocket-with-poll
 * fallback behaviour as the rest of the service.
 */
export async function watchSubmarineSwapStatus(
  swapId: string,
  onPhase: (phase: SubmarineSwapPhase, rawStatus: string, raw: any) => void,
  timeoutMs: number = 24 * 60 * 60 * 1000, // 24h default — submarine swaps wait for an external sender
  signal?: AbortSignal,
): Promise<{ phase: SubmarineSwapPhase; rawStatus: string; raw: any }> {
  console.log(
    `[Boltz] Watching submarine swap ${swapId} (timeout ${Math.round(timeoutMs / 1000)}s)`,
  );
  let lastPhase: SubmarineSwapPhase | null = null;

  // `signal` lets the caller (e.g. BoltzReceiveSheet on close/unmount) tear the
  // underlying WebSocket/poller down immediately instead of leaving it running
  // in the background until the terminal status or the 24h timeout. On abort
  // this rejects with an AbortError the caller is expected to swallow.
  const result = await waitForSwapStatus(
    swapId,
    (status, data) => {
      const phase = classifySubmarineSwapStatus(status);
      if (phase !== lastPhase) {
        lastPhase = phase;
        try {
          // Normalize so the `rawStatus: string` contract holds at runtime —
          // `data.status` can be missing on a malformed/early update.
          onPhase(phase, status ?? 'unknown', data);
        } catch (e) {
          console.warn('[Boltz] watchSubmarineSwapStatus onPhase callback threw:', e);
        }
      }
      return phase === 'complete' || phase === 'failed';
    },
    timeoutMs,
    signal,
  );

  return {
    phase: classifySubmarineSwapStatus(result?.status),
    rawStatus: result?.status ?? 'unknown',
    raw: result,
  };
}
