import { idleScheduler } from '../utils/idleScheduler';
import { scheduleColdStartBackfill } from './dmColdStartBackfill';
import type { RefreshDmInboxOptions } from './nostrContextTypes';

describe('scheduleColdStartBackfill', () => {
  let runWhenIdleSpy: jest.SpyInstance;

  beforeEach(() => {
    // Run the deferred callback synchronously so assertions see the call.
    runWhenIdleSpy = jest.spyOn(idleScheduler, 'runWhenIdle').mockImplementation((task) => {
      if (typeof task === 'function') task();
      return {
        then: () => Promise.resolve(),
        done: () => undefined,
        cancel: () => undefined,
      };
    });
  });

  afterEach(() => {
    runWhenIdleSpy.mockRestore();
  });

  const makeRefreshRef = () => {
    const refresh = jest.fn<Promise<void>, [RefreshDmInboxOptions?]>(() => Promise.resolve());
    return { refresh, ref: { current: refresh } };
  };

  it('re-invokes the refresh as a backfill, NOT a force — force inherited the #743 skip-set bypass and caused the every-cold-start decrypt sweep (#846)', () => {
    const { refresh, ref } = makeRefreshRef();
    scheduleColdStartBackfill({ isColdStart: true, includeNonFollows: false, refreshRef: ref });
    expect(refresh).toHaveBeenCalledTimes(1);
    const opts = refresh.mock.calls[0][0]!;
    expect(opts.backfill).toBe(true);
    expect(opts.force).toBeUndefined();
    expect(opts.includeNonFollows).toBe(false);
  });

  it('threads includeNonFollows through so the dev "Following only=off" pass keeps its semantics', () => {
    const { refresh, ref } = makeRefreshRef();
    scheduleColdStartBackfill({ isColdStart: true, includeNonFollows: true, refreshRef: ref });
    const opts = refresh.mock.calls[0][0]!;
    expect(opts.includeNonFollows).toBe(true);
  });

  it('does nothing when the triggering refresh was not a cold start (no recursion)', () => {
    const { refresh, ref } = makeRefreshRef();
    scheduleColdStartBackfill({ isColdStart: false, includeNonFollows: false, refreshRef: ref });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('does nothing when the signal already aborted (tab blur before scheduling)', () => {
    const { refresh, ref } = makeRefreshRef();
    const ctrl = new AbortController();
    ctrl.abort();
    scheduleColdStartBackfill({
      isColdStart: true,
      signal: ctrl.signal,
      includeNonFollows: false,
      refreshRef: ref,
    });
    expect(refresh).not.toHaveBeenCalled();
  });
});
