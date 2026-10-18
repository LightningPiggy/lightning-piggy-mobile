import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadSellerInvoices,
  patchSellerInvoice,
  recordSellerInvoice,
  sellerInvoiceKey,
} from './sellerInvoiceStore';
import { resetSellerStore } from './sellerEventStore';
const PREIMAGE = 'c'.repeat(64);
const HASH = bytesToHex(sha256(hexToBytes(PREIMAGE)));
const PROOF = { settledAt: 100, preimage: PREIMAGE, settlementVersion: 2 };
const OWNER = 'a'.repeat(64);
beforeEach(async () => {
  await AsyncStorage.clear();
  resetSellerStore();
});
it('keeps different buyers invoices isolated even when order IDs are identical', async () => {
  for (const buyerPubkey of ['b'.repeat(64), 'c'.repeat(64)])
    await recordSellerInvoice(OWNER, {
      buyerPubkey,
      orderId: 'same',
      walletId: buyerPubkey,
      paymentHash: HASH,
      bolt11: 'invoice',
      amountSats: 10,
      sentAt: 100,
    });
  const invoices = await loadSellerInvoices(OWNER);
  expect(Object.keys(invoices)).toHaveLength(2);
  for (const buyer of ['b'.repeat(64), 'c'.repeat(64)])
    expect(invoices[sellerInvoiceKey(buyer, 'same')].walletId).toBe(buyer);
});
it('ignores legacy records without a buyer binding', async () => {
  await AsyncStorage.setItem(
    `market-seller-invoices:${OWNER}`,
    JSON.stringify({
      same: {
        orderId: 'same',
        walletId: 'old',
        paymentHash: HASH,
        bolt11: 'invoice',
        amountSats: 10,
      },
    }),
  );
  expect(await loadSellerInvoices(OWNER)).toEqual({});
});

it.each(['read', 'record', 'patch', 'corrupt'])(
  'fails closed on a failed store %s',
  async (action) => {
    const record = {
      buyerPubkey: 'b'.repeat(64),
      orderId: 'old',
      walletId: 'wallet',
      paymentHash: HASH,
      bolt11: 'invoice',
      amountSats: 10,
      sentAt: 100,
    };
    await recordSellerInvoice(OWNER, record);
    const before = await AsyncStorage.getItem(`market-seller-invoices:${OWNER}`);
    if (action === 'corrupt') (AsyncStorage.getItem as jest.Mock).mockResolvedValueOnce('{');
    else (AsyncStorage.getItem as jest.Mock).mockRejectedValueOnce(new Error('read failed'));
    const result =
      action === 'record'
        ? recordSellerInvoice(OWNER, { ...record, orderId: 'new' })
        : action === 'patch'
          ? patchSellerInvoice(OWNER, 'old', record.buyerPubkey, { paidAt: 200 })
          : loadSellerInvoices(OWNER);
    await expect(result).rejects.toThrow();
    expect(await AsyncStorage.getItem(`market-seller-invoices:${OWNER}`)).toBe(before);
    await patchSellerInvoice(OWNER, 'old', record.buyerPubkey, { paidAt: 300, ...PROOF });
    expect(
      (await loadSellerInvoices(OWNER))[sellerInvoiceKey(record.buyerPubkey, 'old')].paidAt,
    ).toBe(300);
  },
);

const invoiceRecord = (n: number) => ({
  buyerPubkey: 'b'.repeat(64),
  orderId: String(n),
  walletId: 'wallet',
  paymentHash: HASH,
  bolt11: 'invoice',
  amountSats: 10,
  sentAt: n,
});

it.each([true, false])(
  'refuses overflow without deleting pending/unsettled invoices (%s)',
  async (deliveryPending) => {
    for (let n = 0; n < 300; n++)
      await recordSellerInvoice(OWNER, { ...invoiceRecord(n), deliveryPending });
    const before = await loadSellerInvoices(OWNER);
    await expect(recordSellerInvoice(OWNER, invoiceRecord(300))).rejects.toThrow('capacity');
    expect(await loadSellerInvoices(OWNER)).toEqual(before);
    // Existing invoices remain patchable and replaceable at capacity.
    await patchSellerInvoice(OWNER, '0', invoiceRecord(0).buyerPubkey, { paidAt: 1000 });
    await recordSellerInvoice(OWNER, { ...invoiceRecord(1), bolt11: 'replacement' });
    expect(Object.keys(await loadSellerInvoices(OWNER))).toHaveLength(300);
  },
);

it('prunes completed records before older active invoices', async () => {
  for (let n = 0; n < 300; n++)
    await recordSellerInvoice(OWNER, {
      ...invoiceRecord(n),
      ...(n === 1 ? { paidAt: 100, confirmedAt: 101, ...PROOF } : {}),
    });
  await recordSellerInvoice(OWNER, invoiceRecord(300));
  const records = await loadSellerInvoices(OWNER);
  expect(Object.keys(records)).toHaveLength(300);
  expect(records[sellerInvoiceKey(invoiceRecord(0).buyerPubkey, '0')]).toBeDefined();
  expect(records[sellerInvoiceKey(invoiceRecord(1).buyerPubkey, '1')]).toBeUndefined();
});

it.each([
  {},
  { settledAt: 100 },
  { preimage: PREIMAGE },
  { settledAt: 100, preimage: 'd'.repeat(64) },
  { settledAt: 100, preimage: PREIMAGE },
  PROOF,
])('repairs persisted false-paid records and retains verified proof: %j', async (proof) => {
  const record = { ...invoiceRecord(0), paidAt: 200, confirmedAt: 300, ...proof };
  const storageKey = `market-seller-invoices:${OWNER}`;
  await AsyncStorage.setItem(
    storageKey,
    JSON.stringify({ [sellerInvoiceKey(record.buyerPubkey, record.orderId)]: record }),
  );
  const records = await loadSellerInvoices(OWNER);
  const repaired = records[sellerInvoiceKey(record.buyerPubkey, record.orderId)];
  if (proof === PROOF) expect(repaired.paidAt).toBe(200);
  else {
    expect(repaired.paidAt).toBeUndefined();
    expect(repaired.confirmedAt).toBeUndefined();
  }
  expect(JSON.parse((await AsyncStorage.getItem(storageKey))!)).toEqual(records);
  expect(repaired.walletId).toBe(record.walletId);
});
