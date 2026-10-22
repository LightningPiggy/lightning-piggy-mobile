import { bech32 } from 'bech32';
import { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { p2tr, Script } from '@scure/btc-signer';
import { keyAggregate, keyAggExport } from '@scure/btc-signer/musig2.js';
import * as bitcoin from 'bitcoinjs-lib';
import { createReverseSwap, claimSwap, getReverseSwapFees } from './boltzService';
import { getBlockHeight, broadcastRawTx, getClaimFeeEstimate, isTxKnown } from './onchainService';
import { verifyReverseSwap, verifyReverseLockup } from '../utils/reverseSwapVerify';
import { CLAIM_TX_MAX_VSIZE } from '../utils/reverseSwapAmounts';
import AsyncStorage from '@react-native-async-storage/async-storage';
jest.mock('./onchainService', () => ({
  getBlockHeight: jest.fn(),
  getSwapClaimFeeRate: jest.fn(async () => 2),
  getClaimFeeEstimate: jest.fn(async () => 2),
  isTxKnown: jest.fn(async () => true),
  broadcastRawTx: jest.fn(),
}));
const HEIGHT = 900000;
const PRIVATE = new Uint8Array(32).fill(2);
const CLAIM = secp256k1.getPublicKey(PRIVATE, true);
const REFUND = secp256k1.getPublicKey(new Uint8Array(32).fill(3), true);
const HASH = new Uint8Array(32).fill(7);
const toHex = (v: Uint8Array) => Buffer.from(v).toString('hex');
function invoice(hash: Uint8Array) {
  return bech32.encode(
    'lnbc1m',
    [...Array(7).fill(0), 1, 1, 20, ...bech32.toWords(hash), ...Array(104).fill(0)],
    2000,
  );
}
function fixture(
  claim: Uint8Array = CLAIM,
  hash: Uint8Array = HASH,
  timeout = HEIGHT + 144,
  xOnly = false,
) {
  const refund = xOnly ? Uint8Array.from([2, ...REFUND.slice(1)]) : REFUND;
  const a = Script.encode([
    'SIZE',
    32,
    'EQUALVERIFY',
    'HASH160',
    ripemd160(hash),
    'EQUALVERIFY',
    claim.slice(1),
    'CHECKSIG',
  ]);
  const b = Script.encode([refund.slice(1), 'CHECKSIGVERIFY', timeout, 'CHECKLOCKTIMEVERIFY']);
  return {
    id: 'reverse-test',
    invoice: invoice(hash),
    onchainAmount: 98500,
    timeoutBlockHeight: timeout,
    refundPublicKey: toHex(xOnly ? refund.slice(1) : refund),
    lockupAddress: p2tr(
      keyAggExport(keyAggregate([refund, claim])),
      [
        { script: a, leafVersion: 0xc0 },
        { script: b, leafVersion: 0xc0 },
      ],
      undefined,
      true,
    ).address!,
    swapTree: {
      claimLeaf: { version: 0xc0, output: toHex(a) },
      refundLeaf: { version: 0xc0, output: toHex(b) },
    },
  };
}
const input = {
  preimageHash: HASH,
  claimPublicKey: CLAIM,
  expectedAmount: 98500,
  currentBlockHeight: HEIGHT,
};
it('accepts an independently constructed canonical reverse tree including x-only refund keys', () => {
  verifyReverseSwap(fixture(), input);
  verifyReverseSwap(fixture(CLAIM, HASH, HEIGHT + 144, true), input);
});
it.each([HEIGHT - 1, HEIGHT, HEIGHT + 5, HEIGHT + 1015, 500000000])(
  'rejects unsafe refund deadline %s even with a consistent tree',
  (height) => {
    expect(() => verifyReverseSwap(fixture(CLAIM, HASH, height), input)).toThrow(/timeout/);
  },
);
it('rejects a claim leaf that requires a different preimage or key', () => {
  expect(() => verifyReverseSwap(fixture(CLAIM, new Uint8Array(32).fill(9)), input)).toThrow(
    /script/,
  );
  expect(() => verifyReverseSwap(fixture(REFUND), input)).toThrow(/script/);
});
it.each(['amount', 'address', 'version', 'extra-op'])('rejects %s tampering', (field) => {
  const swap = fixture();
  if (field === 'amount') swap.onchainAmount--;
  if (field === 'address') swap.lockupAddress = fixture(REFUND).lockupAddress;
  if (field === 'version') swap.swapTree.claimLeaf.version = 0xc2;
  if (field === 'extra-op') swap.swapTree.refundLeaf.output += '51';
  expect(() => verifyReverseSwap(swap, input)).toThrow();
});
function lockup(address: string, amount: number) {
  const tx = new bitcoin.Transaction();
  tx.addInput(new Uint8Array(32).fill(4), 0);
  tx.addOutput(bitcoin.address.toOutputScript(address), BigInt(amount));
  return tx;
}
it('derives the real transaction id and output, rejecting an underfunded lockup', () => {
  const swap = fixture();
  const tx = lockup(swap.lockupAddress, swap.onchainAmount);
  expect(verifyReverseLockup(tx.toHex(), swap)).toMatchObject({
    txId: tx.getId(),
    vout: 0,
    amount: 98500,
  });
  expect(() => verifyReverseLockup(lockup(swap.lockupAddress, 98000).toHex(), swap)).toThrow(
    /amount/,
  );
  expect(() =>
    verifyReverseLockup(lockup(fixture(REFUND).lockupAddress, 98500).toHex(), swap),
  ).toThrow(/address/);
});

describe('creation before funding', () => {
  const originalFetch = global.fetch;
  let mutate: (s: ReturnType<typeof fixture>) => unknown;
  let fetchMock: jest.Mock;
  beforeEach(async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem('swap_backend_url_v1', 'https://lightning.example/v2');
    jest.clearAllMocks();
    jest.mocked(getBlockHeight).mockResolvedValue(HEIGHT);
    mutate = (s) => s;
    fetchMock = jest.fn(async (_url, init) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          json: async () =>
            mutate(
              fixture(
                Buffer.from(body.claimPublicKey, 'hex'),
                Buffer.from(body.preimageHash, 'hex'),
              ),
            ),
        };
      }
      return {
        ok: true,
        json: async () => ({
          BTC: {
            BTC: {
              hash: 'reverse-quote',
              limits: { minimal: 10000, maximal: 200000 },
              fees: { percentage: 0.5, minerFees: { lockup: 1000, claim: 300 } },
            },
          },
        }),
      };
    });
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('pins the un-referred quote and returns a verified reverse swap', async () => {
    const swap = await createReverseSwap(fixture().lockupAddress, 100000);
    expect(swap.onchainAmount).toBe(98500);
    const body = JSON.parse(
      fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')[1].body,
    );
    expect(body.pairHash).toBe('reverse-quote');
    expect(body).not.toHaveProperty('referralId');
  });
  it.each(['amount', 'address', 'script', 'timeout'])(
    'rejects %s before a caller can pay',
    async (field) => {
      mutate = (s) => {
        if (field === 'amount') s.onchainAmount--;
        if (field === 'address') s.lockupAddress = fixture(REFUND).lockupAddress;
        if (field === 'script') s.swapTree.claimLeaf.output += '51';
        if (field === 'timeout') s.timeoutBlockHeight = HEIGHT;
        return s;
      };
      const pay = jest.fn();
      await expect(createReverseSwap(fixture().lockupAddress, 100000).then(pay)).rejects.toThrow();
      expect(pay).not.toHaveBeenCalled();
    },
  );
  it('rejects a changed quote before creating or paying a swap', async () => {
    const quote = await getReverseSwapFees();
    await expect(
      createReverseSwap(fixture().lockupAddress, 100000, { ...quote, pairHash: 'old' }),
    ).rejects.toThrow(/changed/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  function claimable(id = 'reverse-test') {
    const preimage = new Uint8Array(32).fill(5);
    const swap = {
      ...fixture(CLAIM, bitcoin.crypto.sha256(preimage), HEIGHT + 144, true),
      id,
      preimage: toHex(preimage),
      claimPrivateKey: toHex(PRIVATE),
    };
    const tx = lockup(swap.lockupAddress, swap.onchainAmount);
    return { swap, lockup: verifyReverseLockup(tx.toHex(), swap) };
  }
  // #1175: fees 0.5% + 1,000 lockup; the claim is budgeted at 3 sat/vB (2 now,
  // plus headroom) × 152 vB = 456. A 98,044-sat recipient therefore needs a
  // 98,500 lockup and a 100,000-sat invoice.
  it('creates an exact-recipient swap with onchainAmount = recipient + claim fee', async () => {
    mutate = (s) => {
      delete (s as { onchainAmount?: number }).onchainAmount; // Boltz omits it
      return s;
    };
    const swap = await createReverseSwap(fixture().lockupAddress, 98044, undefined, 'recipient');
    const body = JSON.parse(
      fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')[1].body,
    );
    expect(body.onchainAmount).toBe(98500);
    expect(body).not.toHaveProperty('invoiceAmount');
    expect(swap).toMatchObject({
      onchainAmount: 98500,
      recipientAmount: 98044,
      invoiceAmount: 100000,
    });
  });
  it('rejects an exact-recipient swap whose lockup or invoice differs from the quote', async () => {
    mutate = (s) => {
      s.onchainAmount = 98499;
      return s;
    };
    await expect(
      createReverseSwap(fixture().lockupAddress, 98044, undefined, 'recipient'),
    ).rejects.toThrow(/amount/);
    mutate = (s) => {
      delete (s as { onchainAmount?: number }).onchainAmount;
      return s;
    };
    // One sat more for the recipient prices a 100,002-sat invoice, but Boltz
    // returned a 100,000-sat one: refuse rather than pay for the wrong swap.
    await expect(
      createReverseSwap(fixture().lockupAddress, 98045, undefined, 'recipient'),
    ).rejects.toThrow(/invoice amount|amount does not match/);
  });
  it('checks Boltz limits against the invoice the recipient amount implies', async () => {
    // 199,000 for the recipient is under the 200,000 maximum, the invoice is not.
    await expect(
      createReverseSwap(fixture().lockupAddress, 199000, undefined, 'recipient'),
    ).rejects.toThrow(/limits/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  // The claim pays a P2TR address here (152 vB): the 456-sat budget covers
  // live rates of 2 and 3 sat/vB but not 4, where the live fee is paid.
  it.each([
    [2, 98044, true],
    [3, 98044, true],
    [4, 98500 - 152 * 4, false],
  ])(
    'claims an exact-recipient swap at live rate %i sat/vB → pays %i',
    async (rate, paid, exact) => {
      const preimage = new Uint8Array(32).fill(5);
      const swap = {
        ...fixture(CLAIM, bitcoin.crypto.sha256(preimage), HEIGHT + 144, true),
        recipientAmount: 98044,
        preimage: toHex(preimage),
        claimPrivateKey: toHex(PRIVATE),
      };
      const tx = lockup(swap.lockupAddress, swap.onchainAmount);
      jest.mocked(getClaimFeeEstimate).mockResolvedValueOnce(rate);
      const claim = await claimSwap(
        { ...swap, id: `exact-${rate}` },
        verifyReverseLockup(tx.toHex(), swap),
        fixture(REFUND).lockupAddress,
      );
      const raw = jest.mocked(broadcastRawTx).mock.calls[0][0];
      expect(bitcoin.Transaction.fromHex(raw).virtualSize()).toBe(CLAIM_TX_MAX_VSIZE);
      expect(Number(bitcoin.Transaction.fromHex(raw).outs[0].value)).toBe(paid);
      expect(claim).toEqual({ txId: bitcoin.Transaction.fromHex(raw).getId(), outputSats: paid });
      expect(paid === 98044).toBe(exact);
    },
  );
  it('builds a verifiable script-path claim using the current Electrum fee estimate', async () => {
    const preimage = new Uint8Array(32).fill(5);
    const swap = {
      ...fixture(CLAIM, bitcoin.crypto.sha256(preimage), HEIGHT + 144, true),
      preimage: toHex(preimage),
      claimPrivateKey: toHex(PRIVATE),
    };
    const tx = lockup(swap.lockupAddress, swap.onchainAmount);
    jest.mocked(getClaimFeeEstimate).mockResolvedValueOnce(4);
    const result = await claimSwap(
      swap,
      verifyReverseLockup(tx.toHex(), swap),
      fixture(REFUND).lockupAddress,
    );
    expect(getClaimFeeEstimate).toHaveBeenCalledWith(3);
    const raw = jest.mocked(broadcastRawTx).mock.calls[0][0];
    const claim = bitcoin.Transaction.fromHex(raw);
    // Fee = the signed claim's real vsize × rate, not the 180 vB budget (#1174).
    expect(claim.virtualSize()).toBeLessThan(180);
    expect(Number(claim.outs[0].value)).toBe(98500 - claim.virtualSize() * 4);
    expect(result.outputSats).toBe(98500 - claim.virtualSize() * 4);
    expect(toHex(claim.ins[0].witness[1])).toBe(toHex(preimage));
    const script = claim.ins[0].witness[2];
    const leaf = bitcoin.crypto.taggedHash(
      'TapLeaf',
      Uint8Array.from([0xc0, script.length, ...script]),
    );
    const digest = claim.hashForWitnessV1(
      0,
      [bitcoin.address.toOutputScript(swap.lockupAddress)],
      [98500n],
      0,
      leaf,
    );
    expect(schnorr.verify(claim.ins[0].witness[0], digest, CLAIM.slice(1))).toBe(true);
  });
  it('caps a bogus claim fee estimate and survives a failed one', async () => {
    const { swap, lockup: verified } = claimable('fee-cap-swap');
    // A mis-scaled (sat/kvB-sized) estimate is capped at 10 × (180 vB × quoted 3).
    jest.mocked(getClaimFeeEstimate).mockResolvedValueOnce(2229);
    await claimSwap({ ...swap, claimFeeRate: 3 }, verified, fixture(REFUND).lockupAddress);
    let claim = bitcoin.Transaction.fromHex(jest.mocked(broadcastRawTx).mock.calls[0][0]);
    expect(Number(claim.outs[0].value)).toBe(98500 - 5400);
    // No live estimate: the quoted rate is used, on the real vsize.
    jest.mocked(getClaimFeeEstimate).mockRejectedValueOnce(new Error('electrum down'));
    await claimSwap(
      { ...swap, id: 'estimate-down-swap', claimFeeRate: 1.5 },
      verified,
      fixture(REFUND).lockupAddress,
    );
    claim = bitcoin.Transaction.fromHex(jest.mocked(broadcastRawTx).mock.calls[1][0]);
    expect(Number(claim.outs[0].value)).toBe(98500 - Math.ceil(claim.virtualSize() * 1.5));
  });
  it('waits for the lockup to reach the backend and retries missing inputs (#1174)', async () => {
    jest.useFakeTimers();
    try {
      const { swap, lockup: verified } = claimable('lockup-race-swap');
      jest.mocked(isTxKnown).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      const missing = new Error('bad-txns-inputs-missingorspent');
      jest
        .mocked(broadcastRawTx)
        .mockRejectedValueOnce(missing)
        .mockRejectedValueOnce(missing)
        .mockResolvedValueOnce(undefined);
      const claiming = claimSwap(swap, verified, fixture(REFUND).lockupAddress);
      await jest.advanceTimersByTimeAsync(1000); // visibility poll backoff
      expect(isTxKnown).toHaveBeenCalledWith(verified.txId);
      await jest.advanceTimersByTimeAsync(2000 + 4000); // broadcast backoff
      await expect(claiming).resolves.toMatchObject({
        txId: bitcoin.Transaction.fromHex(jest.mocked(broadcastRawTx).mock.calls[2][0]).getId(),
      });
      expect(broadcastRawTx).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
  it('refuses to disclose a preimage after the safe claim window has passed', async () => {
    const preimage = new Uint8Array(32).fill(5);
    const swap = {
      ...fixture(CLAIM, bitcoin.crypto.sha256(preimage)),
      id: 'expired-unclaimed-swap',
      preimage: toHex(preimage),
      claimPrivateKey: toHex(PRIVATE),
    };
    const tx = lockup(swap.lockupAddress, swap.onchainAmount);
    jest.mocked(getBlockHeight).mockResolvedValue(HEIGHT + 140);
    await expect(
      claimSwap(swap, verifyReverseLockup(tx.toHex(), swap), fixture(REFUND).lockupAddress),
    ).rejects.toThrow(/timeout/);
    expect(broadcastRawTx).not.toHaveBeenCalled();
  });
});
