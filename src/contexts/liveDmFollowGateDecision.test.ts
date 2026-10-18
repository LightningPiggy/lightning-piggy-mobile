import {
  gateLiveDm,
  startFollowGateFallback,
  FOLLOW_GATE_TIMEOUT_MS,
} from './liveDmFollowGateDecision';
import { createLiveSubFollowGateBuffer } from './liveSubFollowGate';
import type { DmInboxEntry } from '../utils/conversationSummaries';

const MIDDLE = '4b2fcb4e3c30c1363c4af5e3a6adebfe93cd572c3d57c31aaa4479d908612036';
const entry: DmInboxEntry = {
  id: 'middle',
  partnerPubkey: MIDDLE,
  fromMe: false,
  createdAt: 100,
  text: 'hello',
  wireKind: 4,
};

it.each([4, 1059] as const)(
  'defers kind %s even with a nonempty cache, then replays once',
  (kind) => {
    const buffer = createLiveSubFollowGateBuffer();
    const input = {
      entry: { ...entry, wireKind: kind === 4 ? 4 : 14 },
      kind,
      follows: new Set(['b'.repeat(64)]),
      hydrated: false,
      buffer,
      fresh: true,
    };
    expect(gateLiveDm(input)).toBe('defer');
    expect(gateLiveDm(input)).toBe('defer');
    const replay = jest.fn();
    buffer.reevaluate(new Set([MIDDLE]), replay);
    buffer.reevaluate(new Set([MIDDLE]), replay);
    expect(replay).toHaveBeenCalledTimes(1);
    expect(buffer.size).toBe(0);
  },
);

it.each([4, 1059] as const)(
  'drops kind %s from a stranger only after hydration, including an empty set',
  (kind) => {
    const buffer = createLiveSubFollowGateBuffer();
    expect(
      gateLiveDm({ entry, kind, follows: new Set(), hydrated: true, buffer, fresh: true }),
    ).toBe('drop');
    expect(buffer.size).toBe(0);
  },
);

it('defers old kind-4 arrivals silently rather than losing them before hydration', () => {
  const buffer = createLiveSubFollowGateBuffer();
  expect(
    gateLiveDm({ entry, kind: 4, follows: new Set(), hydrated: false, buffer, fresh: false }),
  ).toBe('defer');
  const replay = jest.fn();
  buffer.reevaluate(new Set([MIDDLE]), replay);
  expect(replay.mock.calls[0][0].notify).toBeUndefined();
});

it('outgoing kind-4 bypasses hydration and never buffers', () => {
  const buffer = createLiveSubFollowGateBuffer();
  expect(
    gateLiveDm({
      entry: { ...entry, fromMe: true },
      kind: 4,
      follows: new Set(),
      hydrated: false,
      buffer,
      fresh: true,
      bypassOwn: true,
    }),
  ).toBe('pass');
  expect(buffer.size).toBe(0);
});

it('replays cached friends after 15 seconds offline and still recovers a later reconciliation', () => {
  jest.useFakeTimers();
  const buffer = createLiveSubFollowGateBuffer();
  const follows = { current: new Set([MIDDLE]) };
  const hydrated = { current: false };
  const replay = jest.fn();
  const fallback = startFollowGateFallback(follows, hydrated, buffer, replay);
  buffer.defer({ partnerPubkey: MIDDLE, entry });
  buffer.defer({
    partnerPubkey: 'b'.repeat(64),
    entry: { ...entry, id: 'later', partnerPubkey: 'b'.repeat(64) },
  });
  jest.advanceTimersByTime(FOLLOW_GATE_TIMEOUT_MS - 1);
  expect(replay).not.toHaveBeenCalled();
  jest.advanceTimersByTime(1);
  expect(replay).toHaveBeenCalledTimes(1);
  expect(hydrated.current).toBe(false);
  expect(fallback.ready()).toBe(true);
  hydrated.current = true;
  follows.current.add('b'.repeat(64));
  buffer.reevaluate(follows.current, replay);
  buffer.reevaluate(follows.current, replay);
  expect(replay).toHaveBeenCalledTimes(2);
  expect(buffer.size).toBe(0);
  fallback.dispose();
  jest.useRealTimers();
});

it('cancels the offline replay on teardown', () => {
  jest.useFakeTimers();
  const buffer = createLiveSubFollowGateBuffer();
  buffer.defer({ partnerPubkey: MIDDLE, entry });
  const replay = jest.fn();
  const fallback = startFollowGateFallback(
    { current: new Set([MIDDLE]) },
    { current: false },
    buffer,
    replay,
  );
  fallback.dispose();
  jest.advanceTimersByTime(FOLLOW_GATE_TIMEOUT_MS);
  expect(replay).not.toHaveBeenCalled();
  jest.useRealTimers();
});

// Babel strips console.log in NODE_ENV=test unless this diagnostic flag is set.
const diagnosticTest = process.env.EXPO_PUBLIC_KEEP_PERF_LOGS === '1' ? it : it.skip;
diagnosticTest.each([4, 1059] as const)('logs the exact deferral state for kind %s', (kind) => {
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(
      gateLiveDm({
        entry,
        kind,
        follows: new Set([MIDDLE]),
        hydrated: false,
        buffer: createLiveSubFollowGateBuffer(),
        fresh: false,
      }),
    ).toBe('defer');
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        `deferred by follow-gate (partner=4b2fcb4e, kind=${kind}, follows=1, hydrated=false, inSet=true, buffered=1)`,
      ),
    );
  } finally {
    log.mockRestore();
  }
});

it.each([true, false])(
  'passes a non-followed partner we have replied to (#1623, hydrated=%s)',
  (hydrated) => {
    const buffer = createLiveSubFollowGateBuffer();
    expect(
      gateLiveDm({
        entry: { ...entry, wireKind: 14 },
        kind: 1059,
        follows: new Set(),
        hydrated,
        buffer,
        fresh: true,
        replied: true,
      }),
    ).toBe('pass');
    expect(buffer.size).toBe(0);
  },
);
