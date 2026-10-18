import { generateSecretKey, getPublicKey } from 'nostr-tools';
import * as nip59 from 'nostr-tools/nip59';
import {
  buildInvoiceChatNote,
  buildPaymentRequestRumor,
  buildStatusUpdateRumor,
} from './sellerOrderMessages';
import { parseOrderEvent, payableBolt11 } from './orderEvents';

const SELLER = 'a'.repeat(64);
const BUYER = 'b'.repeat(64);
const BOLT11 = `lnbc21u1${'q'.repeat(80)}`;

describe('buildPaymentRequestRumor (Gamma §4 type 2, manual processing)', () => {
  it('carries exactly the spec tags', () => {
    const rumor = buildPaymentRequestRumor({
      sellerPubkey: SELLER,
      buyerPubkey: BUYER,
      orderId: 'order-1',
      amountSats: 2100,
      bolt11: BOLT11,
      expiresAt: 1_700_003_600,
      note: 'Invoice',
      createdAt: 1_700_000_000,
    });
    expect(rumor).toEqual({
      pubkey: SELLER,
      kind: 16,
      created_at: 1_700_000_000,
      content: 'Invoice',
      tags: [
        ['p', BUYER],
        ['subject', 'order-payment'],
        ['type', '2'],
        ['order', 'order-1'],
        ['amount', '2100'],
        ['payment', 'lightning', BOLT11],
        ['expiration', '1700003600'],
      ],
    });
    // LP's own buyer side reads it back as a payable request.
    const parsed = parseOrderEvent(rumor)!;
    expect(parsed).toMatchObject({ type: 'payment', orderId: 'order-1', amountSats: 2100 });
    expect(payableBolt11(parsed)).toBe(BOLT11);
  });

  it('omits expiration when unknown and refuses a non-positive amount', () => {
    const base = { sellerPubkey: SELLER, buyerPubkey: BUYER, orderId: 'o', bolt11: BOLT11 };
    expect(
      buildPaymentRequestRumor({ ...base, amountSats: 1 }).tags.some((t) => t[0] === 'expiration'),
    ).toBe(false);
    expect(() => buildPaymentRequestRumor({ ...base, amountSats: 0 })).toThrow();
    expect(() => buildPaymentRequestRumor({ ...base, amountSats: 1.5 })).toThrow();
  });

  it('is a rumor that gift-wraps (never signed itself)', () => {
    const sellerSk = generateSecretKey();
    const buyerSk = generateSecretKey();
    const rumor = buildPaymentRequestRumor({
      sellerPubkey: getPublicKey(sellerSk),
      buyerPubkey: getPublicKey(buyerSk),
      orderId: 'o',
      amountSats: 21,
      bolt11: BOLT11,
    });
    const wrap = nip59.wrapEvent(rumor, sellerSk, getPublicKey(buyerSk));
    expect(wrap.kind).toBe(1059);
    expect(nip59.unwrapEvent(wrap, buyerSk).kind).toBe(16);
  });
});

it('buildStatusUpdateRumor carries the spec tags and rejects unknown statuses', () => {
  const rumor = buildStatusUpdateRumor({
    sellerPubkey: SELLER,
    buyerPubkey: BUYER,
    orderId: 'order-1',
    status: 'confirmed',
    createdAt: 5,
  });
  expect(rumor.tags).toEqual([
    ['p', BUYER],
    ['subject', 'order-info'],
    ['type', '3'],
    ['order', 'order-1'],
    ['status', 'confirmed'],
  ]);
  expect(parseOrderEvent(rumor)).toMatchObject({ type: 'status', status: 'confirmed' });
  expect(() =>
    buildStatusUpdateRumor({
      sellerPubkey: SELLER,
      buyerPubkey: BUYER,
      orderId: 'o',
      status: 'shipped' as never,
    }),
  ).toThrow();
});

it('buildInvoiceChatNote is a plain kind-14 DM (no subject — not a group) with the same bolt11', () => {
  const note = buildInvoiceChatNote({
    sellerPubkey: SELLER,
    buyerPubkey: BUYER,
    orderId: 'abcd1234-ef',
    amountSats: 2100,
    bolt11: BOLT11,
  });
  expect(note.kind).toBe(14);
  expect(note.tags).toEqual([
    ['p', BUYER],
    ['order', 'abcd1234-ef'],
  ]);
  expect(note.content).toContain(BOLT11);
  expect(note.content).toContain('#abcd1234');
});
