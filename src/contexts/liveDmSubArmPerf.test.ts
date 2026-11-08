import { perfLog } from '../utils/perfLog';
import { liveDmSubArmReason, noteLiveDmSubArm } from './liveDmSubArmPerf';

jest.mock('../utils/perfLog', () => ({ PERF_LOGS_ENABLED: true, perfLog: jest.fn() }));

const inputs = (over: Partial<{ viewer: string; signer: string; relaysKey: string }> = {}) => ({
  viewer: 'a',
  signer: 'nsec',
  relaysKey: 'wss://one/',
  ...over,
});

describe('liveDmSubArmReason', () => {
  it('names what changed since the previous arm', () => {
    expect(liveDmSubArmReason(null, inputs())).toBe('first');
    expect(liveDmSubArmReason(inputs(), inputs({ viewer: 'b' }))).toBe('account');
    expect(liveDmSubArmReason(inputs(), inputs({ signer: 'amber' }))).toBe('signer');
    expect(liveDmSubArmReason(inputs(), inputs({ relaysKey: 'wss://two/' }))).toBe('relays');
    expect(liveDmSubArmReason(inputs(), inputs())).toBe('same-inputs');
  });
});

describe('noteLiveDmSubArm', () => {
  it('logs a numbered perf line per arm with the reason', () => {
    noteLiveDmSubArm('a', 'nsec', ['wss://one']);
    noteLiveDmSubArm('a', 'nsec', ['wss://one/']);
    noteLiveDmSubArm('a', 'nsec', ['wss://one', 'wss://two']);
    noteLiveDmSubArm('b', 'nsec', ['wss://one', 'wss://two']);
    expect(jest.mocked(perfLog).mock.calls.map((c) => c[0])).toEqual([
      'liveDmSub arm #1 reason=first relays=1',
      'liveDmSub arm #2 reason=same-inputs relays=1',
      'liveDmSub arm #3 reason=relays relays=2',
      'liveDmSub arm #4 reason=account relays=2',
    ]);
  });
});
