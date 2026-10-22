import AsyncStorage from '@react-native-async-storage/async-storage';
import { bech32 } from 'bech32';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { p2tr, Script } from '@scure/btc-signer';
import { keyAggregate, keyAggExport } from '@scure/btc-signer/musig2.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js';
import { verifySubmarineSwap, type SubmarineSwapResponse } from '../utils/submarineSwapVerify';
import { createSubmarineSwapForward } from './boltzService';
import { getBlockHeight } from './onchainService';

jest.mock('./onchainService', () => ({ getBlockHeight: jest.fn() }));

const HEIGHT = 900000;
const HASH = new Uint8Array(32).fill(7);
const CLAIM_KEY = secp256k1.getPublicKey(new Uint8Array(32).fill(1), true);
const REFUND_KEY = secp256k1.getPublicKey(new Uint8Array(32).fill(2), true);
const OTHER_KEY = secp256k1.getPublicKey(new Uint8Array(32).fill(3), true);
const words = bech32.toWords(HASH);
const INVOICE = bech32.encode(
  'lnbc1m',
  [...Array(7).fill(0), 1, 1, 20, ...words, ...Array(104).fill(0)],
  2000,
); // 100,000 sats; dummy signature, real invoice decoding

// Build independent fixtures using scure's Script + P2TR implementations;
// production verification uses bitcoinjs. Varying the template also lets us
// supply internally consistent but malicious trees and addresses.
function fixture(
  refundKey = REFUND_KEY,
  opts: {
    hash?: Uint8Array;
    scriptRefundKey?: Uint8Array;
    timeout?: number;
    reverseKeys?: boolean;
    xOnly?: boolean;
  } = {},
): SubmarineSwapResponse {
  const claimKey = opts.xOnly ? Uint8Array.from([2, ...CLAIM_KEY.slice(1)]) : CLAIM_KEY;
  const timeout = opts.timeout ?? HEIGHT + 144;
  const claim = Script.encode([
    'HASH160',
    ripemd160(opts.hash ?? HASH),
    'EQUALVERIFY',
    claimKey.slice(1),
    'CHECKSIG',
  ]);
  const refund = Script.encode([
    (opts.scriptRefundKey ?? refundKey).slice(1),
    'CHECKSIGVERIFY',
    timeout,
    'CHECKLOCKTIMEVERIFY',
  ]);
  const keys = opts.reverseKeys ? [refundKey, claimKey] : [claimKey, refundKey];
  const address = p2tr(
    keyAggExport(keyAggregate(keys)),
    [
      { script: claim, leafVersion: 0xc0 },
      { script: refund, leafVersion: 0xc0 },
    ],
    undefined,
    true,
  ).address;
  return {
    id: 'test-swap',
    address,
    expectedAmount: 100600,
    timeoutBlockHeight: timeout,
    claimPublicKey: bytesToHex(opts.xOnly ? claimKey.slice(1) : claimKey),
    swapTree: {
      claimLeaf: { version: 0xc0, output: bytesToHex(claim) },
      refundLeaf: { version: 0xc0, output: bytesToHex(refund) },
    },
  };
}
const input = {
  invoice: INVOICE,
  refundPublicKey: REFUND_KEY,
  expectedAmount: 100600,
  currentBlockHeight: HEIGHT,
};

describe('submarine swap trust boundary', () => {
  it('accepts an independently generated valid swap', () => {
    expect(() => verifySubmarineSwap(fixture(), input)).not.toThrow();
  });
  it('accepts an independently constructed x-only claim-key swap', () => {
    expect(() => verifySubmarineSwap(fixture(REFUND_KEY, { xOnly: true }), input)).not.toThrow();
  });
  it('rejects an internally consistent tree committing to another invoice', () => {
    expect(() =>
      verifySubmarineSwap(fixture(REFUND_KEY, { hash: new Uint8Array(32).fill(8) }), input),
    ).toThrow(/script/);
  });
  it('rejects an internally consistent tree refunding to someone else', () => {
    expect(() =>
      verifySubmarineSwap(fixture(REFUND_KEY, { scriptRefundKey: OTHER_KEY }), input),
    ).toThrow(/script/);
  });
  it('rejects a different address or reversed MuSig key order', () => {
    expect(() =>
      verifySubmarineSwap(
        { ...fixture(), address: p2tr(schnorr.getPublicKey(new Uint8Array(32).fill(4))).address },
        input,
      ),
    ).toThrow(/address/);
    expect(() => verifySubmarineSwap(fixture(REFUND_KEY, { reverseKeys: true }), input)).toThrow(
      /address/,
    );
  });
  it.each([HEIGHT, HEIGHT - 1, HEIGHT + 1009, 500000000])(
    'rejects unsafe timeout %p even with matching scripts',
    (timeout) => {
      expect(() => verifySubmarineSwap(fixture(REFUND_KEY, { timeout }), input)).toThrow(/timeout/);
    },
  );
  it.each([100599, 100601, 0, NaN, '100600'])('rejects unquoted amount %p', (expectedAmount) => {
    expect(() => verifySubmarineSwap({ ...fixture(), expectedAmount }, input)).toThrow(/amount/);
  });
  it('rejects extra script instructions and unknown leaf versions', () => {
    const swap = fixture();
    swap.swapTree.claimLeaf.output += '51';
    expect(() => verifySubmarineSwap(swap, input)).toThrow(/script/);
    const other = fixture();
    other.swapTree.refundLeaf.version = 0xc2;
    expect(() => verifySubmarineSwap(other, input)).toThrow(/script/);
  });
  it.each([
    null,
    {},
    { ...fixture(), swapTree: null },
    { ...fixture(), claimPublicKey: 'bad' },
    { ...fixture(), claimPublicKey: '02' + 'ff'.repeat(32) },
    { ...fixture(), address: 'bad' },
    { ...fixture(), timeoutBlockHeight: 1.5 },
    { ...fixture(), id: '../bad' },
  ])('rejects malformed response %#', (response) => {
    expect(() => verifySubmarineSwap(response, input)).toThrow();
  });
  it('rejects a missing invoice hash and an invalid independent tip', () => {
    expect(() => verifySubmarineSwap(fixture(), { ...input, invoice: 'bad' })).toThrow(/hash/);
    expect(() => verifySubmarineSwap(fixture(), { ...input, currentBlockHeight: NaN })).toThrow(
      /timeout/,
    );
  });
});

describe('createSubmarineSwapForward', () => {
  const originalFetch = global.fetch;
  let mutate: (response: SubmarineSwapResponse) => unknown;
  let fetchMock: jest.Mock;
  let xOnlyResponse = false;
  beforeEach(async () => {
    await AsyncStorage.setItem('swap_backend_url_v1', 'https://lightning.example/v2');
    jest.mocked(getBlockHeight).mockResolvedValue(HEIGHT);
    mutate = (response) => response;
    xOnlyResponse = false;
    fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () =>
            mutate(fixture(hexToBytes(body.refundPublicKey), { xOnly: xOnlyResponse })),
        };
      }
      return {
        ok: true,
        json: async () => ({
          BTC: {
            BTC: {
              hash: 'quote-hash',
              limits: { minimal: 1, maximal: 25000000 },
              fees: { percentage: 0.5, minerFees: 100 },
            },
          },
        }),
      };
    });
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = originalFetch;
    jest.clearAllMocks();
  });

  it('normalizes accepted x-only keys for persisted refund recovery', async () => {
    xOnlyResponse = true;
    const swap = await createSubmarineSwapForward(INVOICE, 100000);
    expect(swap.claimPublicKey).toBe('02' + bytesToHex(CLAIM_KEY.slice(1)));
  });
  it('pins the quote and returns a verified swap with its local refund key', async () => {
    const swap = await createSubmarineSwapForward(INVOICE, 100000);
    expect(swap.expectedAmount).toBe(100600);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    const request = JSON.parse(post![1].body);
    expect(request.pairHash).toBe('quote-hash');
    expect(request).not.toHaveProperty('referralId');
    expect(bytesToHex(secp256k1.getPublicKey(hexToBytes(swap.refundPrivateKey), true))).toBe(
      request.refundPublicKey,
    );
  });
  it.each(['address', 'amount', 'script'] as const)(
    'blocks %s tampering before funding',
    async (field) => {
      mutate = (response) => {
        if (field === 'address') response.address = fixture(OTHER_KEY).address;
        if (field === 'amount') response.expectedAmount++;
        if (field === 'script') response.swapTree.refundLeaf.output = '51';
        return response;
      };
      const fund = jest.fn();
      await expect(createSubmarineSwapForward(INVOICE, 100000).then(fund)).rejects.toThrow();
      expect(fund).not.toHaveBeenCalled();
    },
  );
  it('does not create a swap when the independent chain tip is unavailable', async () => {
    jest.mocked(getBlockHeight).mockRejectedValueOnce(new Error('Electrum unavailable'));
    await expect(createSubmarineSwapForward(INVOICE, 100000)).rejects.toThrow(/Electrum/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it.each([99999, 100001, 0, -1, 1.5, NaN, Infinity])(
    'rejects invoice/request mismatch %p before any network work',
    async (requested) => {
      await expect(createSubmarineSwapForward(INVOICE, requested)).rejects.toThrow(
        /requested payment/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getBlockHeight).not.toHaveBeenCalled();
    },
  );
  it('does not create a swap from an incomplete fee quote', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ BTC: { BTC: {} } }) });
    await expect(createSubmarineSwapForward(INVOICE, 100000)).rejects.toThrow(/quote/);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
});

it('rejects a lockup that cannot leave a dust-safe refund', () => {
  expect(() =>
    verifySubmarineSwap({ ...fixture(), expectedAmount: 700 }, { ...input, expectedAmount: 700 }),
  ).toThrow(/amount/);
});
