import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { __resetVerifiedEventCache } from './nostrVerifyCache';
import { bolt11AmountMsats, validateZapReceipt } from './zapReceiptValidation';

// BOLT11 spec test vector: 2500u = 250,000 sats = 250,000,000 msats.
const INVOICE_250K =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';

const senderKey = new Uint8Array(32).fill(1);
const SENDER = getPublicKey(senderKey);
const PROVIDER = 'b'.repeat(64);
const RECIPIENT = 'c'.repeat(64);

function zapRequest(opts: { amount?: string; p?: string[]; e?: string; anon?: boolean } = {}) {
  const tags: string[][] = (opts.p ?? [RECIPIENT]).map((p) => ['p', p]);
  if (opts.amount !== undefined) tags.push(['amount', opts.amount]);
  if (opts.e) tags.push(['e', opts.e]);
  if (opts.anon) tags.push(['anon', '']);
  return finalizeEvent(
    { kind: 9734, created_at: 1700000000, content: 'hi from me', tags },
    senderKey,
  );
}

function receipt(
  request: object,
  opts: { pubkey?: string; bolt11?: string; e?: string; p?: string } = {},
) {
  const tags: string[][] = [
    ['p', opts.p ?? RECIPIENT],
    ['description', JSON.stringify(request)],
  ];
  if (opts.bolt11 !== undefined) tags.push(['bolt11', opts.bolt11]);
  if (opts.e) tags.push(['e', opts.e]);
  return { pubkey: opts.pubkey ?? PROVIDER, tags };
}

beforeEach(() => __resetVerifiedEventCache());

describe('validateZapReceipt', () => {
  it('accepts a provider-signed receipt with a valid signed zap request', () => {
    const zr = zapRequest({ amount: '250000000' });
    expect(validateZapReceipt(receipt(zr, { bolt11: INVOICE_250K }), [PROVIDER])).toEqual({
      senderPubkey: SENDER,
      comment: 'hi from me',
      anonymous: false,
      amountMsats: 250000000,
    });
  });

  it('rejects a receipt not authored by the LNURL provider', () => {
    const zr = zapRequest();
    expect(validateZapReceipt(receipt(zr, { pubkey: 'd'.repeat(64) }), [PROVIDER])).toBeNull();
  });

  it('rejects every receipt when the provider key is unknown', () => {
    expect(validateZapReceipt(receipt(zapRequest()), [])).toBeNull();
  });

  it('rejects an unsigned (forged) zap request naming someone else', () => {
    const unsigned = { ...zapRequest(), sig: undefined, id: undefined };
    expect(validateZapReceipt(receipt({ ...unsigned, pubkey: SENDER }), [PROVIDER])).toBeNull();
  });

  it('rejects a zap request whose content was altered after signing', () => {
    const zr = { ...zapRequest(), content: 'pay me instead' };
    expect(validateZapReceipt(receipt(zr), [PROVIDER])).toBeNull();
  });

  it('rejects a description that is not a kind-9734', () => {
    const note = finalizeEvent(
      { kind: 1, created_at: 1700000000, content: '', tags: [['p', RECIPIENT]] },
      senderKey,
    );
    expect(validateZapReceipt(receipt(note), [PROVIDER])).toBeNull();
  });

  it('rejects a zap request for a different recipient or with several', () => {
    expect(validateZapReceipt(receipt(zapRequest({ p: ['e'.repeat(64)] })), [PROVIDER])).toBeNull();
    expect(
      validateZapReceipt(receipt(zapRequest({ p: [RECIPIENT, 'e'.repeat(64)] })), [PROVIDER]),
    ).toBeNull();
  });

  it('rejects a zap request amount that differs from the invoice', () => {
    const zr = zapRequest({ amount: '1000' });
    expect(validateZapReceipt(receipt(zr, { bolt11: INVOICE_250K }), [PROVIDER])).toBeNull();
  });

  it('checks the expected amount when the caller matched by amount', () => {
    const zr = zapRequest({ amount: '21000' });
    expect(validateZapReceipt(receipt(zr), [PROVIDER], { expectedAmountMsats: 21000 })).not.toBe(
      null,
    );
    expect(validateZapReceipt(receipt(zr), [PROVIDER], { expectedAmountMsats: 22000 })).toBeNull();
  });

  it('requires an event-scoped receipt to come from a request for that event', () => {
    const log = 'f'.repeat(64);
    expect(validateZapReceipt(receipt(zapRequest({ e: log }), { e: log }), [PROVIDER])).not.toBe(
      null,
    );
    expect(validateZapReceipt(receipt(zapRequest(), { e: log }), [PROVIDER])).toBeNull();
  });

  it('hides the sender of an anonymous zap', () => {
    const zr = zapRequest({ anon: true });
    expect(validateZapReceipt(receipt(zr), [PROVIDER])?.senderPubkey).toBeNull();
  });
});

describe('bolt11AmountMsats', () => {
  it('reads the invoice amount in msats', () => {
    expect(bolt11AmountMsats(INVOICE_250K)).toBe(250000000);
  });
  it('returns null for garbage', () => {
    expect(bolt11AmountMsats('lnbc1')).toBeNull();
  });
});
