/**
 * Unit tests for the foreground cache-activity notification hook.
 *
 * Pins the behaviours Copilot flagged on #760 and the resume-burst stagger
 * fix from #554:
 *
 *   1. Distinct notification copy per surface — a kind-7516 found-log
 *      says "New find on your cache" and fans out on the in-app event
 *      bus; a kind-1111 comment says "New comment on your cache" and
 *      does NOT broadcast.
 *   2. The freshness gate re-baselines to the moment the relay
 *      subscription is (re)armed, not just to effect-mount time — so the
 *      historical replay a relay sends for a *later* re-subscribe (coord
 *      set changed mid-session) can't slip past the gate and fire stale
 *      notifications.
 *   3. Resume-burst stagger (#554): on AppState → active the coord refetch
 *      is delayed by RESUME_REFETCH_DELAY_MS (3 s) so it doesn't compete
 *      with latency-sensitive work (DM re-arm, wallet refresh) on the JS
 *      thread. Timer is cancelled by backgrounding and by unmount.
 */
import { renderHook, act, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { VerifiedEvent } from 'nostr-tools';
import { useCacheNotifications } from './useCacheNotifications';
import {
  subscribeCacheCommentsForCoords,
  subscribeCacheFoundLogsForCoords,
} from '../services/cacheNotifySubscription';
import { fireCacheNotification } from '../services/notificationService';
import { fetchCachesByAuthor } from '../services/nostrPlacesPublisher';
import { notifyFoundLog } from './nostrEventBus';
import { notifyOwnCachesChanged } from '../services/ownCachesBus';

jest.mock('../services/cacheNotifySubscription', () => ({
  __esModule: true,
  subscribeCacheCommentsForCoords: jest.fn(() => jest.fn()),
  subscribeCacheFoundLogsForCoords: jest.fn(() => jest.fn()),
}));
jest.mock('../services/notificationService', () => ({
  __esModule: true,
  fireCacheNotification: jest.fn(async () => {}),
}));
jest.mock('../services/nostrPlacesPublisher', () => ({
  __esModule: true,
  fetchCachesByAuthor: jest.fn(),
}));
jest.mock('../services/nostrPlacesService', () => ({
  __esModule: true,
  // Any non-null return satisfies the hook's `if (!parsed) return` guard.
  parseCacheCoord: jest.fn((coord: string) => ({ coord })),
}));
jest.mock('./nostrEventBus', () => ({
  __esModule: true,
  notifyFoundLog: jest.fn(),
}));

const mockedComments = subscribeCacheCommentsForCoords as jest.Mock;
const mockedFoundLogs = subscribeCacheFoundLogsForCoords as jest.Mock;
const mockedFire = fireCacheNotification as jest.Mock;
const mockedFetch = fetchCachesByAuthor as jest.Mock;
const mockedNotifyFoundLog = notifyFoundLog as jest.Mock;

const VIEWER = 'viewer-pubkey-hex';
const OTHER = 'someone-else-hex';
const COORD_A = '37516:ownerA:cacheA';
const COORD_B = '37516:ownerA:cacheB';

/** Latest `onEvent` handler the found-log subscription was armed with. */
function latestFoundLogHandler(): (ev: VerifiedEvent) => void {
  return mockedFoundLogs.mock.calls.at(-1)![0].onEvent;
}
/** Latest `onEvent` handler the comment subscription was armed with. */
function latestCommentHandler(): (ev: VerifiedEvent) => void {
  return mockedComments.mock.calls.at(-1)![0].onEvent;
}

function makeEvent(
  over: Partial<VerifiedEvent>,
  coordKey: 'A' | 'a',
  coord: string,
): VerifiedEvent {
  return {
    id: `id-${Math.random()}`,
    pubkey: OTHER,
    created_at: Math.floor(Date.now() / 1000),
    kind: coordKey === 'a' ? 7516 : 1111,
    tags: [[coordKey, coord]],
    content: '',
    sig: 'sig',
    ...over,
  } as VerifiedEvent;
}

// Base wall-clock the fake-timer epoch is anchored to. A large value keeps
// the created_at arithmetic in the freshness-gate tests positive and avoids
// divide-by-zero / negative-timestamp edge cases in surrounding hook maths.
const FAKE_NOW_BASE = 1_000_000_000_000;

beforeEach(() => {
  jest.clearAllMocks();
  // Install fake timers and advance Date.now() together — `now` seeds
  // the epoch so that jest.advanceTimersByTime(N) also moves Date.now()
  // forward by N ms. This is required for the REFETCH_MIN_GAP_MS throttle
  // (which calls Date.now() internally) to be controllable from tests (#554).
  jest.useFakeTimers({ now: FAKE_NOW_BASE });
  // Spy AppState.addEventListener so the tests can read `.mock.calls` (the
  // hook registers a 'change' listener) and get back a real subscription
  // shape. Without this it's a real RN function and `.mock` is undefined
  // (Copilot #946).
  jest
    .spyOn(AppState, 'addEventListener')
    .mockReturnValue({ remove: jest.fn() } as unknown as ReturnType<
      typeof AppState.addEventListener
    >);
});

afterEach(() => {
  jest.useRealTimers();
  (AppState.addEventListener as jest.Mock).mockRestore?.();
});

describe('useCacheNotifications', () => {
  it('fires the found-log title and broadcasts on the event bus', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);

    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );

    await waitFor(() => expect(mockedFoundLogs).toHaveBeenCalled());

    const ev = makeEvent({}, 'a', COORD_A);
    act(() => latestFoundLogHandler()(ev));

    expect(mockedFire).toHaveBeenCalledWith(
      expect.objectContaining({ cacheCoord: COORD_A, title: 'New find on your cache' }),
    );
    expect(mockedNotifyFoundLog).toHaveBeenCalledWith(COORD_A, ev.id);
  });

  it('fires the comment-specific title and does not broadcast', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);

    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );

    await waitFor(() => expect(mockedComments).toHaveBeenCalled());

    const ev = makeEvent({}, 'A', COORD_A);
    act(() => latestCommentHandler()(ev));

    expect(mockedFire).toHaveBeenCalledWith(
      expect.objectContaining({ cacheCoord: COORD_A, title: 'New comment on your cache' }),
    );
    expect(mockedNotifyFoundLog).not.toHaveBeenCalled();
  });

  it('never notifies for the viewer’s own activity', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);

    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );
    await waitFor(() => expect(mockedFoundLogs).toHaveBeenCalled());

    act(() => latestFoundLogHandler()(makeEvent({ pubkey: VIEWER }, 'a', COORD_A)));

    expect(mockedFire).not.toHaveBeenCalled();
  });

  it('re-baselines the freshness gate on re-arm so pre-resubscribe replay stays silent', async () => {
    // First arm at T0 with coord A only. Use setSystemTime to move the fake
    // timer epoch — fake timers control Date.now() via jest.useFakeTimers({ now })
    // so we must use setSystemTime (not spyOn) to shift it (#554 test refactor).
    const t0 = 1_000_000_000; // seconds
    jest.setSystemTime(t0 * 1000);
    mockedFetch.mockResolvedValueOnce([{ coord: COORD_A }]);

    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );
    await waitFor(() => expect(mockedFoundLogs).toHaveBeenCalledTimes(1));

    // Coord set changes (a cache published mid-session) and an AppState
    // 'active' hop, ~1h later, re-arms the subscription. Jumping well past
    // REFETCH_MIN_GAP_MS (10s) + RESUME_REFETCH_DELAY_MS (3s) so both
    // throttle and stagger resolve in this tick.
    const t1 = t0 + 3600;
    jest.setSystemTime(t1 * 1000);
    mockedFetch.mockResolvedValueOnce([{ coord: COORD_A }, { coord: COORD_B }]);

    const appStateCall = (AppState.addEventListener as jest.Mock).mock.calls.find(
      (c) => c[0] === 'change',
    );
    await act(async () => {
      appStateCall![1]('active');
      // Resume-burst stagger (#554): the refetch is deferred by 3 s — advance
      // past it so the coord fetch actually runs within this test.
      jest.advanceTimersByTime(3_100);
    });
    await waitFor(() => expect(mockedFoundLogs).toHaveBeenCalledTimes(2));

    // Historical replay: an event created shortly after the first arm (T0)
    // but well before the re-arm (T1). Under the old mount-time baseline it
    // would pass; under the re-arm baseline it must be dropped.
    const staleReplay = makeEvent({ created_at: t0 + 60 }, 'a', COORD_B);
    act(() => latestFoundLogHandler()(staleReplay));
    expect(mockedFire).not.toHaveBeenCalled();

    // A genuinely fresh event (at the re-arm baseline) still fires.
    const fresh = makeEvent({ created_at: t1 }, 'a', COORD_B);
    act(() => latestFoundLogHandler()(fresh));
    expect(mockedFire).toHaveBeenCalledWith(
      expect.objectContaining({ cacheCoord: COORD_B, title: 'New find on your cache' }),
    );
  });
});

describe('resume-burst stagger (#554)', () => {
  /** Extract the AppState 'change' listener registered by the hook. */
  function getAppStateListener(): (s: string) => void {
    const call = (AppState.addEventListener as jest.Mock).mock.calls.find((c) => c[0] === 'change');
    return call![1];
  }

  it('does NOT call refetchAndRearm before 3 s after AppState active', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );
    // Wait for the mount-time refetch so fetch-call-count is stable.
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    // Advance past REFETCH_MIN_GAP_MS (10 s) so the throttle won't block,
    // then fire 'active' and advance to just BEFORE the 3 s stagger fires.
    jest.advanceTimersByTime(10_100);
    await act(async () => {
      getAppStateListener()('active');
      jest.advanceTimersByTime(2_900); // 2.9 s — stagger has NOT fired yet
    });

    // No second fetch should have been triggered yet (#554 — tap-dead wedge).
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('DOES call refetchAndRearm after the 3 s stagger elapses', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    jest.advanceTimersByTime(10_100); // past REFETCH_MIN_GAP_MS
    await act(async () => {
      getAppStateListener()('active');
      jest.advanceTimersByTime(3_100); // past RESUME_REFETCH_DELAY_MS
    });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });

  it('cancels the stagger timer when the app re-backgrounds before it fires', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    jest.advanceTimersByTime(10_100); // past REFETCH_MIN_GAP_MS
    const listener = getAppStateListener();

    await act(async () => {
      listener('active'); // stagger timer starts (3 s)
      jest.advanceTimersByTime(1_500); // mid-stagger
      listener('background'); // re-backgrounded — timer must be cleared
      jest.advanceTimersByTime(3_000); // stagger would have fired here
    });

    // The re-background must have cancelled the timer: no second fetch.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('cancels the stagger timer on unmount so it does not fire after teardown', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    const { unmount } = renderHook(() =>
      useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://relay'] }),
    );
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    jest.advanceTimersByTime(10_100); // past REFETCH_MIN_GAP_MS
    const listener = getAppStateListener();

    await act(async () => {
      listener('active'); // stagger timer starts
      jest.advanceTimersByTime(1_500); // mid-stagger
    });
    // Unmount (effect cleanup) must clear the timer.
    unmount();
    await act(async () => {
      jest.advanceTimersByTime(3_000); // stagger would have fired
    });

    // No second fetch should have run after unmount.
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

describe('event-driven own-caches rearm (#1016)', () => {
  it('refetches immediately on ownCachesBus notify, bypassing the resume-burst gap', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    renderHook(() => useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1)); // mount arm

    // A publish right after mount is inside REFETCH_MIN_GAP_MS — the forced
    // path must refetch anyway (that's the point of the event-driven re-arm).
    await act(async () => {
      notifyOwnCachesChanged();
    });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });

  it('queues (not overlaps) a force that lands while a pass is in flight', async () => {
    let resolveFirst!: (v: { coord: string }[]) => void;
    mockedFetch
      .mockReturnValueOnce(
        new Promise<{ coord: string }[]>((res) => {
          resolveFirst = res;
        }),
      )
      .mockResolvedValue([{ coord: COORD_A }]);
    renderHook(() => useCacheNotifications({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] }));
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1)); // pending

    // Two publishes mid-flight → no concurrent fetch fires…
    await act(async () => {
      notifyOwnCachesChanged();
      notifyOwnCachesChanged();
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // …and exactly ONE queued follow-up runs once the first pass settles.
    await act(async () => {
      resolveFirst([{ coord: COORD_A }]);
    });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    // No third call sneaks in behind the queued one.
    await act(async () => {});
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });
});

describe('relay-set keying (cold-start re-arm churn)', () => {
  type Props = { pubkey: string; getReadRelays: () => string[] };
  const renderWith = (initialProps: Props) =>
    renderHook((props: Props) => useCacheNotifications(props), { initialProps });

  it('does not re-arm or refetch when a new getter returns the same relays', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    const { rerender } = renderWith({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] });
    await waitFor(() => expect(mockedFoundLogs).toHaveBeenCalledTimes(1));

    // Same relays, new array and new getter (a re-parsed relay list).
    rerender({ pubkey: VIEWER, getReadRelays: () => ['wss://one/'] });
    rerender({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] });
    await act(async () => {});
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFoundLogs).toHaveBeenCalledTimes(1);
    expect(mockedComments).toHaveBeenCalledTimes(1);
  });

  it('re-arms on the new relays at once when the set changes, without bypassing the throttle', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    const { rerender } = renderWith({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] });
    await waitFor(() => expect(mockedFoundLogs).toHaveBeenCalledTimes(1));

    rerender({ pubkey: VIEWER, getReadRelays: () => ['wss://one', 'wss://two'] });
    await act(async () => {});
    // Re-subscribed on the new relay set straight away, reusing the coords
    // fetched moments ago instead of a second fetchCachesByAuthor.
    expect(mockedFoundLogs).toHaveBeenCalledTimes(2);
    expect(mockedFoundLogs.mock.calls.at(-1)![0]).toEqual(
      expect.objectContaining({ relays: ['wss://one', 'wss://two'], cacheCoords: [COORD_A] }),
    );
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // The throttle carried across the re-run: an AppState burst inside the gap
    // still doesn't fetch...
    const onChange = (AppState.addEventListener as jest.Mock).mock.calls.at(-1)![1];
    await act(async () => {
      onChange('active');
      jest.advanceTimersByTime(3_000);
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    // ...but one after the gap does.
    await act(async () => {
      jest.advanceTimersByTime(10_000);
      onChange('active');
      jest.advanceTimersByTime(3_000);
    });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
  });

  it('joins a fetch still in flight when the relay set changes instead of overlapping it', async () => {
    let resolveFirst!: (v: { coord: string }[]) => void;
    mockedFetch.mockReturnValueOnce(
      new Promise<{ coord: string }[]>((res) => {
        resolveFirst = res;
      }),
    );
    const { rerender } = renderWith({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));

    rerender({ pubkey: VIEWER, getReadRelays: () => ['wss://two'] });
    await act(async () => {
      resolveFirst([{ coord: COORD_B }]);
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    // Armed once, on the new relay set only.
    expect(mockedFoundLogs).toHaveBeenCalledTimes(1);
    expect(mockedFoundLogs.mock.calls[0][0]).toEqual(
      expect.objectContaining({ relays: ['wss://two'], cacheCoords: [COORD_B] }),
    );
  });

  it('fetches straight away for a new account, whatever the previous throttle', async () => {
    mockedFetch.mockResolvedValue([{ coord: COORD_A }]);
    const { rerender } = renderWith({ pubkey: VIEWER, getReadRelays: () => ['wss://one'] });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    rerender({ pubkey: OTHER, getReadRelays: () => ['wss://one'] });
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(2));
    expect(mockedFetch.mock.calls[1][0]).toBe(OTHER);
  });
});
