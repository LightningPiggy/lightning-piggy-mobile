const mockSubscribeMany = jest.fn();

jest.mock('./nostrService', () => ({
  pool: { subscribeMany: (...a: unknown[]) => mockSubscribeMany(...a) },
  DEFAULT_RELAYS: ['wss://default.example'],
}));

// eslint-disable-next-line import/first
import { parseBolt11Sats, subscribeFindLogZaps } from './findLogZapsService';

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

describe('subscribeFindLogZaps', () => {
  beforeEach(() => {
    mockSubscribeMany.mockReset();
    mockSubscribeMany.mockReturnValue({ close: jest.fn() });
  });

  it('caps the zap-receipt backfill at 1,000 without a time window (#1789)', () => {
    subscribeFindLogZaps(['log1', 'log2'], jest.fn());
    expect(mockSubscribeMany.mock.calls[0][1]).toEqual({
      kinds: [9735],
      '#e': ['log1', 'log2'],
      limit: 1000,
    });
  });

  it('opens nothing for an empty log list', () => {
    subscribeFindLogZaps([], jest.fn())();
    expect(mockSubscribeMany).not.toHaveBeenCalled();
  });
});
