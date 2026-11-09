import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { WalletTransaction } from '../types/wallet';
import { __resetVerifiedEventCache } from './nostrVerifyCache';
import { matchIncomingZapReceipts } from './incomingZapMatching';

// BOLT11 spec test vector: 250,000 sats.
const INVOICE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const friendKey = new Uint8Array(32).fill(7);
const FRIEND = getPublicKey(friendKey);
const PROVIDER = 'b'.repeat(64);
const ME = 'c'.repeat(64);
const ATTACKER = 'a'.repeat(64);
const T = 1_700_000_000;

const tx = (over: Partial<WalletTransaction> = {}): WalletTransaction => ({
  type: 'incoming',
  amount: 250000,
  settled_at: T,
  ...over,
});

const signedRequest = (amount = '250000000') =>
  finalizeEvent(
    {
      kind: 9734,
      created_at: T,
      content: 'thanks!',
      tags: [
        ['p', ME],
        ['amount', amount],
      ],
    },
    friendKey,
  );

const receipt = (request: object, opts: { pubkey?: string; bolt11?: string } = {}) => ({
  pubkey: opts.pubkey ?? PROVIDER,
  created_at: T + 10,
  tags: [
    ['p', ME],
    ['description', JSON.stringify(request)],
    ...(opts.bolt11 ? [['bolt11', opts.bolt11]] : []),
  ],
});

beforeEach(() => __resetVerifiedEventCache());

describe('matchIncomingZapReceipts', () => {
  it('attributes a bolt11-matched receipt signed by the wallet provider', () => {
    const payment = tx({ bolt11: INVOICE });
    const out = matchIncomingZapReceipts(
      [payment],
      [receipt(signedRequest(), { bolt11: INVOICE })],
      [PROVIDER],
    );
    expect(out.matches).toEqual([
      { tx: payment, senderPubkey: FRIEND, comment: 'thanks!', anonymous: false },
    ]);
    expect(out.misses).toEqual([]);
  });

  it('ignores a forged receipt published by anyone but the provider (#1780)', () => {
    // Unsigned zap request naming a trusted friend, same amount, same minute.
    const forged = { ...signedRequest(), sig: undefined, id: undefined };
    const payment = tx({ bolt11: 'lnbc-other-invoice' });
    const out = matchIncomingZapReceipts(
      [payment],
      [receipt({ ...forged, pubkey: FRIEND }, { pubkey: ATTACKER })],
      [PROVIDER],
    );
    expect(out.matches).toEqual([]);
    expect(out.misses).toEqual([payment]);
  });

  it('does not pair a tx that has a bolt11 with a different invoice by amount', () => {
    const payment = tx({ bolt11: 'lnbc-other-invoice' });
    const out = matchIncomingZapReceipts(
      [payment],
      [receipt(signedRequest(), { bolt11: INVOICE })],
      [PROVIDER],
    );
    expect(out.matches).toEqual([]);
    expect(out.misses).toEqual([payment]);
  });

  it('still pairs a bolt11-less tx by amount and time when the receipt is valid', () => {
    const payment = tx();
    const out = matchIncomingZapReceipts([payment], [receipt(signedRequest())], [PROVIDER]);
    expect(out.matches.map((m) => m.senderPubkey)).toEqual([FRIEND]);
  });

  it('rejects an amount match whose provider receipt has an unsigned request', () => {
    const unsigned = { ...signedRequest(), sig: undefined };
    const out = matchIncomingZapReceipts([tx()], [receipt(unsigned)], [PROVIDER]);
    expect(out.matches).toEqual([]);
    // No bolt11 on the tx: leave it unresolved rather than negative-cache it.
    expect(out.misses).toEqual([]);
  });

  it('attributes nothing when the provider key is unknown', () => {
    const payment = tx({ bolt11: INVOICE });
    const out = matchIncomingZapReceipts(
      [payment],
      [receipt(signedRequest(), { bolt11: INVOICE })],
      [],
    );
    expect(out.matches).toEqual([]);
  });

  it('leaves a payment unresolved when its only receipt is by another author', () => {
    // e.g. a second LNURL address paying into this wallet, signed by its own key.
    const payment = tx({ bolt11: INVOICE });
    const out = matchIncomingZapReceipts(
      [payment],
      [receipt(signedRequest(), { bolt11: INVOICE, pubkey: ATTACKER })],
      [PROVIDER],
    );
    expect(out.matches).toEqual([]);
    expect(out.misses).toEqual([]);
  });

  it('records a miss when a trusted receipt fails a hard check', () => {
    const payment = tx({ bolt11: INVOICE });
    const tampered = { ...signedRequest(), content: 'edited' };
    const out = matchIncomingZapReceipts(
      [payment],
      [receipt(tampered, { bolt11: INVOICE })],
      [PROVIDER],
    );
    expect(out.misses).toEqual([payment]);
  });
});

describe('self-payment replay on a shared custodial provider', () => {
  // The victim's address and the attacker's address live on the same
  // custodial LNURL server. A friend's old zap request (p = victim) is public
  // inside an old receipt. The attacker replays it to the callback of their
  // OWN address and pays it; the server publishes a genuinely server-signed
  // receipt (p = victim, sender = friend) for the ATTACKER's invoice.
  const providerKey = new Uint8Array(32).fill(5);
  const SERVER = getPublicKey(providerKey);
  // Payment hash of INVOICE (the BOLT11 spec vector).
  const ATTACKER_INVOICE_HASH = '0001020304050607080900010203040506070809000102030405060708090102';
  const VICTIM_HASH = 'ab'.repeat(32);

  const replayedReceipt = () => {
    const oldFriendRequest = signedRequest(); // real, validly signed by the friend
    return finalizeEvent(
      {
        kind: 9735,
        created_at: T + 10,
        content: '',
        tags: [
          ['p', ME],
          ['bolt11', INVOICE],
          ['description', JSON.stringify(oldFriendRequest)],
        ],
      },
      providerKey,
    );
  };

  it('does not label an invoice-less payment with a payment hash by amount and time', () => {
    // NIP-47 may omit `invoice` but sends `payment_hash`: same amount, same minute.
    const victimPayment = tx({ paymentHash: VICTIM_HASH });
    const out = matchIncomingZapReceipts([victimPayment], [replayedReceipt()], [SERVER]);
    expect(out.matches).toEqual([]);
    expect(out.misses).toEqual([]);
  });

  it('still attributes an invoice-less payment whose hash matches the receipt invoice', () => {
    const payment = tx({ paymentHash: ATTACKER_INVOICE_HASH.toUpperCase() });
    const out = matchIncomingZapReceipts([payment], [replayedReceipt()], [SERVER]);
    expect(out.matches.map((m) => m.senderPubkey)).toEqual([FRIEND]);
  });

  it('rejects a bolt11 match whose invoice hash disagrees with the payment hash', () => {
    const payment = tx({ bolt11: INVOICE, paymentHash: VICTIM_HASH });
    const out = matchIncomingZapReceipts([payment], [replayedReceipt()], [SERVER]);
    expect(out.matches).toEqual([]);
  });
});
