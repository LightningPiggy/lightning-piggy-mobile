import { nextLiveShareExpiry, type LiveShareMarkerLike } from './liveShareExpiry';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const MIN = 60_000;

const start = (sender: string, sessionId: string, startedAt: number, durationMs = 15 * MIN) =>
  ({
    sender,
    marker: { phase: 'start', sessionId, startedAt, durationMs },
  }) as LiveShareMarkerLike;
const end = (sender: string, sessionId: string) =>
  ({
    sender,
    marker: { phase: 'end', sessionId, startedAt: 0, durationMs: 0 },
  }) as LiveShareMarkerLike;

describe('nextLiveShareExpiry', () => {
  const now = 1_000_000_000;

  it('returns null with no markers', () => {
    expect(nextLiveShareExpiry([], now)).toBeNull();
  });

  it('returns the expiry of a running share', () => {
    expect(nextLiveShareExpiry([start(B, 's1', now - MIN)], now)).toBe(now + 14 * MIN);
  });

  it('ignores a share past startedAt + durationMs (boundary counts as expired)', () => {
    expect(nextLiveShareExpiry([start(B, 's1', now - 20 * MIN)], now)).toBeNull();
    expect(nextLiveShareExpiry([start(B, 's1', now - 15 * MIN)], now)).toBeNull();
  });

  it('ignores a share its sender has ended', () => {
    expect(nextLiveShareExpiry([start(B, 's1', now), end(B, 's1')], now)).toBeNull();
  });

  it("does not let another sender's end marker end someone else's share", () => {
    expect(nextLiveShareExpiry([start(B, 's1', now), end(A, 's1')], now)).toBe(now + 15 * MIN);
  });

  it('matches the end marker case-insensitively on the sender pubkey', () => {
    expect(nextLiveShareExpiry([start(B, 's1', now), end(B.toUpperCase(), 's1')], now)).toBeNull();
  });

  it('returns the earliest expiry among several running shares', () => {
    const markers = [
      start(B, 's1', now, 60 * MIN),
      start(A, 's2', now, 5 * MIN),
      start(B, 's3', now - 30 * MIN), // expired
    ];
    expect(nextLiveShareExpiry(markers, now)).toBe(now + 5 * MIN);
  });
});
