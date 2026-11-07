import { arkExpiryInfo, toArkHistory, type ArkMovementLike } from './arkCoinHealth';

describe('arkExpiryInfo', () => {
  it('reports none when the wallet holds no coins', () => {
    expect(arkExpiryInfo(900, null, false)).toEqual({
      health: 'none',
      blocksLeft: null,
      daysLeft: null,
    });
  });

  it('is ok with plenty of time left', () => {
    expect(arkExpiryInfo(0, 144 * 20, false)).toEqual({
      health: 'ok',
      blocksLeft: 2_880,
      daysLeft: 20,
    });
  });

  it('asks for a refresh inside the warning window or when bark wants one', () => {
    expect(arkExpiryInfo(0, 144 * 3, false).health).toBe('refreshSoon');
    expect(arkExpiryInfo(0, 144 * 20, true).health).toBe('refreshSoon');
  });

  it('is urgent inside the last day and never goes negative', () => {
    expect(arkExpiryInfo(1_000, 1_100, false)).toMatchObject({ health: 'urgent', daysLeft: 0 });
    expect(arkExpiryInfo(2_000, 1_100, false).blocksLeft).toBe(0);
  });

  it('falls back to bark’s own signal when the chain tip is unknown', () => {
    expect(arkExpiryInfo(null, 1_000, true)).toEqual({
      health: 'refreshSoon',
      blocksLeft: null,
      daysLeft: null,
    });
  });
});

const movement = (over: Partial<ArkMovementLike>): ArkMovementLike => ({
  id: 1,
  status: 'successful',
  subsystemName: 'bark.arkoor',
  effectiveBalanceSats: 0n,
  offchainFeeSats: 0n,
  createdAt: '2026-10-23T10:00:00Z',
  ...over,
});

describe('toArkHistory', () => {
  it('maps direction, status and fee, newest first', () => {
    const items = toArkHistory([
      movement({ id: 1, effectiveBalanceSats: 1_000n }),
      movement({ id: 2, effectiveBalanceSats: -400n, offchainFeeSats: 3n, status: 'pending' }),
      movement({
        id: 3,
        subsystemName: 'bark.exit',
        effectiveBalanceSats: -500n,
        status: 'failed',
      }),
    ]);
    expect(items.map((i) => [i.id, i.kind, i.amountSats, i.pending, i.failed])).toEqual([
      [3, 'exit', 500, false, true],
      [2, 'sent', 400, true, false],
      [1, 'received', 1_000, false, false],
    ]);
    expect(items[1].feeSats).toBe(3);
  });

  it('hides free refreshes that moved no money, keeps paid ones', () => {
    const items = toArkHistory([
      movement({ id: 1, subsystemName: 'bark.round.refresh' }),
      movement({ id: 2, subsystemName: 'bark.round.refresh', offchainFeeSats: 5n }),
    ]);
    expect(items.map((i) => i.id)).toEqual([2]);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      movement({ id: i, effectiveBalanceSats: 1n }),
    );
    expect(toArkHistory(many, 10)).toHaveLength(10);
  });
});
