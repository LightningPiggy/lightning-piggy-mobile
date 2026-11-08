import { subscribePaymentSent } from './nwcPaymentNotifications';
import type { NostrWebLNProvider } from '@getalby/sdk';
import { completePayment } from '../utils/paymentCompletion';
import { createReplyTimeoutError, throwIfAborted } from './nwcErrors';
import { fetchPaymentVerification, isPaymentVerifyUrl } from './lnurlVerification';

/** Public SDK fallback lacks a per-call timeout. Bound our wait and clean up
 * the local timer on cancellation; the SDK can only discard its late reply. */
function boundedLookup<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      fn();
    };
    const cancel = () => finish(() => reject(new Error('Lookup cancelled')));
    const timer = setTimeout(() => finish(() => reject(new Error('Lookup timed out'))), 2500);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    request.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

/** Adapt the SDK's notification subscription and non-cancellable lookup to the race. */
export async function confirmNwcPayment(options: {
  provider: NostrWebLNProvider;
  paymentHash: string;
  reply: () => Promise<{ preimage: string }>;
  signal?: AbortSignal;
  verifyUrl?: string;
  onReplyError: (error: unknown) => void;
  timeoutError?: () => Error;
}) {
  const { provider, paymentHash } = options;
  const client = provider.client;
  const result = await completePayment({
    ...options,
    reply: () => options.reply(),
    timeoutError: options.timeoutError ?? createReplyTimeoutError,
    lookup: async (signal) => {
      throwIfAborted(signal);
      // The private per-call timeout closes the SDK's reply subscription too.
      const internals = client as unknown as {
        executeNip47Request?: (
          method: string,
          params: unknown,
          validator: (result: unknown) => boolean,
          timeouts: { replyTimeout: number },
        ) => Promise<import('../utils/paymentCompletion').PaymentCandidate>;
      };
      if (internals?.executeNip47Request) {
        return boundedLookup(
          internals.executeNip47Request(
            'lookup_invoice',
            { payment_hash: paymentHash },
            (value) => !!value,
            { replyTimeout: 2500 },
          ),
          signal,
        );
      }
      return boundedLookup(provider.lookupInvoice({ paymentHash }), signal);
    },
    verify: isPaymentVerifyUrl(options.verifyUrl)
      ? (signal) => fetchPaymentVerification(options.verifyUrl!, signal)
      : undefined,
    subscribe:
      typeof client?.getWalletServiceInfo === 'function'
        ? (accept, signal) => subscribePaymentSent(client, paymentHash, accept, signal)
        : undefined,
  });
  if (__DEV__) console.log(`[NWC] payment confirmed via ${result.source} in ${result.elapsedMs}ms`);
  // `answered`: did the WALLET confirm it over NIP-47 (pay reply, lookup, or
  // payment_sent notification)? A recipient's LUD-21 HTTP verify proves the
  // payment settled but says nothing about the wallet service being reachable,
  // so it must not refresh wallet health (#1768 review).
  return { preimage: result.preimage, confirmed: true, answered: result.source !== 'verify' };
}
