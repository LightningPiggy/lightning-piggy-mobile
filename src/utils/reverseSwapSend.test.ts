/**
 * Unit tests pinning executeReverseSwap's #891 error contract — the
 * "post-LN-commit must never surface as Payment failed" guarantee.
 *
 * The four catch branches each map to a different caller UX, so a
 * regression here silently reintroduces the #891 false-failure. We mock
 * the swap dependencies and assert the thrown error type per branch.
 * Pre-commit failures keep the lockup pending: Boltz only locks up once our
 * HTLC reaches it, so a payment that never left can't race a lockup.
 */

jest.mock('../services/boltzService', () => ({
  createReverseSwap: jest.fn(),
  waitForLockup: jest.fn(),
  claimSwap: jest.fn(),
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
// The receipt names the hold invoice's payment hash (#1179); the fixture
// invoice below is a placeholder string, so decode it by lookup.
jest.mock('./bolt11', () => ({
  paymentHashFromBolt11: (invoice: string) => (invoice === 'lnbc30u1p...' ? 'hash-sw1' : null),
}));
import {
  executeReverseSwap,
  isSwapSettlingError,
  SwapCreateTimeoutError,
  SwapSettlingError,
} from './reverseSwapSend';
import { SwapServerTimeoutError } from '../services/boltzApi';
import * as boltzService from '../services/boltzService';
import * as SecureStore from 'expo-secure-store';
import * as swapRecoveryService from '../services/swapRecoveryService';

const SWAP = {
  id: 'sw1',
  preimage: 'preimage-hex',
  claimPrivateKey: 'claim-privkey',
  lockupAddress: 'bc1plockup',
  refundPublicKey: 'refund-pub',
  swapTree: { foo: 'bar' },
  invoice: 'lnbc30u1p...',
  recipientAmount: 30000,
  invoiceAmount: 30612,
};

const neverLockup = () =>
  (boltzService.waitForLockup as jest.Mock).mockReturnValue(new Promise(() => undefined));

const named = (name: string, message = name) => {
  const e = new Error(message);
  e.name = name;
  return e;
};

const params = (over: Partial<Parameters<typeof executeReverseSwap>[0]> = {}) => ({
  walletId: 'w1',
  destinationAddress: 'bc1qdest',
  recipientSats: 30000,
  signal: new AbortController().signal,
  payInvoice: jest.fn(async () => ({ preimage: 'preimage-hex' })),
  onReplyTimeout: jest.fn(),
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  (boltzService.createReverseSwap as jest.Mock).mockResolvedValue(SWAP);
  (boltzService.waitForLockup as jest.Mock).mockResolvedValue({
    txId: 'tx',
    vout: 0,
    amount: 9000,
    txHex: 'fixture',
  });
  (boltzService.claimSwap as jest.Mock).mockResolvedValue({
    txId: 'claim-tx-id',
    outputSats: 30000,
  });
});

describe('executeReverseSwap — #891 error contract', () => {
  it('happy path: resolves with what the recipient got and what was paid', async () => {
    await expect(executeReverseSwap(params())).resolves.toEqual({
      claimTxId: 'claim-tx-id',
      recipientSats: 30000,
      paidSats: 30612,
      paymentHash: 'hash-sw1',
    });
    // Secrets persisted with hardened keychain accessibility...
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('boltz_swap_sw1', expect.any(String), {
      keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    });
    // ...then cleaned up on success.
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('boltz_swap_sw1');
  });

  it('rethrows ReplyTimeoutError (ambiguous pay → status unknown) and KEEPS the record', async () => {
    neverLockup();
    const payInvoice = jest.fn(async () => {
      throw named('ReplyTimeoutError', 'ambiguous');
    });
    await expect(executeReverseSwap(params({ payInvoice }))).rejects.toMatchObject({
      name: 'ReplyTimeoutError',
    });
    // Record left in place so swapRecoveryService can finish it.
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('throws SwapSettlingError when LN committed but the lockup/claim fails', async () => {
    (boltzService.waitForLockup as jest.Mock).mockRejectedValue(new Error('electrum code 1234'));
    let err: unknown;
    try {
      await executeReverseSwap(params());
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwapSettlingError);
    expect(isSwapSettlingError(err)).toBe(true);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it('keeps a dispatched payment in flight when cancelled before lockup', async () => {
    neverLockup();
    const payInvoice = jest.fn(async () => {
      throw named('AbortError', 'cancelled');
    });
    await expect(executeReverseSwap(params({ payInvoice }))).rejects.toMatchObject({
      name: 'SwapSettlingError',
    });
  });

  it('a POST-commit cancel surfaces as SwapSettlingError, never a silent abort', async () => {
    // The LN payment commits, THEN the user cancels while we await the lockup.
    // A silent AbortError here would reintroduce the #891 double-send risk, so
    // the committed state must win (Copilot review).
    const ctrl = new AbortController();
    (boltzService.waitForLockup as jest.Mock).mockImplementation(async () => {
      ctrl.abort();
      throw named('AbortError', 'cancelled');
    });
    let err: unknown;
    try {
      await executeReverseSwap(params({ signal: ctrl.signal }));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SwapSettlingError);
  });

  it('throws "Boltz swap failed" on a genuine pre-commit failure', async () => {
    neverLockup();
    const payInvoice = jest.fn(async () => {
      throw new Error('insufficient balance');
    });
    await expect(executeReverseSwap(params({ payInvoice }))).rejects.toThrow(
      /Boltz swap failed: insufficient balance/,
    );
  });
});

describe('executeReverseSwap — stages (#1167)', () => {
  it('reports every Send-screen stage in order, starting before the swap is created', async () => {
    const stages: string[] = [];
    let createdAtFirstStage: boolean | undefined;
    await executeReverseSwap(
      params({
        onStage: (stage) => {
          if (stages.length === 0)
            createdAtFirstStage =
              (boltzService.createReverseSwap as jest.Mock).mock.calls.length > 0;
          stages.push(stage);
        },
      }),
    );
    expect(stages).toEqual(['createSwap', 'payAndLockup', 'claimSwap', 'cleanup']);
    expect(createdAtFirstStage).toBe(false);
  });

  it('stops at createSwap when Boltz rejects the swap', async () => {
    (boltzService.createReverseSwap as jest.Mock).mockRejectedValueOnce(new Error('boltz down'));
    const onStage = jest.fn();
    const payInvoice = jest.fn();
    await expect(executeReverseSwap(params({ onStage, payInvoice }))).rejects.toThrow('boltz down');
    expect(onStage.mock.calls).toEqual([['createSwap']]);
    expect(payInvoice).not.toHaveBeenCalled();
  });
});

describe('executeReverseSwap — hold invoice', () => {
  it('binds the approved quote and persists + indexes before paying', async () => {
    const quote = { pairHash: 'h', percentage: 0.5, minerFee: 1, minAmount: 1, maxAmount: 9 };
    const payInvoice = jest.fn(async () => ({ preimage: 'preimage-hex' }));
    await executeReverseSwap(params({ approvedQuote: quote, payInvoice }));
    expect(boltzService.createReverseSwap).toHaveBeenCalledWith(
      'bc1qdest',
      30000,
      quote,
      'recipient',
      expect.any(Object),
    );
    const persistAt = (SecureStore.setItemAsync as jest.Mock).mock.invocationCallOrder[0];
    const indexAt = (swapRecoveryService.registerPendingSwap as jest.Mock).mock
      .invocationCallOrder[0];
    expect(persistAt).toBeLessThan(indexAt);
    expect(indexAt).toBeLessThan(payInvoice.mock.invocationCallOrder[0]);
  });

  it('surfaces a stale-quote rejection with the refreshed quote and never pays', async () => {
    const refreshed = { pairHash: 'h2', percentage: 1, minerFee: 2, minAmount: 1, maxAmount: 9 };
    const rejection = Object.assign(new Error('Swap fees or server changed.'), {
      name: 'QuoteChangedError',
      quote: refreshed,
    });
    (boltzService.createReverseSwap as jest.Mock).mockRejectedValueOnce(rejection);
    const payInvoice = jest.fn(async () => ({ preimage: 'preimage-hex' }));
    await expect(executeReverseSwap(params({ payInvoice }))).rejects.toBe(rejection);
    expect(payInvoice).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(swapRecoveryService.registerPendingSwap).not.toHaveBeenCalled();
    expect(boltzService.createReverseSwap).toHaveBeenCalledTimes(1);
  });

  it('completes when the payment only settles after the claim reveals the preimage', async () => {
    let settle!: (v: unknown) => void;
    const payInvoice = jest.fn(() => new Promise((resolve) => (settle = resolve)));
    (boltzService.claimSwap as jest.Mock).mockImplementation(async () => {
      settle({ preimage: SWAP.preimage }); // Boltz settles the hold invoice
      return { txId: 'claim-tx-id', outputSats: 30000 };
    });
    await expect(executeReverseSwap(params({ payInvoice }))).resolves.toMatchObject({
      claimTxId: 'claim-tx-id',
    });
    expect(payInvoice).toHaveBeenCalledTimes(1);
    expect(swapRecoveryService.recoverPendingSwaps).not.toHaveBeenCalled();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith('boltz_swap_sw1');
  });
});

describe('executeReverseSwap — bounded create stage (2026-11-01 stuck swap)', () => {
  afterEach(() => jest.useRealTimers());

  it('passes the send signal to createReverseSwap so Cancel aborts the request', async () => {
    const controller = new AbortController();
    await executeReverseSwap(params({ signal: controller.signal }));
    expect((boltzService.createReverseSwap as jest.Mock).mock.calls[0][4]).toBe(controller.signal);
  });

  it('fails visibly when creation never settles, and never pays the late swap', async () => {
    jest.useFakeTimers();
    let resolveCreate!: (swap: typeof SWAP) => void;
    (boltzService.createReverseSwap as jest.Mock).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }),
    );
    const payInvoice = jest.fn();
    const sending = executeReverseSwap(params({ payInvoice, createTimeoutMs: 1000 }));
    const rejected = expect(sending).rejects.toBeInstanceOf(SwapCreateTimeoutError);
    jest.advanceTimersByTime(1000);
    await rejected;
    // Boltz answers after we gave up: the swap must NOT be paid (no double
    // or surprise payment) — it simply expires unpaid server-side.
    resolveCreate(SWAP);
    await jest.runAllTimersAsync();
    expect(payInvoice).not.toHaveBeenCalled();
    expect(boltzService.waitForLockup).not.toHaveBeenCalled();
  });

  it('fails visibly when persisting the swap hangs, without paying', async () => {
    jest.useFakeTimers();
    (swapRecoveryService.registerPendingSwap as jest.Mock).mockReturnValueOnce(
      new Promise(() => undefined),
    );
    const payInvoice = jest.fn();
    const sending = executeReverseSwap(params({ payInvoice, createTimeoutMs: 1000 }));
    const rejected = expect(sending).rejects.toBeInstanceOf(SwapCreateTimeoutError);
    await jest.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it("maps the create request's own timeout to a clear nothing-was-sent error", async () => {
    (boltzService.createReverseSwap as jest.Mock).mockRejectedValueOnce(
      new SwapServerTimeoutError(30_000),
    );
    const payInvoice = jest.fn();
    const error = await executeReverseSwap(params({ payInvoice })).catch((e) => e);
    expect(error).toBeInstanceOf(SwapCreateTimeoutError);
    expect((error as Error).name).not.toBe('AbortError');
    expect((error as Error).message).toMatch(/Nothing was sent/);
    expect(payInvoice).not.toHaveBeenCalled();
  });

  it('rejects with AbortError when the user cancels during creation, without paying', async () => {
    (boltzService.createReverseSwap as jest.Mock).mockReturnValueOnce(new Promise(() => undefined));
    const controller = new AbortController();
    const payInvoice = jest.fn();
    const sending = executeReverseSwap(params({ payInvoice, signal: controller.signal }));
    controller.abort();
    await expect(sending).rejects.toMatchObject({ name: 'AbortError' });
    expect(payInvoice).not.toHaveBeenCalled();
  });
});
