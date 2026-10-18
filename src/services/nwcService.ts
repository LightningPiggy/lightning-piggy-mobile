import { sanitizeDisplayText } from '../utils/sanitizeDisplayText';
import {
  confirmListedInvoiceSettlement,
  needsInvoiceHistoryConfirmation,
  parseInvoiceSettlement,
  type InvoiceSettlement,
} from './nwcInvoiceSettlement';
import { confirmNwcPayment } from './nwcPaymentCompletion';
import { isSettledPayment, matchesPaymentHash } from '../utils/paymentCompletion';
import { listTransactionsWithRetry } from './nwcTransactionRetry';
import { hydratePaymentProofs, recordPaymentProof } from './paymentProofs';
import { NostrWebLNProvider } from '@getalby/sdk';
import type { Nip47GetInfoResponse } from '@getalby/sdk';
import { pinNip04IfNoInfoEvent, clearEncryptionDecision } from './nwcEncryption';
import { patchRelayPublish } from './nwcRelayPublishPatch';
import { createReplyTimeoutError, isConnectionError, throwIfAborted } from './nwcErrors';
// Per-wallet relay-health bookkeeping (reply-timeout cooldown + rate-limit
// back-off + the tri-state wallet health) lives in ./nwcRelayHealth so this
// service stays under the file-size cap and the health signal is unit-testable
// in isolation (#785/#786). The cooldown/health helpers are re-exported below
// to preserve the public API — consumers (WalletContext, tests) still import
// `isRelayInCooldown` from here.
import {
  isRateLimitError,
  isRelayDead,
  recordRateLimited,
  recordRelayOutcome,
} from './nwcRelayHealth';
import {
  beginConnectionAttempt,
  clearConnectionAttempt,
  CONNECTION_REPLACED_MESSAGE,
  hasPendingConnectionAttempt,
  isLatestConnectionAttempt,
  waitForNewestConnectionAttempt,
} from './nwcConnectionAttempts';

// Preserve the prior public API — these were defined + exported here before
// moving to ./nwcErrors; consumers (e.g. SendSheet) still import them from here.
export {
  createAbortError,
  createReplyTimeoutError,
  isConnectionError,
  isReplyTimeoutError,
  REPLY_TIMEOUT_ERROR_NAME,
} from './nwcErrors';

const providers = new Map<string, NostrWebLNProvider>();
const nwcUrls = new Map<string, string>();
// In-flight reconnect promises, keyed by walletId. Dedupes parallel
// `ensureConnected` callers (getBalance + makeInvoice + ...) so a single
// dropped WebSocket doesn't spawn N simultaneous `provider.enable()`
// handshakes, each holding the JS thread on the same slow relay. Pre-fix
// a NWC blip during HuntPiggyDetailScreen mount could pin the thread for
// 30 s while four reconnect attempts serialised through the same relay.
const reconnectsInFlight = new Map<string, Promise<NostrWebLNProvider>>();

// In-flight getBalance promises, keyed by walletId. Parallel callers
// (initial-connect getBalance + refreshActiveBalance + expectPayment
// tick) coalesce on the same request rather than firing three separate
// `provider.getBalance()` calls and tripling the chance of a NIP-47
// 'no info event' relay error. Cleared on settle so a later refresh
// gets a fresh response.
const getBalancesInFlight = new Map<string, Promise<number | null>>();

export { getWalletHealth, isRelayInCooldown } from './nwcRelayHealth';
export type { WalletConnectionHealth } from './nwcRelayHealth';

// Per-wallet timestamp of the most recent relay-publish failure. Used
// to fast-fail pay_invoice when the relay is unreachable (see #175).
// A "reply timeout" that lands within PUBLISH_FAILURE_FRESH_MS of a
// publish failure means the request never reached the wallet, so
// polling for the preimage is pointless — raise straight away.
const lastPublishFailureAt = new Map<string, number>();
const PUBLISH_FAILURE_FRESH_MS = 10_000;

function markPublishFailure(walletId: string): void {
  lastPublishFailureAt.set(walletId, Date.now());
}

function hasRecentPublishFailure(walletId: string): boolean {
  const ts = lastPublishFailureAt.get(walletId);
  if (!ts) return false;
  if (Date.now() - ts > PUBLISH_FAILURE_FRESH_MS) {
    lastPublishFailureAt.delete(walletId);
    return false;
  }
  return true;
}

async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 1000, label = 'operation' } = {},
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === attempts - 1) throw error;
      if (__DEV__)
        console.log(`[NWC] ${label} attempt ${i + 1} failed, retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
      delayMs *= 2; // exponential backoff
    }
  }
  throw new Error('unreachable');
}

function closeQuietly(provider: NostrWebLNProvider | undefined): void {
  try {
    provider?.close();
  } catch {}
}

export function validateNwcUrl(url: string): { valid: boolean; error?: string } {
  url = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
  if (parsed.protocol.toLowerCase() !== 'nostr+walletconnect:') {
    return { valid: false, error: 'URL must start with nostr+walletconnect://' };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(parsed.hostname)) {
    return { valid: false, error: 'Invalid pubkey in URL (must be 64 hex characters)' };
  }
  if (parsed.searchParams.getAll('relay').length === 0) {
    return { valid: false, error: 'Missing relay parameter' };
  }
  if (!parsed.searchParams.get('secret')) {
    return { valid: false, error: 'Missing secret parameter' };
  }
  return { valid: true };
}

export async function connect(
  walletId: string,
  nwcUrl: string,
  onEnabled?: () => void,
  isActive: () => boolean = () => true,
): Promise<{ success: boolean; balance?: number; error?: string }> {
  const validation = validateNwcUrl(nwcUrl);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  if (!isActive()) return { success: false, error: 'Connection superseded' };
  const attempt = beginConnectionAttempt(walletId);
  const isCurrent = () => isLatestConnectionAttempt(walletId, attempt) && isActive();
  let provider: NostrWebLNProvider | undefined;
  const discard = () => {
    closeQuietly(provider);
    if (provider && providers.get(walletId) === provider) providers.delete(walletId);
    clearConnectionAttempt(walletId, attempt);
    return { success: false, error: 'Connection superseded' };
  };
  try {
    // Close existing provider for this wallet if any
    const existing = providers.get(walletId);
    closeQuietly(existing);

    provider = new NostrWebLNProvider({
      nostrWalletConnectUrl: nwcUrl.trim(),
    });

    const currentProvider = provider;
    patchForegroundRelayPublish(provider, walletId);

    await withRetry(() => currentProvider.enable(), {
      label: 'connect',
      attempts: 3,
      delayMs: 2000,
    });
    if (!isCurrent()) return discard();
    await pinNip04IfNoInfoEvent(provider, walletId);
    if (!isCurrent()) return discard();

    // Store provider immediately after enable() — the relay connection is
    // established even if getBalance fails (e.g. slow relay response).
    providers.set(walletId, provider);
    nwcUrls.set(walletId, nwcUrl.trim());
    attempt.settle(); // wakes reconnect waiters; still in progress until the probe ends
    // Enable relay-pool keepalive pings so a dead link is noticed promptly
    // rather than lingering in TCP ESTABLISHED for ~2h (#654). Best-effort —
    // `client.pool` is an internal SDK shape and may be absent.
    // NB: we deliberately do NOT reset the responsiveness counter here —
    // re-opening the socket doesn't prove the relay answers. Status only
    // returns to "connected" once a real request succeeds (the initial
    // getBalance probe below), else a dead relay flaps Disconnected↔Connected
    // on every 30s reconnect.
    try {
      (provider as { client?: { pool?: { enablePing?: boolean } } }).client!.pool!.enablePing =
        true;
    } catch {
      // internal SDK shape unavailable — pings stay at the SDK default
    }

    // Guard the consumer callback so a UI-side throw can't unwind into our
    // catch block and falsely tear down a healthy provider.
    try {
      onEnabled?.();
    } catch (cbErr) {
      if (__DEV__) console.warn('[NWC] onEnabled callback threw — connection unaffected', cbErr);
    }

    if (!isCurrent()) return discard();
    // Try to get initial balance, but don't fail the connection if it times
    // out. Doubles as the relay-responsiveness probe (#654): an answer resets
    // the failure counter (→ Connected); a timeout/connection error advances it
    // (so a dead relay stays Disconnected instead of flapping).
    let balance: number | undefined;
    try {
      const b = await withRetry(() => currentProvider.getBalance(), {
        label: 'initial getBalance',
        attempts: 3,
        delayMs: 2000,
      });
      balance = b.balance;
      if (isCurrent()) recordRelayOutcome(walletId);
    } catch (e) {
      if (isCurrent()) recordRelayOutcome(walletId, e);
      if (__DEV__) console.log('[NWC] Initial getBalance failed, wallet still connected');
    }

    if (!isCurrent()) return discard();
    return { success: true, balance };
  } catch (error) {
    if (!isCurrent()) return discard();
    discard();
    // enable() couldn't reach any relay (full outage). Count it so the cooldown
    // (#656) engages — otherwise the 30s connection-check retries forever.
    recordRelayOutcome(walletId, error);
    providers.delete(walletId);
    nwcUrls.delete(walletId);
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, error: message };
  } finally {
    attempt.finish();
  }
}

export function disconnect(walletId: string): void {
  clearConnectionAttempt(walletId);
  reconnectsInFlight.delete(walletId);
  nwcUrls.delete(walletId);
  const provider = providers.get(walletId);
  if (provider) {
    closeQuietly(provider);
    providers.delete(walletId);
  }
  // Drop the failed-lookup LRU for this wallet so cache memory follows
  // wallet lifecycle (a removed wallet shouldn't keep its terminal-miss
  // entries pinned for the JS-runtime lifetime).
  clearFailedLookupCache(walletId);
  // Forget the cached encryption decision so a re-add re-probes fresh (#737).
  clearEncryptionDecision(walletId);
}

/**
 * Race a promise against a timeout, rejecting with a "reply timeout"
 * shaped Error if the deadline fires first. The underlying promise is
 * left to settle in the background — the SDK's own NIP-47 subscription
 * still cleans itself up on its own (longer) timeout, so the leak is
 * bounded.
 *
 * Used to put a tighter ceiling on `getBalance` than the @getalby/sdk's
 * hardcoded 10s `replyTimeout` for call sites where stale UI > ~2 s is
 * more disruptive than missing one balance refresh (e.g. the 1 s post-
 * payment poll loop in WalletContext — see #133).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      // A withTimeout fire means the relay never replied in time — a
      // reply-timeout, not a confirmed outcome. Reject with the typed error so
      // recordRelayOutcome() counts it toward relay-dead (#654/#656); a generic
      // Error slips through both isReplyTimeoutError and isConnectionError and
      // would reset the counter on the very "relay hung" case this targets.
      reject(createReplyTimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface GetBalanceOptions {
  /**
   * Per-call ceiling for the underlying NIP-47 round trip. When unset,
   * defers to the SDK's own 10 s `replyTimeout` AND keeps the 2-attempt
   * retry loop. When set, the call runs *without* retries so the ceiling
   * is a true upper bound (one attempt × replyTimeoutMs).
   *
   * Passed by the two tick-gated balance pollers in `WalletContext`: the
   * post-payment poll in `expectPayment` (`replyTimeoutMs: 2500`, gated by
   * a 1 s interval + an `inFlight` guard) and the demand-gated 10 s
   * foreground balance poll (`replyTimeoutMs: 8000`, gated by a 10 s
   * interval + `singleFlight`). For both, a stalled read is dropped and
   * retried on the next tick — far better than blocking the JS thread for
   * 22–115 s on a slow relay (#650). The one-shot / per-wallet manual
   * refresh paths deliberately stay on the default (with retries): they're
   * not tick-gated, so a slower-but-more-reliable read wins there. (#133, #650)
   */
  replyTimeoutMs?: number;
}

export async function getBalance(
  walletId: string,
  options: GetBalanceOptions = {},
): Promise<number | null> {
  // Dedupe parallel callers. The replyTimeoutMs path bypasses the
  // shared promise because each caller may want a different ceiling —
  // forcing them onto a single longer-timeout request would be wrong.
  if (options.replyTimeoutMs === undefined) {
    const pending = getBalancesInFlight.get(walletId);
    if (pending) return pending;
  }
  const __t0 = performance.now();
  const run = async (): Promise<number | null> => {
    const provider = await ensureConnected(walletId);
    if (!provider) return null;
    try {
      // When replyTimeoutMs is set, run a single attempt so the timeout is a true total ceiling (1 × replyTimeoutMs). Without it, retry twice on slow relays so a single timeout doesn't flash "Disconnected" / null balance — the SDK's own 10 s replyTimeout still bounds each attempt.
      const b = await withRetry(
        () => {
          const call = provider.getBalance();
          return options.replyTimeoutMs !== undefined
            ? withTimeout(call, options.replyTimeoutMs, `getBalance(${walletId})`)
            : call;
        },
        {
          label: `getBalance(${walletId})`,
          attempts: options.replyTimeoutMs !== undefined ? 1 : 2,
          delayMs: 1500,
        },
      );
      const __dt = performance.now() - __t0;
      if (__dt > 500) {
        console.log(
          `[PerfBlock] NWC.getBalance: ${Math.round(__dt)}ms (walletId=${walletId.slice(0, 8)}…)`,
        );
      }
      recordRelayOutcome(walletId);
      return b.balance;
    } catch (error) {
      const __dt = performance.now() - __t0;
      console.log(
        `[PerfBlock] NWC.getBalance FAILED after ${Math.round(__dt)}ms (walletId=${walletId.slice(0, 8)}…)`,
      );
      console.warn(`getBalance error for ${walletId}:`, error);
      recordRelayOutcome(walletId, error);
      return null;
    }
  };
  if (options.replyTimeoutMs !== undefined) return run();
  const promise = run().finally(() => {
    getBalancesInFlight.delete(walletId);
  });
  getBalancesInFlight.set(walletId, promise);
  return promise;
}

export async function makeInvoice(
  walletId: string,
  amount: number,
  memo?: string,
): Promise<string> {
  const provider = await ensureConnected(walletId);
  if (!provider) throw new Error('Not connected');
  try {
    // Retry on a slow/flaky relay so a single ~10s reply-timeout doesn't sink a
    // prize/voucher claim. makeInvoice was the one NWC method left bare —
    // getBalance/payInvoice/listTransactions already retry + record relay health
    // — so the claim path failed on the first timeout while everything else
    // recovered (see TROUBLESHOOTING → "NWC reply timeout"). The SDK's own ~10s
    // replyTimeout bounds each attempt; a retry may orphan an unpaid invoice on
    // the wallet, which simply expires — harmless.
    const invoice = await withRetry(
      () =>
        provider.makeInvoice({
          amount,
          defaultMemo: memo || 'Sent with Lightning Piggy',
        }),
      { label: `makeInvoice(${walletId})`, attempts: 2, delayMs: 1500 },
    );
    recordRelayOutcome(walletId);
    return invoice.paymentRequest;
  } catch (error) {
    recordRelayOutcome(walletId, error);
    throw error;
  }
}

/**
 * Apply the shared no-wait-for-OK relay patch (`nwcRelayPublishPatch`) with
 * the FOREGROUND failure handling: when the fire-and-forget publish rejects
 * (e.g. the relay is unreachable), record the timestamp per-walletId so
 * payInvoice can fast-fail instead of waiting for a preimage that's
 * never going to arrive (see #175).
 */
function patchForegroundRelayPublish(provider: NostrWebLNProvider, walletId: string): void {
  patchRelayPublish(provider, (err) => {
    console.warn('[NWC] Relay publish failed (fire-and-forget):', err);
    markPublishFailure(walletId);
    // A relay rejection (temp-ban / rate-limit / connectivity) should park
    // the relay so we stop publishing into a ban instead of looping on it
    // (#737). A `rate-limited` rejection gets its own publish-volume back-off
    // that a lucky read can't reset (#785); otherwise a connection error
    // feeds the reply-timeout cooldown.
    if (isRateLimitError(err)) recordRateLimited(walletId);
    else if (isConnectionError(err)) recordRelayOutcome(walletId, err);
  });
}

/**
 * Reconnect an NWC provider if the relay connection dropped.
 * Closes the old provider and creates a fresh one. If a newer connect() supersedes
 * it, adopt that provider so payInvoice still runs its lookup-before-retry; if the
 * wallet was disconnected / re-pointed instead, throw a connection error so the
 * payment outcome stays "unknown" rather than "failed".
 */
async function reconnect(
  walletId: string,
  isActive: () => boolean = () => true,
): Promise<NostrWebLNProvider> {
  if (!isActive()) throw new Error(CONNECTION_REPLACED_MESSAGE);
  const url = nwcUrls.get(walletId);
  if (!url) throw new Error('No NWC URL stored for reconnect');

  const replaced = providers.get(walletId);
  const attempt = beginConnectionAttempt(walletId);
  const provider = new NostrWebLNProvider({ nostrWalletConnectUrl: url });
  const isCurrent = () =>
    isLatestConnectionAttempt(walletId, attempt) && nwcUrls.get(walletId) === url && isActive();
  try {
    closeQuietly(replaced);
    patchForegroundRelayPublish(provider, walletId);
    await provider.enable();
    if (isCurrent()) await pinNip04IfNoInfoEvent(provider, walletId);
    if (isCurrent()) {
      providers.set(walletId, provider);
      return provider;
    }
  } catch (error) {
    if (isCurrent()) {
      closeQuietly(provider);
      throw error;
    }
  } finally {
    attempt.finish();
  }
  closeQuietly(provider);
  await waitForNewestConnectionAttempt(walletId);
  const newer = providers.get(walletId);
  if (isActive() && newer && newer !== replaced && nwcUrls.get(walletId) === url) return newer;
  throw new Error(CONNECTION_REPLACED_MESSAGE);
}

// Shared by ensureConnected and payInvoice's publish-failure retry so neither can
// supersede the other's handshake; cleared once settled so a later drop retries.
function reconnectOnce(
  walletId: string,
  isActive: () => boolean = () => true,
): Promise<NostrWebLNProvider> {
  if (!isActive()) return Promise.reject(new Error(CONNECTION_REPLACED_MESSAGE));
  let pending = reconnectsInFlight.get(walletId);
  if (!pending) {
    if (__DEV__) console.log('[NWC] Connection lost, reconnecting...');
    pending = reconnect(walletId, isActive).finally(() => {
      if (reconnectsInFlight.get(walletId) === pending) reconnectsInFlight.delete(walletId);
    });
    reconnectsInFlight.set(walletId, pending);
  }
  return pending;
}

/** True while a reconnect or a connect() (incl. its initial balance probe) is pending. */
export function isConnectionInProgress(walletId: string): boolean {
  return reconnectsInFlight.has(walletId) || hasPendingConnectionAttempt(walletId);
}

/**
 * Ensure the NWC provider is connected. Reconnect if the WebSocket dropped.
 * Returns null if no provider exists for this wallet.
 */
async function ensureConnected(
  walletId: string,
  isActive: () => boolean = () => true,
): Promise<NostrWebLNProvider | null> {
  if (!isActive()) return null;
  let provider = providers.get(walletId);
  if (!provider) return null;

  const client = provider.client;
  if (client && !client.connected && nwcUrls.has(walletId)) {
    provider = await reconnectOnce(walletId, isActive);
  }
  return isActive() ? provider : null;
}

const PAY_INVOICE_REPLY_TIMEOUT_MS = 90_000;

type Nip47Internals = {
  executeNip47Request: <T>(
    method: string,
    params: unknown,
    validator: (result: T) => boolean,
    timeoutValues?: { replyTimeout?: number; publishTimeout?: number },
  ) => Promise<T>;
};

async function sendPaymentWithTimeout(
  provider: NostrWebLNProvider,
  bolt11: string,
  amountMsats?: number,
): Promise<{ preimage: string }> {
  // Runtime guard — `executeNip47Request` is a private @getalby/sdk surface;
  // if a future SDK update removes it, fall back to the public sendPayment.
  const client = provider.client as unknown as Nip47Internals | undefined;
  if (!client || typeof client.executeNip47Request !== 'function') {
    // The public `provider.sendPayment(bolt11)` doesn't accept the
    // optional msats param NIP-47 defines for zero-amount invoices,
    // so we'd silently send a bolt11-amount-of-0 if we let this path
    // through. Fail loudly instead — caller can surface the error.
    if (amountMsats && amountMsats > 0) {
      throw new Error(
        'Amount-less bolt11 requires NIP-47 `amount` param — SDK fallback path does not support it',
      );
    }
    if (__DEV__)
      console.warn(
        '[NWC] executeNip47Request unavailable — falling back to public sendPayment (no per-call timeout)',
      );
    const fallback = await provider.sendPayment(bolt11);
    if (!fallback || typeof fallback.preimage !== 'string' || fallback.preimage.length === 0) {
      throw new Error('pay_invoice returned no preimage');
    }
    return { preimage: fallback.preimage };
  }
  // NIP-47 `pay_invoice` accepts an optional `amount` (in msats) for
  // zero-amount invoices — the wallet picks up the user-specified
  // amount at send time. Omit when null/undefined so amount-bearing
  // invoices behave exactly as before.
  const params: { invoice: string; amount?: number } = { invoice: bolt11 };
  if (amountMsats && amountMsats > 0) params.amount = amountMsats;
  const result = await client.executeNip47Request<{ preimage: string }>(
    'pay_invoice',
    params,
    // Validator: require a non-empty string preimage so { preimage: undefined }
    // can't be silently treated as success.
    (r) => !!r && typeof r.preimage === 'string' && r.preimage.length > 0,
    { replyTimeout: PAY_INVOICE_REPLY_TIMEOUT_MS },
  );
  return { preimage: result.preimage };
}

export interface PayInvoiceOptions {
  signal?: AbortSignal;
  onReplyTimeout?: () => void;
  /** Amount in millisats; only used for zero-amount invoices. */
  amountMsats?: number;
  /** Optional LUD-21 endpoint returned with this invoice. */
  verifyUrl?: string;
}

export async function payInvoice(
  walletId: string,
  bolt11: string,
  signalOrOptions?: AbortSignal | PayInvoiceOptions,
): Promise<{ preimage: string }> {
  const { preimage, confirmed } = await payInvoiceOnce(walletId, bolt11, signalOrOptions);
  // Proof of payment: lets the tx list show this send as settled even while
  // the wallet's own list_transactions still reports it pending. Only for a
  // confirmed result — a lookup can expose an UNPAID invoice's preimage (e.g.
  // an invoice issued by the same backend), which proves nothing.
  if (confirmed) recordPaymentProof(walletId, preimage);
  return { preimage };
}

async function payInvoiceOnce(
  walletId: string,
  bolt11: string,
  signalOrOptions?: AbortSignal | PayInvoiceOptions,
): Promise<{ preimage: string; confirmed: boolean }> {
  const options: PayInvoiceOptions =
    signalOrOptions && 'aborted' in signalOrOptions
      ? { signal: signalOrOptions as AbortSignal }
      : ((signalOrOptions as PayInvoiceOptions | undefined) ?? {});
  const { signal, onReplyTimeout, amountMsats } = options;
  throwIfAborted(signal);
  let provider = await ensureConnected(walletId);
  if (!provider) throw new Error('Not connected');
  const paymentHash = extractPaymentHash(bolt11);
  if (!paymentHash) throw new Error('Invoice has no payment hash');
  const sentAt = Date.now();
  const sendAndConfirm = (current: NostrWebLNProvider) =>
    confirmNwcPayment({
      provider: current,
      paymentHash,
      reply: () => sendPaymentWithTimeout(current, bolt11, amountMsats),
      signal,
      verifyUrl: options.verifyUrl,
      timeoutError: () => {
        if (hasRecentPublishFailure(walletId)) {
          return new Error("Couldn't reach your wallet: relay publish timed out");
        }
        onReplyTimeout?.();
        return createReplyTimeoutError();
      },
      onReplyError: (error) => {
        if (!(error instanceof Error) || !error.message.includes('reply timeout')) throw error;
        if (hasRecentPublishFailure(walletId)) {
          throw new Error("Couldn't reach your wallet: relay publish timed out");
        }
        onReplyTimeout?.();
      },
    });
  try {
    return await sendAndConfirm(provider);
  } catch (error) {
    // Propagate user-initiated cancel straight away.
    if ((error as Error)?.name === 'AbortError') throw error;
    throwIfAborted(signal);

    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes('failed to publish')) {
      // 'failed to publish' from nostr-tools usually means the event never
      // reached the wallet — but if the relay accepted then dropped the
      // ack, a blind retry would send a second NIP-47 request for the
      // same invoice and some wallets may pay twice. Always look up the
      // invoice first; only retry the payment if it isn't already settled
      // or in flight.
      if (__DEV__)
        console.log(
          '[NWC] Publish failed, checking invoice status before retry to avoid double-pay...',
        );
      provider = await reconnectOnce(walletId);
      throwIfAborted(signal);
      const paymentHash = extractPaymentHash(bolt11);
      if (paymentHash) {
        try {
          // 2500 ms ceiling — this is a pre-flight check before a
          // retry. A slow relay shouldn't block the retry; if the
          // wallet really has paid, the duplicate-payment guard in
          // the wallet itself catches it on the second attempt.
          const lookup = await withTimeout(
            provider.lookupInvoice({ paymentHash }),
            2500,
            `lookupInvoice(${walletId})`,
          );
          if (isSettledPayment(lookup) && matchesPaymentHash(lookup?.preimage, paymentHash)) {
            console.log('[NWC] Invoice already paid — returning existing preimage');
            if (__DEV__)
              console.log(`[NWC] payment confirmed via lookup in ${Date.now() - sentAt}ms`);
            return { preimage: lookup.preimage, confirmed: true };
          }
        } catch {
          // lookup failed — fall through to retry. The wallet would refuse
          // duplicate payment for the same payment_hash anyway.
        }
      }
      throwIfAborted(signal);
      return await sendAndConfirm(provider);
    }
    // The Alby SDK wraps a NIP-47 error response with no body as
    // `Nip47WalletError("unknown Error", "INTERNAL")` (see
    // node_modules/@getalby/sdk/dist/cjs/nwc.cjs:7006). LNbits has
    // been observed to do this when the wallet *did* process the
    // payment with its LND backend (LN balance dropped) but the
    // response back through Nostr was malformed. Look up the invoice
    // before treating it as a real failure — if the wallet can find
    // the preimage, the payment succeeded and we should return it.
    // See issue #481 — this was the underlying cause of the
    // deterministic first-attempt claim failure on every reverse swap.
    const errCode = (error as { code?: string })?.code;
    if (msg === 'unknown Error' || errCode === 'INTERNAL') {
      const paymentHash = extractPaymentHash(bolt11);
      if (paymentHash) {
        try {
          // 2500 ms cap — this is a one-shot disambiguation, not a
          // poll loop, but a stalled relay reply here delays surfacing
          // the real error to the user. Mirror the receive-side ceiling.
          const lookup = await withTimeout(
            provider.lookupInvoice({ paymentHash }),
            2500,
            `lookupInvoice(${walletId})`,
          );
          if (isSettledPayment(lookup) && matchesPaymentHash(lookup?.preimage, paymentHash)) {
            // `warn` (not `log`) so this survives the production
            // `transform-remove-console` strip — without it field logs
            // can't tell a benign Alby-SDK-wrapping case (wallet did
            // process the payment) from a real failure. `paid` is the
            // canonical settled signal (settled_at>0) — `preimage` alone
            // isn't, per the lookupInvoice notes below.
            console.warn(
              `[NWC] pay_invoice surfaced "${msg}" but lookup confirms paid + has preimage — returning it (paymentHash=${paymentHash.slice(0, 8)})`,
            );
            if (__DEV__)
              console.log(`[NWC] payment confirmed via lookup in ${Date.now() - sentAt}ms`);
            return { preimage: lookup.preimage, confirmed: true };
          }
          // No usable preimage — BUT the lookup's paid=false is NOT a
          // reliable "definitely failed" signal here. LNbits has been seen
          // to report unpaid inside the same ~2500 ms window the payment
          // actually settles (verified live in #891: the LN balance
          // dropped 25k while this very branch logged paid=false). Treat
          // this as status-UNKNOWN, not a failure — the throw below routes
          // it to the "still in flight / check before retry" UX.
          console.warn(
            `[NWC] pay_invoice "${msg}" + lookup returned no usable preimage (paid=${lookup?.paid === true ? 'true' : lookup?.paid === false ? 'false' : 'unknown'}) — payment status UNKNOWN (paymentHash=${paymentHash.slice(0, 8)})`,
          );
        } catch (lookupErr) {
          // lookup itself threw — most ambiguous case. We don't know if
          // the payment succeeded or not. Log so field diagnostics can
          // correlate, then fall through + re-throw the ORIGINAL error
          // so the caller decides. Do NOT retry the payment here —
          // would risk a double-pay on wallets that *did* process it.
          const lookupMsg =
            lookupErr instanceof Error
              ? lookupErr.message || lookupErr.toString()
              : String(lookupErr);
          console.warn(
            `[NWC] pay_invoice "${msg}" + lookupInvoice ALSO failed (${lookupMsg || 'no message'}) — payment status unknown (paymentHash=${paymentHash.slice(0, 8)})`,
          );
        }
      } else {
        console.warn(
          `[NWC] pay_invoice "${msg}" + could not extract paymentHash from bolt11 — payment status unknown`,
        );
      }
      // We hit the ambiguous Alby-SDK "unknown Error"/INTERNAL wrap and
      // could NOT positively confirm the payment settled. The outcome is
      // genuinely UNKNOWN — the lookup's paid=false above is unreliable in
      // this window (#891). Surfacing it as a hard failure invites a
      // double-pay (the user retries) and, for a Boltz reverse swap, the
      // sats may already be locked up with recovery pending. Throw a
      // ReplyTimeoutError so callers route to the "still in flight / check
      // before retry" UX instead of "Payment failed" (#891, mirrors #648).
      throw createReplyTimeoutError(
        'Wallet returned an ambiguous response; the payment may have gone through. Check your balance before retrying.',
      );
    }
    throw error;
  }
}

function extractPaymentHash(bolt11: string): string | null {
  try {
    // Simple bolt11 payment_hash extraction — it's tag 'p' (01 in bech32)
    // For reliability, decode with light-bolt11-decoder if available
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Keep this optional decoder lazy.
    const { decode } = require('light-bolt11-decoder');
    const decoded = decode(bolt11);
    const hashSection = decoded.sections?.find((s: { name: string }) => s.name === 'payment_hash');
    return hashSection?.value || null;
  } catch {
    return null;
  }
}

export async function getInfo(
  walletId: string,
  isActive: () => boolean = () => true,
): Promise<{ alias: string; lud16?: string } | null> {
  const provider = await ensureConnected(walletId, isActive);
  if (!provider) return null;
  try {
    const info: Nip47GetInfoResponse = await provider.getInfo();
    if (__DEV__) console.log('NWC getInfo response:', JSON.stringify(info));
    const alias = sanitizeDisplayText(info.alias, { maxLen: 64 });
    const lud16 = info.lud16;
    return { alias, lud16 };
  } catch (error) {
    console.warn('NWC getInfo failed:', error);
    return null;
  }
}

/**
 * The NIP-47 methods this connection grants (e.g. `make_invoice`), read from
 * the raw NWC client's `get_info`. Deliberately NOT the WebLN provider's
 * getInfo: that maps names to WebLN (`makeInvoice`) and, on failure, returns
 * a fake minimal `["sendPayment"]` that would read as "can't make invoices".
 * Resolves null when the wallet can't be asked right now (unknown ≠ no).
 */
export async function getWalletMethods(walletId: string): Promise<string[] | null> {
  const provider = await ensureConnected(walletId);
  if (!provider) return null;
  try {
    const info = await withTimeout(provider.client.getInfo(), 10_000, `getInfo(${walletId})`);
    return Array.isArray(info?.methods) ? info.methods.map(String) : null;
  } catch (error) {
    if (__DEV__) console.warn(`NWC get_info (methods) failed for ${walletId}:`, error);
    return null;
  }
}

export async function listTransactions(
  walletId: string,
  isActive: () => boolean = () => true,
): ReturnType<typeof listTransactionsWithRetry> {
  const provider = await ensureConnected(walletId, isActive);
  if (!provider) throw new Error(`NWC wallet ${walletId} not connected — cannot list transactions`);
  await hydratePaymentProofs(); // proofs from earlier sessions, before the list is mapped
  return listTransactionsWithRetry(
    walletId,
    provider,
    () => reconnectOnce(walletId, isActive),
    isActive,
  );
}

// A BOLT-11 payment hash is a SHA-256 digest — 64 hex chars.
const PAYMENT_HASH_RE = /^[0-9a-fA-F]{64}$/;

export function isValidPaymentHash(hash: string | null | undefined): hash is string {
  return typeof hash === 'string' && PAYMENT_HASH_RE.test(hash);
}

// Per-session cache of payment hashes the NWC backend has *terminally*
// refused (e.g. NIP-47 NOT_FOUND, or the SDK's "Missing/invalid
// payment_hash" input rejection). Skipping these on subsequent calls
// avoids flooding the Metro log every refresh and burning NWC request
// budget (#98). Transient errors (relay disconnects, timeouts,
// INTERNAL / RATE_LIMITED) are intentionally NOT cached so paid-status
// polling (ConversationScreen) and expectPayment detection
// (WalletContext) still settle when conditions recover.
// Per-wallet bounded LRU. Without a cap the cache grows monotonically
// for the JS-runtime lifetime — one user opening many tx-detail
// sheets, or a noisy backend returning many distinct terminal misses,
// could leak unbounded memory and permanently suppress lookups for
// those hashes until app restart. Per-wallet cap keeps total worst-
// case memory bounded by N_wallets × FAILED_LOOKUP_CAP entries.
const FAILED_LOOKUP_CAP = 500;
// Map iteration order is insertion order in JS, so we evict the
// oldest entry by deleting + re-inserting on access (LRU touch).
const failedLookupCache = new Map<string, Map<string, true>>();

function hasFailedLookup(walletId: string, paymentHash: string): boolean {
  const cache = failedLookupCache.get(walletId);
  if (!cache) return false;
  if (!cache.has(paymentHash)) return false;
  // LRU touch: re-insert so this entry moves to the tail.
  cache.delete(paymentHash);
  cache.set(paymentHash, true);
  return true;
}

function recordFailedLookup(walletId: string, paymentHash: string): void {
  let cache = failedLookupCache.get(walletId);
  if (!cache) {
    cache = new Map();
    failedLookupCache.set(walletId, cache);
  }
  // If already present, refresh its position (LRU touch).
  if (cache.has(paymentHash)) cache.delete(paymentHash);
  cache.set(paymentHash, true);
  // Evict oldest while over cap. Map.keys() yields in insertion order
  // so the first key is the oldest.
  while (cache.size > FAILED_LOOKUP_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drop the cache entry for a wallet — call from disconnect / wallet
 * removal so cache memory follows wallet lifecycle. */
export function clearFailedLookupCache(walletId: string): void {
  failedLookupCache.delete(walletId);
}

// Errors that mean "this hash isn't coming back from this backend".
// Anything else is treated as transient — caching transient failures
// would permanently silence valid paid-status polling once a single
// relay timeout slipped through.
function isTerminalLookupError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/missing payment_hash|invalid payment_hash|not[ _]?found/i.test(message)) {
    return true;
  }
  // NIP-47 error responses surface a `code` on the thrown error object.
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.toUpperCase() === 'NOT_FOUND') {
    return true;
  }
  return false;
}

// Read raw NIP-47 fields so settlement evidence survives the SDK boundary.
export interface LookupInvoiceOptions {
  /**
   * Per-call ceiling for the underlying NIP-47 round trip. When unset,
   * defers to the SDK's own ~10 s `replyTimeout`. When set, a timed-out
   * call fails fast so the caller's next poll tick can race a fresh
   * request rather than waiting on a slow reply.
   *
   * The receive-side `expectPayment` poll uses a 2500 ms ceiling.
   * The payment completion race uses the raw SDK lookup with the same
   * ceiling in `nwcPaymentCompletion`, starting before the pay reply timeout.
   */
  replyTimeoutMs?: number;
}

export async function lookupInvoice(
  walletId: string,
  paymentHash: string,
  options: LookupInvoiceOptions = {},
): Promise<InvoiceSettlement | null> {
  if (!isValidPaymentHash(paymentHash)) return null;
  if (hasFailedLookup(walletId, paymentHash)) return null;
  const provider = await ensureConnected(walletId);
  if (!provider) return null;
  try {
    const call = provider.client.lookupInvoice({ payment_hash: paymentHash });
    const result = await (options.replyTimeoutMs !== undefined
      ? withTimeout(call, options.replyTimeoutMs, `lookupInvoice(${walletId})`)
      : call);
    if (!needsInvoiceHistoryConfirmation(result))
      return parseInvoiceSettlement(result, paymentHash);
    if (!Number.isSafeInteger(result.created_at) || result.created_at <= 0) return null;
    try {
      const listing = provider.client.listTransactions({
        from: Math.max(0, result.created_at - 60),
        until: Math.floor(Date.now() / 1000),
        type: result.type === 'outgoing' ? 'outgoing' : 'incoming',
        unpaid: false,
        limit: 50,
      });
      const history = await (options.replyTimeoutMs !== undefined
        ? withTimeout(listing, options.replyTimeoutMs, `confirmInvoice(${walletId})`)
        : listing);
      return (
        confirmListedInvoiceSettlement(result, history.transactions, paymentHash) ?? { paid: null }
      );
    } catch {
      // An unavailable history cannot establish paid or unpaid.
      return { paid: null };
    }
  } catch (error) {
    if (isTerminalLookupError(error)) {
      recordFailedLookup(walletId, paymentHash);
    }
    console.warn(`lookupInvoice failed for ${walletId} (${paymentHash.slice(0, 12)}…):`, error);
    return null;
  }
}

/**
 * Raw WebSocket transport state — is the relay socket actually open? Unlike
 * `isWalletConnected`, this is NOT gated by relay-health, so a caller can tell
 * "socket up but relay not answering" (→ amber `degraded`) apart from "socket
 * down" (→ red `disconnected`). Feeds `getWalletHealth` (#786 review).
 */
export function isSocketConnected(walletId: string): boolean {
  const provider = providers.get(walletId);
  if (!provider) return false;
  const client = provider.client;
  return client?.connected ?? false;
}

export function isWalletConnected(walletId: string): boolean {
  // Transport "connected" can lie: a hung relay / dead link leaves the socket
  // in ESTABLISHED while nothing gets through. Treat a run of unanswered
  // requests as not-connected so the UI is honest and the 30s connection-check
  // triggers a reconnect (#654).
  return isSocketConnected(walletId) && !isRelayDead(walletId);
}
