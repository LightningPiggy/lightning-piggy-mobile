import * as bolt11 from '../utils/bolt11';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { needsInvoiceHistoryConfirmation, parseInvoiceSettlement } from './nwcInvoiceSettlement';

const PREIMAGE = 'c'.repeat(64);
const HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));
const SETTLED = {
  payment_hash: HASH,
  settled_at: 100,
  state: 'settled',
  preimage: PREIMAGE,
};

it.each([
  null,
  {},
  { paid: true },
  { preimage: PREIMAGE },
  { amount: 4200 },
  ...['NOT_FOUND', 'INTERNAL', 'OTHER'].map((code) => ({ ...SETTLED, error: { code } })),
  ...['expired', 'pending', 'failed', null, ''].map((state) => ({ ...SETTLED, state })),
  ...[undefined, null, 0, -1, '100', NaN, Infinity].map((settled_at) => ({
    ...SETTLED,
    settled_at,
  })),
  { ...SETTLED, payment_hash: undefined },
  { ...SETTLED, payment_hash: 'd'.repeat(64) },
  { ...SETTLED, preimage: undefined },
  { ...SETTLED, preimage: 'd'.repeat(64) },
  { ...SETTLED, invoice: 'not-an-invoice' },
])('never treats invalid or unpaid response as paid: %j', (response) => {
  expect(parseInvoiceSettlement(response, HASH)?.paid).not.toBe(true);
});

it.each(['settled'])('accepts matching settlement proof with state %s', (state) => {
  expect(parseInvoiceSettlement({ ...SETTLED, state }, HASH)).toEqual({
    paid: true,
    settledAt: 100,
    preimage: PREIMAGE,
  });
});

it('binds the returned invoice to the requested hash', () => {
  const decode = jest.spyOn(bolt11, 'paymentHashFromBolt11');
  try {
    decode.mockReturnValueOnce('d'.repeat(64));
    expect(parseInvoiceSettlement({ ...SETTLED, invoice: 'other-invoice' }, HASH)).toBeNull();
    decode.mockReturnValueOnce(HASH);
    expect(parseInvoiceSettlement({ ...SETTLED, invoice: 'matching-invoice' }, HASH)).toMatchObject(
      { paid: true, invoice: 'matching-invoice' },
    );
  } finally {
    decode.mockRestore();
  }
});

it('requires history even with settled state when LNbits reuses the creation timestamp', () => {
  expect(
    parseInvoiceSettlement({ ...SETTLED, type: 'incoming', created_at: 100 }, HASH),
  ).toBeNull();
});

it.each([undefined, 'settled'])('requires history only at expiry for LNbits state %s', (state) => {
  const now = Date.now();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
  const response = { ...SETTLED, state, created_at: 100, expires_at: Math.ceil(now / 1000) + 1 };
  try {
    expect(needsInvoiceHistoryConfirmation(response)).toBe(false);
    expect(parseInvoiceSettlement(response, HASH)?.paid).toBe(true);
    clock.mockReturnValue(response.expires_at * 1000);
    expect(needsInvoiceHistoryConfirmation(response)).toBe(true);
    expect(parseInvoiceSettlement(response, HASH)).toBeNull();
  } finally {
    clock.mockRestore();
  }
});
