/**
 * Concurrency tests for the reverse swap pay + claim orchestration.
 *
 * Boltz's reverse swap invoice is a HOLD invoice: the HTLC is accepted when
 * our payment reaches Boltz (which then locks up on-chain), but the payment
 * only settles after our claim reveals the preimage. `holdInvoiceSwap` models
 * exactly that, so a flow that awaits the payment before claiming would hang
 * here instead of completing.
 */

jest.mock('../services/boltzService', () => ({
  waitForLockup: jest.fn(),
  claimSwap: jest.fn(),
  fetchSwapStatus: jest.fn(),
}));
jest.mock('../services/swapRecoveryService', () => ({
  registerPendingSwap: jest.fn(async () => undefined),
  unregisterPendingSwap: jest.fn(async () => undefined),
  recordClaimedFromPreimage: jest.fn(async () => undefined),
  recordReverseSwapLegs: jest.fn(async () => undefined),
  recoverPendingSwaps: jest.fn(async () => undefined),
}));
jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));

import {
  payAndClaimReverseSwap,
  persistReverseSwap,
  SwapSettlingError,
  type PayAndClaimParams,
  type PersistedReverseSwap,
} from './reverseSwapPayClaim';
import * as boltzService from '../services/boltzService';
import * as swapRecoveryService from '../services/swapRecoveryService';
import * as SecureStore from 'expo-secure-store';
import { SwapServerTimeoutError } from '../services/boltzApi';
import { isSwapCreateTimeout } from './reverseSwapSend';

const CLAIM = { txId: 'claim-tx', outputSats: 28500 };
const SWAP = {
  id: 'sw1',
  invoice: 'lnbc30u1p...',
  onchainAmount: 29000,
  timeoutBlockHeight: 900_100,
  lockupAddress: 'bc1plockup',
  refundPublicKey: 'refund-pub',
  swapTree: {
    claimLeaf: { version: 0xc0, output: 'aa' },
    refundLeaf: { version: 0xc0, output: 'bb' },
  },
  preimage: 'preimage-hex',
  claimPrivateKey: 'claim-privkey',
  claimFeeRate: 3,
};
const LOCKUP = { txId: 'lockup-tx', vout: 0, amount: 29000, txHex: 'fixture' };

const waitForLockup = boltzService.waitForLockup as jest.Mock;
const claimSwap = boltzService.claimSwap as jest.Mock;
const fetchSwapStatus = boltzService.fetchSwapStatus as jest.Mock;

const named = (name: string, message = name) => Object.assign(new Error(message), { name });
const flush = () => new Promise((r) => setImmediate(r));

// Jest's sandboxed `process` never sees 'unhandledRejection', so instead the
// wallet/lockup promises record whether a rejection handler was attached —
// that is what keeps a later rejection from going unhandled.
const tracked: Tracked<unknown>[] = [];
class Tracked<T> extends Promise<T> {
  static get [Symbol.species]() {
    return Promise;
  }
  rejectionObserved = false;
  constructor(executor: ConstructorParameters<typeof Promise<T>>[0]) {
    super(executor);
    tracked.push(this);
  }
  then<A = T, B = never>(
    onFulfilled?: ((v: T) => A | PromiseLike<A>) | null,
    onRejected?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    if (onRejected) this.rejectionObserved = true;
    return super.then(onFulfilled, onRejected);
  }
}

/** A Boltz reverse swap paid by a wallet that sees a hold invoice. */
function holdInvoiceSwap() {
  const state = {
    paySignal: undefined as AbortSignal | undefined,
    onReplyTimeout: undefined as (() => void) | undefined,
    paymentSettled: false,
    // Boltz lock-up is triggered by our HTLC arriving; tests release it.
    releaseLockup: (() => undefined) as (lockup?: typeof LOCKUP) => void,
    failLockup: (() => undefined) as (e: Error) => void,
    settlePayment: (() => undefined) as (preimage: string) => void,
    failPayment: (() => undefined) as (e: Error) => void,
  };
  let htlcAccepted!: () => void;
  const htlc = new Promise<void>((r) => (htlcAccepted = r));
  const payInvoice = jest.fn(
    (
      _walletId: string,
      _invoice: string,
      opts: { signal: AbortSignal; onReplyTimeout: () => void },
    ) =>
      new Tracked((resolve, reject) => {
        state.paySignal = opts.signal;
        state.onReplyTimeout = opts.onReplyTimeout;
        state.settlePayment = (preimage) => {
          state.paymentSettled = true;
          resolve({ preimage });
        };
        state.failPayment = reject;
        htlcAccepted();
      }),
  );
  waitForLockup.mockImplementation(
    () =>
      new Tracked((resolve, reject) => {
        state.releaseLockup = (lockup = LOCKUP) => void htlc.then(() => resolve(lockup));
        state.failLockup = reject;
      }),
  );
  // Broadcasting the claim reveals the preimage; Boltz then settles the HTLC.
  claimSwap.mockImplementation(async (swap: typeof SWAP) => {
    state.settlePayment(swap.preimage);
    return CLAIM;
  });
  return { state, payInvoice };
}

let persisted: PersistedReverseSwap;
const run = (over: Partial<PayAndClaimParams> & Pick<PayAndClaimParams, 'payInvoice'>) =>
  payAndClaimReverseSwap({ persisted, walletId: 'w1', paymentSettleGraceMs: 5, ...over });

beforeEach(async () => {
  jest.clearAllMocks();
  tracked.length = 0;
  persisted = await persistReverseSwap(SWAP, 'bc1qdest');
  jest.clearAllMocks();
  // Boltz hasn't seen our HTLC yet (or holds it pre-lockup) — not proof of anything.
  fetchSwapStatus.mockResolvedValue('swap.created');
});

afterEach(async () => {
  await flush();
  expect(tracked.filter((p) => !p.rejectionObserved)).toEqual([]);
});

describe('persistReverseSwap', () => {
  it('writes the hardened recovery record, then indexes it', async () => {
    await persistReverseSwap(SWAP, 'bc1qdest');
    const [key, raw, opts] = (SecureStore.setItemAsync as jest.Mock).mock.calls[0];
    expect(key).toBe('boltz_swap_sw1');
    expect(JSON.parse(raw)).toEqual({
      id: 'sw1',
      preimage: 'preimage-hex',
      claimPrivateKey: 'claim-privkey',
      lockupAddress: 'bc1plockup',
      destinationAddress: 'bc1qdest',
      refundPublicKey: 'refund-pub',
      swapTree: SWAP.swapTree,
      onchainAmount: 29000,
      timeoutBlockHeight: 900_100,
      claimFeeRate: 3,
    });
    expect(opts).toEqual({ keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' });
    expect(
      (swapRecoveryService.registerPendingSwap as jest.Mock).mock.invocationCallOrder[0],
    ).toBeGreaterThan((SecureStore.setItemAsync as jest.Mock).mock.invocationCallOrder[0]);
  });

  it('records the exact recipient amount so recovery claims the same (#1175)', async () => {
    await persistReverseSwap({ ...SWAP, recipientAmount: 28640 }, 'bc1qdest');
    const raw = (SecureStore.setItemAsync as jest.Mock).mock.calls[0][1];
    expect(JSON.parse(raw)).toMatchObject({ onchainAmount: 29000, recipientAmount: 28640 });
  });

  it('rejects when the index write fails, so no payable handle exists', async () => {
    (swapRecoveryService.registerPendingSwap as jest.Mock).mockRejectedValueOnce(
      new Error('Invalid pending swap index'),
    );
    await expect(persistReverseSwap(SWAP, 'bc1qdest')).rejects.toThrow(
      'Invalid pending swap index',
    );
  });
});

describe('payAndClaimReverseSwap — hold invoice', () => {
  it('claims on the verified lockup while the payment is held, then the payment settles', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const onReplyTimeout = jest.fn();
    const stages: string[] = [];
    const done = run({ payInvoice, onReplyTimeout, onStage: (s) => stages.push(s) });

    await flush();
    // The payment is in flight and held; nothing has revealed the preimage.
    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(claimSwap).not.toHaveBeenCalled();
    expect(state.paymentSettled).toBe(false);

    state.releaseLockup();
    await expect(done).resolves.toBe(CLAIM);

    expect(claimSwap).toHaveBeenCalledWith(SWAP, LOCKUP, 'bc1qdest');
    expect(state.paymentSettled).toBe(true);
    expect(stages).toEqual(['payAndLockup', 'claimSwap', 'cleanup']);
    // Completed by the live flow — recovery was never needed.
    expect(swapRecoveryService.recoverPendingSwaps).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('boltz_swap_sw1');
    expect(swapRecoveryService.unregisterPendingSwap).toHaveBeenCalledWith('sw1');
    expect(swapRecoveryService.recordClaimedFromPreimage).toHaveBeenCalledWith(
      'preimage-hex',
      'claim-tx',
    );
    expect(swapRecoveryService.recordReverseSwapLegs).toHaveBeenCalledWith(
      'preimage-hex',
      'claim-tx',
      'sw1',
    );
    expect(onReplyTimeout).not.toHaveBeenCalled();
    expect(payInvoice).toHaveBeenCalledTimes(1);
  });

  it('never claims when the lockup fails verification (ambiguous payment → ReplyTimeoutError)', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.failLockup(new Error('Reverse lockup does not pay the verified address and amount'));
    await flush();
    // The wallet eventually gives up on the held payment.
    state.failPayment(named('ReplyTimeoutError', 'reply timeout'));
    await expect(done).rejects.toMatchObject({ name: 'ReplyTimeoutError' });
    expect(claimSwap).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('surfaces SwapSettlingError when the payment completed but the lockup failed', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.failLockup(new Error('Timeout waiting for swap sw1 after 900s'));
    await flush();
    state.settlePayment('preimage-hex');
    await expect(done).rejects.toBeInstanceOf(SwapSettlingError);
    expect(claimSwap).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('a swap-server timeout after the payment committed is a SwapSettlingError, never a create timeout', async () => {
    // SendSheet labels any SwapServerTimeoutError "Nothing was sent". Once the
    // payment is committed, a status poll timing out must not surface as one.
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.failLockup(new SwapServerTimeoutError(30_000));
    await flush();
    state.settlePayment('preimage-hex');
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SwapSettlingError);
    expect(isSwapCreateTimeout(error)).toBe(false);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('rejected payment before any lockup → "Boltz swap failed", no claim, record kept', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.failPayment(new Error('no route'));
    await expect(done).rejects.toThrow('Boltz swap failed: no route');
    expect(claimSwap).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(payInvoice).toHaveBeenCalledTimes(1);
  });

  it('a payment that throws synchronously is still a clean pre-commit failure', async () => {
    waitForLockup.mockReturnValue(new Promise(() => undefined));
    const payInvoice = jest.fn(() => {
      throw new Error('Not connected');
    });
    await expect(run({ payInvoice })).rejects.toThrow('Boltz swap failed: Not connected');
  });

  it('ambiguous payment before lockup rethrows ReplyTimeoutError and gates late callbacks', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const onReplyTimeout = jest.fn();
    const done = run({ payInvoice, onReplyTimeout });
    await flush();
    state.onReplyTimeout!();
    expect(onReplyTimeout).toHaveBeenCalledTimes(1);
    state.failPayment(named('ReplyTimeoutError', 'Wallet did not reply in time'));
    await expect(done).rejects.toMatchObject({ name: 'ReplyTimeoutError' });
    // A reply timeout firing after the flow settled must not repaint the caller.
    state.onReplyTimeout!();
    expect(onReplyTimeout).toHaveBeenCalledTimes(1);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('a lockup that beats a failing payment still claims — lockup evidence wins', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    claimSwap.mockResolvedValue(CLAIM);
    const done = run({ payInvoice });
    await flush();
    state.releaseLockup();
    await flush();
    state.failPayment(named('ReplyTimeoutError'));
    await expect(done).resolves.toBe(CLAIM);
  });

  it('claim failure → SwapSettlingError, record kept, held payment detached', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    claimSwap.mockRejectedValue(new Error('Boltz claim broadcast failed after 4 attempts'));
    const done = run({ payInvoice });
    await flush();
    state.releaseLockup();
    await expect(done).rejects.toBeInstanceOf(SwapSettlingError);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(swapRecoveryService.unregisterPendingSwap).not.toHaveBeenCalled();
    // Our wallet reply polling is stopped; its eventual rejection is observed.
    expect(state.paySignal?.aborted).toBe(true);
    state.failPayment(named('AbortError'));
  });

  it('returns after a bounded grace when the claimed payment is slow to settle', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    claimSwap.mockResolvedValue(CLAIM); // Boltz hasn't settled yet
    const done = run({ payInvoice, paymentSettleGraceMs: 20 });
    await flush();
    state.releaseLockup();
    await expect(done).resolves.toBe(CLAIM);
    expect(state.paymentSettled).toBe(false);
    expect(state.paySignal?.aborted).toBe(true);
    state.failPayment(named('ReplyTimeoutError')); // late, and harmless
  });
});

describe('payAndClaimReverseSwap — cancellation', () => {
  it('an already-aborted signal starts neither the payment nor the lockup watch', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const payInvoice = jest.fn();
    await expect(run({ payInvoice, signal: ctrl.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(payInvoice).not.toHaveBeenCalled();
    expect(waitForLockup).not.toHaveBeenCalled();
  });

  it('keeps a dispatched hold invoice in flight on pre-lockup cancellation', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const ctrl = new AbortController();
    const done = run({ payInvoice, signal: ctrl.signal });
    await flush();
    ctrl.abort();
    expect(state.paySignal?.aborted).toBe(true);
    state.failPayment(named('AbortError', 'Payment cancelled'));
    await expect(done).rejects.toMatchObject({ name: 'SwapSettlingError' });
    expect(claimSwap).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(payInvoice).toHaveBeenCalledTimes(1);
  });

  it('a cancel after the lockup is verified still claims (committed)', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const ctrl = new AbortController();
    claimSwap.mockImplementation(async (swap: typeof SWAP) => {
      ctrl.abort();
      state.settlePayment(swap.preimage);
      return CLAIM;
    });
    const done = run({ payInvoice, signal: ctrl.signal });
    await flush();
    state.releaseLockup();
    await expect(done).resolves.toBe(CLAIM);
  });
});

// A successful broadcast is final even if local bookkeeping fails.
it.each(['recordClaimedFromPreimage', 'recordReverseSwapLegs', 'unregisterPendingSwap'] as const)(
  'returns the claim when %s cleanup fails',
  async (method) => {
    const { state, payInvoice } = holdInvoiceSwap();
    jest
      .mocked(
        {
          recordClaimedFromPreimage: swapRecoveryService.recordClaimedFromPreimage,
          recordReverseSwapLegs: swapRecoveryService.recordReverseSwapLegs,
          unregisterPendingSwap: swapRecoveryService.unregisterPendingSwap,
        }[method],
      )
      .mockRejectedValueOnce(new Error('storage unavailable'));
    const done = run({ payInvoice });
    await flush();
    state.releaseLockup();
    await expect(done).resolves.toBe(CLAIM);
    if (method !== 'unregisterPendingSwap')
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  },
);
it('keeps recovery indexed when secret deletion fails after claim', async () => {
  const { state, payInvoice } = holdInvoiceSwap();
  jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('storage unavailable'));
  const done = run({ payInvoice });
  await flush();
  state.releaseLockup();
  await expect(done).resolves.toBe(CLAIM);
  expect(swapRecoveryService.unregisterPendingSwap).not.toHaveBeenCalled();
});
it('does not announce dispatch if the wallet throws synchronously', async () => {
  waitForLockup.mockReturnValue(new Promise(() => {}));
  const onPaymentDispatched = jest.fn();
  await expect(
    run({
      payInvoice: () => {
        throw new Error('disconnected');
      },
      onPaymentDispatched,
    }),
  ).rejects.toThrow('disconnected');
  expect(onPaymentDispatched).not.toHaveBeenCalled();
});

// #1167: a dead swap is only declared when Boltz's own status proves the hold
// invoice can never settle. Anything weaker keeps the #891 "still in flight".
describe('payAndClaimReverseSwap — dead swap (#1167)', () => {
  const expectRecordRetired = () => {
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('boltz_swap_sw1');
    expect(swapRecoveryService.unregisterPendingSwap).toHaveBeenCalledWith('sw1');
  };
  const expectRecordKept = () => {
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(swapRecoveryService.unregisterPendingSwap).not.toHaveBeenCalled();
  };

  it.each(['swap.expired', 'invoice.expired', 'transaction.failed', 'transaction.refunded'])(
    'Boltz fails the swap (%s) before lockup → nothing sent, without waiting on a lost wallet reply',
    async (status) => {
      const { state, payInvoice } = holdInvoiceSwap();
      const done = run({ payInvoice });
      await flush();
      // The wallet's reply never arrives; Boltz's status watch reports the failure.
      state.failLockup(new Error(`Swap failed with status: ${status}`));
      const error = await done.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('Error');
      expect((error as Error).message).toBe(
        `Boltz swap failed: Boltz reports ${status}; the Lightning payment never settled, nothing was sent`,
      );
      expect(claimSwap).not.toHaveBeenCalled();
      expectRecordRetired();
      // Reply polling is stopped; the late rejection is observed, not unhandled.
      expect(state.paySignal?.aborted).toBe(true);
      state.failPayment(named('AbortError'));
    },
  );

  it('ambiguous wallet reply + Boltz says the invoice expired → nothing sent', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    fetchSwapStatus.mockResolvedValue('invoice.expired');
    const done = run({ payInvoice });
    await flush();
    state.failPayment(named('ReplyTimeoutError', 'Wallet did not reply in time'));
    await expect(done).rejects.toThrow('Boltz swap failed: Boltz reports invoice.expired');
    expect(fetchSwapStatus).toHaveBeenCalledWith('sw1', expect.any(AbortSignal));
    expectRecordRetired();
  });

  it('ambiguous wallet reply + swap.created stays "in flight" — Boltz may hold the HTLC', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.failPayment(named('ReplyTimeoutError', 'Wallet did not reply in time'));
    await expect(done).rejects.toMatchObject({ name: 'ReplyTimeoutError' });
    expect(fetchSwapStatus).toHaveBeenCalledWith('sw1', expect.any(AbortSignal));
    expectRecordKept();
  });

  it.each(['transaction.mempool', 'transaction.confirmed', 'minerfee.paid'])(
    'ambiguous wallet reply + %s stays "in flight"',
    async (status) => {
      const { state, payInvoice } = holdInvoiceSwap();
      fetchSwapStatus.mockResolvedValue(status);
      const done = run({ payInvoice });
      await flush();
      state.failPayment(named('ReplyTimeoutError'));
      await expect(done).rejects.toMatchObject({ name: 'ReplyTimeoutError' });
      expectRecordKept();
    },
  );

  it('ambiguous wallet reply + unreachable Boltz stays "in flight"', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    fetchSwapStatus.mockRejectedValue(new Error('Boltz status check failed: 503'));
    const done = run({ payInvoice });
    await flush();
    state.failPayment(named('ReplyTimeoutError'));
    await expect(done).rejects.toMatchObject({ name: 'ReplyTimeoutError' });
    expectRecordKept();
  });

  it('a non-terminal lockup failure still waits for the wallet, then asks Boltz', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    fetchSwapStatus.mockResolvedValue('swap.expired');
    const done = run({ payInvoice });
    await flush();
    state.failLockup(new Error('Timeout waiting for swap sw1 after 900s'));
    await flush();
    expect(fetchSwapStatus).not.toHaveBeenCalled();
    state.failPayment(named('ReplyTimeoutError'));
    await expect(done).rejects.toThrow('Boltz swap failed: Boltz reports swap.expired');
    expectRecordRetired();
  });

  it('a wallet-rejected payment never consults Boltz and keeps the record', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.failPayment(new Error('no route'));
    await expect(done).rejects.toThrow('Boltz swap failed: no route');
    expect(fetchSwapStatus).not.toHaveBeenCalled();
  });

  it('a lockup seen before Boltz later fails still claims — committed wins', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const done = run({ payInvoice });
    await flush();
    state.releaseLockup();
    await expect(done).resolves.toBe(CLAIM);
    state.failLockup(new Error('Swap failed with status: swap.expired')); // no-op: already settled
  });

  it('still reports nothing sent when retiring the dead record fails', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('storage'));
    const done = run({ payInvoice });
    await flush();
    state.failLockup(new Error('Swap failed with status: swap.expired'));
    await expect(done).rejects.toThrow('Boltz swap failed: Boltz reports swap.expired');
    state.failPayment(named('AbortError'));
  });

  it('a user cancel after dispatch stays "still settling" and keeps the record', async () => {
    const { state, payInvoice } = holdInvoiceSwap();
    const ctrl = new AbortController();
    const done = run({ payInvoice, signal: ctrl.signal });
    await flush();
    ctrl.abort();
    state.failPayment(named('AbortError', 'Payment cancelled'));
    await expect(done).rejects.toMatchObject({ name: 'SwapSettlingError' });
    expectRecordKept();
  });
});
