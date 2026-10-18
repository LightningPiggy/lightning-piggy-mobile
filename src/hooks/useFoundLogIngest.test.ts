/**
 * Unit tests for useFoundLogIngest (extracted from HuntPiggyDetailScreen,
 * #1029/#739).
 *
 * Focus: the hook is reused across `coord` changes (HuntPiggyDetailScreen
 * doesn't remount on navigation between caches), so its two coalesced
 * subscriptions share refs (`pendingLogsRef`/`pendingZapsRef`,
 * `logFlushTimerRef`/`zapFlushTimerRef`) across effect instances. Pins:
 *
 *   1. A `coord` change resubscribes with the new coord.
 *   2. A `coord` change resets `logs`/`zapsByLog`/`zapTotalsByLog` to empty
 *      immediately — a reused hook never shows the previous cache's data.
 *   3. Pending (not-yet-flushed) logs/zaps buffered for the old coord are
 *      dropped on a coord change, not carried into the new coord's state.
 *   4. A found-log event delivered after the effect has been superseded by
 *      a coord change is ignored (cancelled-callback guard).
 */
import { renderHook, act } from '@testing-library/react-native';
import { useFoundLogIngest, type UseFoundLogIngestResult } from './useFoundLogIngest';
import { subscribeFoundLogs } from '../services/nostrPlacesPublisher';
import { subscribeFindLogZaps } from '../services/findLogZapsService';
import { parseFoundLog, type FoundLog } from '../utils/foundLog';
import type { VerifiedEvent } from 'nostr-tools';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));

jest.mock('../services/nostrPlacesPublisher', () => ({
  subscribeFoundLogs: jest.fn(),
}));
jest.mock('../services/findLogZapsService', () => ({
  subscribeFindLogZaps: jest.fn(),
}));
// parseFoundLog's own tag-parsing is covered by foundLog.test.ts — here we
// stub it to a passthrough so tests can hand the hook FoundLog-shaped
// fixtures directly instead of building real VerifiedEvent tag arrays.
jest.mock('../utils/foundLog', () => ({
  parseFoundLog: jest.fn((e: unknown) => e as FoundLog),
}));

const mockedSubscribeFoundLogs = subscribeFoundLogs as jest.MockedFunction<
  typeof subscribeFoundLogs
>;
const mockedSubscribeFindLogZaps = subscribeFindLogZaps as jest.MockedFunction<
  typeof subscribeFindLogZaps
>;
const mockedParseFoundLog = parseFoundLog as jest.MockedFunction<typeof parseFoundLog>;

function makeLog(id: string): FoundLog {
  return {
    id,
    pubkey: 'p'.repeat(64),
    createdAt: 1_700_000_000,
    content: `log ${id}`,
    imageUrl: null,
    amountSats: null,
  };
}

type FoundLogsHandler = (event: VerifiedEvent) => void;
type ZapsHandler = (zap: { receiptId: string; logId: string; sats: number }) => void;

describe('useFoundLogIngest — coord changes', () => {
  let logsCloser: jest.Mock;
  let zapsCloser: jest.Mock;
  let logsHandlers: FoundLogsHandler[];
  let zapsHandlers: ZapsHandler[];
  let coordsSubscribed: string[];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    logsCloser = jest.fn();
    zapsCloser = jest.fn();
    logsHandlers = [];
    zapsHandlers = [];
    coordsSubscribed = [];
    mockedParseFoundLog.mockImplementation((e: unknown) => e as FoundLog);
    mockedSubscribeFoundLogs.mockImplementation((coord, onEvent) => {
      coordsSubscribed.push(coord);
      logsHandlers.push(onEvent);
      return logsCloser;
    });
    mockedSubscribeFindLogZaps.mockImplementation((_logIds, onZap) => {
      zapsHandlers.push(onZap);
      return zapsCloser;
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resubscribes to the new coord when `coord` changes', () => {
    const { rerender } = renderHook<UseFoundLogIngestResult, { coord: string }>(
      ({ coord }) => useFoundLogIngest(coord),
      {
        initialProps: { coord: 'coordA' },
      },
    );
    expect(coordsSubscribed).toEqual(['coordA']);
    expect(logsCloser).not.toHaveBeenCalled();

    rerender({ coord: 'coordB' });

    expect(coordsSubscribed).toEqual(['coordA', 'coordB']);
    // The old coord's subscription was torn down.
    expect(logsCloser).toHaveBeenCalledTimes(1);
  });

  it('resets logs, zapsByLog and zapTotalsByLog immediately when coord changes', () => {
    const { result, rerender } = renderHook<UseFoundLogIngestResult, { coord: string }>(
      ({ coord }) => useFoundLogIngest(coord),
      {
        initialProps: { coord: 'coordA' },
      },
    );

    // Deliver + flush a found-log for coordA.
    act(() => {
      logsHandlers[0](makeLog('log1') as unknown as VerifiedEvent);
      jest.advanceTimersByTime(150);
    });
    expect(result.current.logs.size).toBe(1);
    expect(result.current.sortedLogs).toHaveLength(1);

    // The logIdsKey effect has now (re)subscribed to zaps for log1 — deliver
    // + flush a zap receipt against it.
    expect(zapsHandlers.length).toBeGreaterThan(0);
    act(() => {
      zapsHandlers[zapsHandlers.length - 1]({ receiptId: 'r1', logId: 'log1', sats: 21 });
      jest.advanceTimersByTime(150);
    });
    expect(result.current.zapTotalsByLog.get('log1')).toBe(21);

    // Coord change — a reused hook must not keep showing coordA's cache.
    act(() => {
      rerender({ coord: 'coordB' });
    });

    expect(result.current.logs.size).toBe(0);
    expect(result.current.sortedLogs).toHaveLength(0);
    expect(result.current.zapsByLog.size).toBe(0);
    expect(result.current.zapTotalsByLog.size).toBe(0);
  });

  it('an all-duplicate zap batch flushes without cloning zapsByLog (identity preserved)', () => {
    const { result } = renderHook<UseFoundLogIngestResult, { coord: string }>(
      ({ coord }) => useFoundLogIngest(coord),
      {
        initialProps: { coord: 'coordA' },
      },
    );

    // Seed one log + one zap receipt.
    act(() => {
      logsHandlers[0](makeLog('log1') as unknown as VerifiedEvent);
      jest.advanceTimersByTime(150);
    });
    act(() => {
      zapsHandlers[zapsHandlers.length - 1]({ receiptId: 'r1', logId: 'log1', sats: 21 });
      jest.advanceTimersByTime(150);
    });
    const before = result.current.zapsByLog;
    expect(before.get('log1')?.get('r1')).toBe(21);

    // The same receipt echoed again from another relay — the flush must
    // dedupe it WITHOUT allocating a new outer Map (lazy-clone path).
    act(() => {
      zapsHandlers[zapsHandlers.length - 1]({ receiptId: 'r1', logId: 'log1', sats: 21 });
      jest.advanceTimersByTime(150);
    });
    expect(result.current.zapsByLog).toBe(before);
    expect(result.current.zapTotalsByLog.get('log1')).toBe(21);
  });

  it('drops a log buffered (but not yet flushed) for the old coord on a coord change', () => {
    const { result, rerender } = renderHook<UseFoundLogIngestResult, { coord: string }>(
      ({ coord }) => useFoundLogIngest(coord),
      {
        initialProps: { coord: 'coordA' },
      },
    );

    // Event arrives but the 150ms coalescing timer hasn't fired yet.
    act(() => {
      logsHandlers[0](makeLog('stale') as unknown as VerifiedEvent);
    });
    expect(result.current.logs.size).toBe(0); // still pending, not flushed

    act(() => {
      rerender({ coord: 'coordB' });
      // Advance past where the old timer would have fired had it survived.
      jest.advanceTimersByTime(150);
    });

    // The stale, pre-coord-change log never makes it into state.
    expect(result.current.logs.size).toBe(0);
  });

  it('ignores a found-log event delivered after the effect instance is superseded', () => {
    const { result, rerender } = renderHook<UseFoundLogIngestResult, { coord: string }>(
      ({ coord }) => useFoundLogIngest(coord),
      {
        initialProps: { coord: 'coordA' },
      },
    );
    const staleHandler = logsHandlers[0];

    act(() => {
      rerender({ coord: 'coordB' });
    });

    // A relay event for the torn-down coordA subscription arrives late.
    act(() => {
      staleHandler(makeLog('too-late') as unknown as VerifiedEvent);
      jest.advanceTimersByTime(150);
    });

    expect(result.current.logs.size).toBe(0);
  });
});
