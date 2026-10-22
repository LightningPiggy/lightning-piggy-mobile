import { friendlyClaimError } from './claimErrorMessage';

describe('friendlyClaimError', () => {
  const FRIENDLY =
    "Couldn't reach your wallet to receive the prize. Check your wallet's connection, then try again.";

  it.each([
    'no info event (kind 13194) returned from relay',
    'connecting to wss://lnbits.example.com... status 403',
    'could not connect to relay',
    'WebSocket connection failed',
    'request timed out',
  ])('maps wallet-unreachable error to friendly copy: %s', (raw) => {
    expect(friendlyClaimError(raw)).toBe(FRIENDLY);
  });

  it.each([
    'This cache is empty — all sats already claimed',
    'Cooldown active: try again in 20 minutes',
    'You have already claimed this prize',
    'Invalid LNURL-withdraw request',
  ])('returns null (show as-is) for meaningful issuer messages: %s', (raw) => {
    expect(friendlyClaimError(raw)).toBeNull();
  });

  it('maps the NWC reply-timeout string to friendly copy', () => {
    expect(friendlyClaimError('reply timeout: event d8932dd2bd615ffe48f1d275bdad')).toBe(FRIENDLY);
  });

  it('uses the given subject so non-prize contexts read naturally', () => {
    expect(friendlyClaimError('reply timeout: event abc', 'the funds')).toBe(
      "Couldn't reach your wallet to receive the funds. Check your wallet's connection, then try again.",
    );
  });
});
