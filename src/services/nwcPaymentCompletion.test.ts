import type { NostrWebLNProvider } from '@getalby/sdk';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { confirmNwcPayment } from './nwcPaymentCompletion';
import { fetch } from 'expo/fetch';

const preimage = 'ab'.repeat(32);
const paymentHash = bytesToHex(sha256(hexToBytes(preimage)));
const pendingReply = () => new Promise<{ preimage: string }>(() => {});
const onReplyError = (error: unknown) => {
  throw error;
};
beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

it('uses raw lookup with a short SDK reply timeout and accepts settled_at', async () => {
  const executeNip47Request = jest.fn(async () => ({ settled_at: 123, preimage }));
  const provider = { client: { executeNip47Request } } as unknown as NostrWebLNProvider;
  const result = confirmNwcPayment({ provider, paymentHash, reply: pendingReply, onReplyError });
  await jest.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toEqual({ preimage, confirmed: true, answered: true });
  expect(executeNip47Request).toHaveBeenCalledWith(
    'lookup_invoice',
    { payment_hash: paymentHash },
    expect.any(Function),
    { replyTimeout: 2500 },
  );
});

it('bounds a hanging public lookup and continues the backoff', async () => {
  const lookupInvoice = jest
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce({ paid: true, preimage });
  const provider = { client: {}, lookupInvoice } as unknown as NostrWebLNProvider;
  const result = confirmNwcPayment({ provider, paymentHash, reply: pendingReply, onReplyError });
  await jest.advanceTimersByTimeAsync(10500);
  await expect(result).resolves.toEqual({ preimage, confirmed: true, answered: true });
  expect(lookupInvoice).toHaveBeenCalledTimes(2);
});

it('clears the public lookup timeout when cancellation wins', async () => {
  const lookupInvoice = jest.fn(() => new Promise(() => {}));
  const provider = { client: {}, lookupInvoice } as unknown as NostrWebLNProvider;
  const controller = new AbortController();
  const result = confirmNwcPayment({
    provider,
    paymentHash,
    reply: pendingReply,
    onReplyError,
    signal: controller.signal,
  });
  const assertion = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await jest.advanceTimersByTimeAsync(3000);
  controller.abort();
  await assertion;
});

// Expo fetch requires a native module; these SDK tests never use HTTPS verification.
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

it('a LUD-21 HTTP verify confirmation is not a wallet answer (#1768 review)', async () => {
  // The wallet never replies over NIP-47 (pending reply, unpaid lookup); only
  // the recipient's verify endpoint reports the payment settled.
  jest.mocked(fetch).mockResolvedValue({
    ok: true,
    json: async () => ({ settled: true, preimage }),
  } as unknown as Awaited<ReturnType<typeof fetch>>);
  const lookupInvoice = jest.fn(async () => ({ paid: false }));
  const provider = { client: {}, lookupInvoice } as unknown as NostrWebLNProvider;
  const result = confirmNwcPayment({
    provider,
    paymentHash,
    reply: pendingReply,
    onReplyError,
    verifyUrl: 'https://recipient.example/verify/abc',
  });
  await jest.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toEqual({ preimage, confirmed: true, answered: false });
});
