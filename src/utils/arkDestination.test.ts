import { parseArkDestination, parseSatsInput } from './arkDestination';

// BOLT 11 spec test vector: 2500u = 250,000 sats.
const INVOICE =
  'lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp';
const ARK = 'tark1qqellv3xudanfnp6lwgr7xwulwxwdmj2pxtx6u7l0tsmqh3ny7y8jzcqqqqqqqqqqqqqq';
const SIGNET_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('parseArkDestination', () => {
  it('recognises an Ark address', () => {
    expect(parseArkDestination(`  ${ARK} `)).toEqual({ kind: 'ark', value: ARK, amountSats: null });
  });

  it('recognises a BOLT11 invoice and reads its amount, with or without lightning:', () => {
    const expected = { kind: 'bolt11', value: INVOICE, amountSats: 250_000 };
    expect(parseArkDestination(INVOICE)).toEqual(expected);
    expect(parseArkDestination(`lightning:${INVOICE}`)).toEqual(expected);
  });

  it('recognises a Lightning address and lower-cases it', () => {
    expect(parseArkDestination('Piggy@Example.com')).toEqual({
      kind: 'lightningAddress',
      value: 'piggy@example.com',
      amountSats: null,
    });
  });

  it('recognises an LNURL', () => {
    expect(parseArkDestination('LNURL1DP68GURN8GHJ7')?.kind).toBe('lnurl');
  });

  it('recognises an on-chain address', () => {
    expect(parseArkDestination(SIGNET_ADDRESS)).toEqual({
      kind: 'bitcoin',
      value: SIGNET_ADDRESS,
      amountSats: null,
    });
  });

  it('prefers the ark= parameter of a BIP-21 URI and reads amount= in BTC', () => {
    expect(parseArkDestination(`bitcoin:${SIGNET_ADDRESS}?amount=0.0001&ark=${ARK}`)).toEqual({
      kind: 'ark',
      value: ARK,
      amountSats: 10_000,
    });
  });

  it('falls back to lightning= and then the address of a BIP-21 URI', () => {
    expect(parseArkDestination(`bitcoin:${SIGNET_ADDRESS}?lightning=${INVOICE}`)?.kind).toBe(
      'bolt11',
    );
    expect(parseArkDestination(`bitcoin:${SIGNET_ADDRESS}?amount=1`)).toEqual({
      kind: 'bitcoin',
      value: SIGNET_ADDRESS,
      amountSats: 100_000_000,
    });
  });

  it('rejects anything else', () => {
    expect(parseArkDestination('')).toBeNull();
    expect(parseArkDestination('hello world')).toBeNull();
    expect(parseArkDestination('npub1xyz')).toBeNull();
    expect(parseArkDestination('bitcoin:?amount=1')).toBeNull();
  });
});

describe('parseSatsInput', () => {
  it('accepts whole positive sats with separators', () => {
    expect(parseSatsInput('21,000')).toBe(21_000);
    expect(parseSatsInput(' 1 000 ')).toBe(1_000);
  });

  it('rejects empty, zero, decimals and junk', () => {
    expect(parseSatsInput('')).toBeNull();
    expect(parseSatsInput('0')).toBeNull();
    expect(parseSatsInput('1.5')).toBeNull();
    expect(parseSatsInput('-3')).toBeNull();
    expect(parseSatsInput('abc')).toBeNull();
  });
});
