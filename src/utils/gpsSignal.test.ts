import { gpsBarsForFixes, gpsSignalBars } from './gpsSignal';

describe('gpsSignalBars', () => {
  it.each([
    [0, 3],
    [9.99, 3],
    [10, 2],
    [29.99, 2],
    [30, 1],
    [100, 1],
    [100.01, 0],
    [null, 0],
    [undefined, 0],
    [Number.NaN, 0],
  ])('accuracy %p maps to %p bars', (accuracy, bars) => {
    expect(gpsSignalBars(accuracy)).toBe(bars);
  });
});

describe('gpsBarsForFixes', () => {
  it('uses the live fix accuracy when present', () => {
    expect(gpsBarsForFixes({ accuracy: 5 }, { accuracy: 500 })).toBe(3);
  });

  it('falls back to the initial fix when the live fix has null accuracy', () => {
    expect(gpsBarsForFixes({ accuracy: null }, { accuracy: 20 })).toBe(2);
  });

  it('falls back to the initial fix when there is no live fix', () => {
    expect(gpsBarsForFixes(null, { accuracy: 50 })).toBe(1);
  });

  it('returns 0 bars when neither fix has accuracy', () => {
    expect(gpsBarsForFixes(null, null)).toBe(0);
    expect(gpsBarsForFixes({ accuracy: null }, { accuracy: null })).toBe(0);
  });
});
