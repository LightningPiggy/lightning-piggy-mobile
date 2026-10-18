import { fiatSymbol, formatFiatApprox, formatInlineFiatApprox } from './fiat';

describe('formatFiatApprox', () => {
  // 100,000 sats = 0.001 BTC; at $60,000/BTC that's $60.00
  const PRICE = 60000;

  it('formats with the currency symbol when known', () => {
    expect(formatFiatApprox(100_000, PRICE, 'USD')).toBe('≈ $60.00');
    expect(formatFiatApprox(100_000, PRICE, 'GBP')).toBe('≈ £60.00');
  });

  it('falls back to "≈ N CUR" for an unknown currency code', () => {
    expect(formatFiatApprox(100_000, PRICE, 'XYZ')).toBe('≈ 60.00 XYZ');
  });

  it('always shows two fraction digits', () => {
    expect(formatFiatApprox(21, PRICE, 'USD')).toBe('≈ $0.01');
  });

  it('returns null when there is no price', () => {
    expect(formatFiatApprox(100_000, null, 'USD')).toBeNull();
    expect(formatFiatApprox(100_000, undefined, 'USD')).toBeNull();
    expect(formatFiatApprox(100_000, 0, 'USD')).toBeNull();
  });

  it('returns null for a non-positive amount', () => {
    expect(formatFiatApprox(0, PRICE, 'USD')).toBeNull();
    expect(formatFiatApprox(-5, PRICE, 'USD')).toBeNull();
  });

  it('resolves symbols from the authoritative CURRENCY_LIST', () => {
    expect(fiatSymbol('USD')).toBe('$');
    expect(fiatSymbol('EUR')).toBe('€');
    expect(fiatSymbol('GBP')).toBe('£');
    expect(fiatSymbol('XYZ')).toBe('');
  });
});

it('formats inline conversion spacing only when a chosen-currency equivalent exists', () => {
  expect(`95,633 sats${formatInlineFiatApprox(95633, 82608, 'USD', 'en-US')}`).toBe(
    '95,633 sats  ≈ $79.00',
  );
  expect(formatInlineFiatApprox(100000, 60000, 'GBP', 'en-GB')).toBe('  ≈ £60.00');
  expect(formatInlineFiatApprox(100000, 60000, 'XYZ', 'en-US')).toBe('  ≈ 60.00 XYZ');
  expect(formatInlineFiatApprox(95633, null, 'USD')).toBeNull();
});
