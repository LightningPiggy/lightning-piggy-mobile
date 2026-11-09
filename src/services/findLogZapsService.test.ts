import { finalizeEvent, type Event as NostrEvent } from 'nostr-tools/pure';
import { parseBolt11Sats, subscribeFindLogZaps } from './findLogZapsService';
import { pool } from './nostrService';
import { __resetVerifiedEventCache } from './nostrVerifyCache';

// Tests concentrate on the failure-path contract — null on garbage —
// because the success path delegates to light-bolt11-decoder, whose
// own test suite covers amount parsing. The thing this helper adds is
// safe-by-default null handling; that's what's worth pinning.
describe('parseBolt11Sats', () => {
  it('returns null for empty input', () => {
    expect(parseBolt11Sats('')).toBeNull();
  });

  it('returns null for clearly malformed input', () => {
    expect(parseBolt11Sats('not-a-bolt11')).toBeNull();
  });

  it('returns null for a bolt11 prefix without payload', () => {
    expect(parseBolt11Sats('lnbc1')).toBeNull();
  });
});

describe('subscribeFindLogZaps (#1780)', () => {
  // BOLT11 spec test vector: 250,000 sats.
  const INVOICE =
    'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
  const zapperKey = new Uint8Array(32).fill(9);
  const LOG = 'f'.repeat(64);
  const FINDER = 'c'.repeat(64);
  const PROVIDER = 'b'.repeat(64);

  const receiptBy = (author: string): NostrEvent => {
    const request = finalizeEvent(
      {
        kind: 9734,
        created_at: 1700000000,
        content: '',
        tags: [
          ['p', FINDER],
          ['e', LOG],
          ['amount', '250000000'],
        ],
      },
      zapperKey,
    );
    return {
      id: `receipt-${author.slice(0, 4)}`,
      pubkey: author,
      kind: 9735,
      created_at: 1700000001,
      content: '',
      sig: '',
      tags: [
        ['p', FINDER],
        ['e', LOG],
        ['bolt11', INVOICE],
        ['description', JSON.stringify(request)],
      ],
    };
  };

  let deliver: (e: NostrEvent) => void = () => {};
  beforeEach(() => {
    __resetVerifiedEventCache();
    jest.spyOn(pool, 'subscribeMany').mockImplementation((_relays, _filter, params) => {
      deliver = params.onevent as (e: NostrEvent) => void;
      return { close: jest.fn() } as unknown as ReturnType<typeof pool.subscribeMany>;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const subscribe = (onZap: jest.Mock, provider: string | null) =>
    subscribeFindLogZaps(new Map([[LOG, FINDER]]), onZap, ['wss://r'], async () => provider);

  it("counts a receipt signed by the finder's LNURL server", async () => {
    const onZap = jest.fn();
    subscribe(onZap, PROVIDER);
    deliver(receiptBy(PROVIDER));
    await settle();
    expect(onZap).toHaveBeenCalledWith({ receiptId: 'receipt-bbbb', logId: LOG, sats: 250000 });
  });

  it('drops a receipt published by anyone else', async () => {
    const onZap = jest.fn();
    subscribe(onZap, PROVIDER);
    deliver(receiptBy('a'.repeat(64)));
    await settle();
    expect(onZap).not.toHaveBeenCalled();
  });

  it("drops receipts while the finder's server key is unknown", async () => {
    const onZap = jest.fn();
    subscribe(onZap, null);
    deliver(receiptBy(PROVIDER));
    await settle();
    expect(onZap).not.toHaveBeenCalled();
  });
});
