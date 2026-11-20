import { qrPayload } from './qrPayload';

describe('qrPayload', () => {
  it('upper-cases a Lightning invoice so the QR code is less dense', () => {
    expect(qrPayload('lnbc210n1p4sqttmpp5sal3pcf68aat')).toBe('LNBC210N1P4SQTTMPP5SAL3PCF68AAT');
  });

  it('upper-cases a lightning: invoice URI and testnet invoices', () => {
    expect(qrPayload('lightning:lnbc1pvjluez')).toBe('LIGHTNING:LNBC1PVJLUEZ');
    expect(qrPayload('lntb20m1pvjluez')).toBe('LNTB20M1PVJLUEZ');
  });

  it('leaves other payloads alone, where case can matter', () => {
    for (const value of [
      'lightning:piggy@example.com',
      'bitcoin:bc1qxyz?amount=0.0001&label=Piggy',
      'nostr+walletconnect://abc?relay=wss://relay.example&secret=abc',
      'lnurl1dp68gurn8ghj7',
    ]) {
      expect(qrPayload(value)).toBe(value);
    }
  });
});
