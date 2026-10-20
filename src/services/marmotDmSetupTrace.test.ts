import { beginDmSetupTrace, DM_SETUP_SLOW_MS, markDmSetup } from './marmotDmSetupTrace';

const PEER = '734582f08572109924f011d6c944bc5d9097b2473faa67d02b058c951e0007e7';

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('DM set-up trace (#1658)', () => {
  it('warns once, with every stage, when a set-up fails', () => {
    const trace = beginDmSetupTrace(PEER);
    markDmSetup('lookup start peers=1');
    markDmSetup('amber sign:13 start');
    trace.end('timeout');
    trace.end('timeout');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[MarmotDiag\] dm set-up 734582f0 timeout in \d+ms: /);
    expect(line).toContain('lookup start peers=1 +');
    expect(line).toContain('amber sign:13 start +');
    // Only a short prefix of the pubkey, never the whole key.
    expect(line).not.toContain(PEER);
  });

  it('stays quiet (warn-wise) for a quick success, but warns for a slow one', () => {
    jest.useFakeTimers();
    beginDmSetupTrace(PEER).end('ok');
    expect(warn).not.toHaveBeenCalled();
    const slow = beginDmSetupTrace(PEER);
    jest.advanceTimersByTime(DM_SETUP_SLOW_MS + 1);
    slow.end('ok');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('marks nothing when no set-up is in progress', () => {
    markDmSetup('stray');
    const trace = beginDmSetupTrace(PEER);
    trace.end('failed Error');
    expect(warn.mock.calls[0][0]).toContain('no stages');
  });
});
