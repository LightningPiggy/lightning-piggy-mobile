import { act, renderHook } from '@testing-library/react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import { useLiveMessageIndicator, type LiveMessageEntry } from './useLiveMessageIndicator';
const scroll = (y: number, height = 1000, viewport = 400) =>
  ({
    nativeEvent: {
      contentOffset: { y, x: 0 },
      contentSize: { height, width: 300 },
      layoutMeasurement: { height: viewport, width: 300 },
    },
  }) as NativeSyntheticEvent<NativeScrollEvent>;
const entry = (id: string, createdAt: number) => ({ id, createdAt });
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());
it('follows a new message at the live edge after layout without flagging initial history', () => {
  const jump = jest.fn();
  const { result, rerender } = renderHook(
    ({ entries }: { entries: LiveMessageEntry[] }) =>
      useLiveMessageIndicator({ scope: 'a', entries, scrollToLatest: jump }),
    { initialProps: { entries: [entry('old', 10)] } },
  );
  expect(jump).not.toHaveBeenCalled();
  rerender({ entries: [entry('new', 11), entry('old', 10)] });
  act(() => jest.advanceTimersByTime(50));
  expect(jump).toHaveBeenCalledWith(true);
  expect(result.current.hasNewMessages).toBe(false);
});
it('keeps history in place, flags arrivals including equal timestamps, and clears on jump', () => {
  const jump = jest.fn();
  const { result, rerender } = renderHook(
    ({ entries }: { entries: LiveMessageEntry[] }) =>
      useLiveMessageIndicator({ scope: 'a', entries, scrollToLatest: jump }),
    { initialProps: { entries: [entry('old', 10)] } },
  );
  act(() => result.current.onScroll(scroll(500)));
  rerender({ entries: [entry('new', 10), entry('old', 10)] });
  act(() => jest.advanceTimersByTime(100));
  expect(jump).not.toHaveBeenCalled();
  expect(result.current.hasNewMessages).toBe(true);
  act(() => result.current.jumpToLatest());
  expect(jump).toHaveBeenCalledWith(true);
  expect(result.current.hasNewMessages).toBe(false);
});
it('does not flag older backfill or repeated rows and clears when manually reaching the edge', () => {
  const { result, rerender } = renderHook(
    ({ entries }: { entries: LiveMessageEntry[] }) =>
      useLiveMessageIndicator({ scope: 'a', entries, scrollToLatest: jest.fn() }),
    { initialProps: { entries: [entry('latest', 10)] } },
  );
  act(() => result.current.onScroll(scroll(500)));
  rerender({ entries: [entry('latest', 10), entry('history', 1)] });
  expect(result.current.hasNewMessages).toBe(false);
  rerender({ entries: [entry('new', 11), entry('latest', 10)] });
  expect(result.current.hasNewMessages).toBe(true);
  act(() => result.current.onScroll(scroll(0)));
  expect(result.current.hasNewMessages).toBe(false);
});
it('measures a normal group list from its end and never auto-scrolls away from history', () => {
  const jump = jest.fn();
  const { result, rerender } = renderHook(
    ({ entries }: { entries: LiveMessageEntry[] }) =>
      useLiveMessageIndicator({ scope: 'group', entries, edge: 'end', scrollToLatest: jump }),
    { initialProps: { entries: [entry('old', 1)] } },
  );
  act(() => result.current.onScroll(scroll(0)));
  rerender({ entries: [entry('old', 1), entry('new', 2)] });
  act(() => result.current.onContentSizeChange());
  expect(jump).not.toHaveBeenCalled();
  expect(result.current.hasNewMessages).toBe(true);
  act(() => result.current.onScroll(scroll(600)));
  expect(result.current.hasNewMessages).toBe(false);
  act(() => result.current.onContentSizeChange());
  expect(jump).toHaveBeenCalledWith(false);
});
it('resets the indicator and baseline on account/thread/filter changes and ignores loading hydration', () => {
  const { result, rerender } = renderHook(
    ({
      scope,
      entries,
      loading,
    }: {
      scope: string;
      entries: LiveMessageEntry[];
      loading: boolean;
    }) => useLiveMessageIndicator({ scope, entries, loading, scrollToLatest: jest.fn() }),
    { initialProps: { scope: 'a', entries: [entry('old', 1)], loading: false } },
  );
  act(() => result.current.onScroll(scroll(500)));
  rerender({ scope: 'a', entries: [entry('new', 2)], loading: false });
  expect(result.current.hasNewMessages).toBe(true);
  rerender({ scope: 'b', entries: [entry('history', 50)], loading: true });
  expect(result.current.hasNewMessages).toBe(false);
  expect(result.current.atEdge).toBe(true);
  rerender({ scope: 'b', entries: [entry('history', 50)], loading: false });
  expect(result.current.hasNewMessages).toBe(false);
  expect(result.current.atEdge).toBe(true);
});
it('cancels deferred scrolling on unmount or if the user leaves the edge', () => {
  const jump = jest.fn();
  const { result, rerender, unmount } = renderHook(
    ({ entries }: { entries: LiveMessageEntry[] }) =>
      useLiveMessageIndicator({ scope: 'a', entries, scrollToLatest: jump }),
    { initialProps: { entries: [entry('old', 1)] } },
  );
  rerender({ entries: [entry('new', 2)] });
  act(() => result.current.onScroll(scroll(500)));
  act(() => jest.advanceTimersByTime(50));
  expect(jump).not.toHaveBeenCalled();
  act(() => result.current.onScroll(scroll(0)));
  rerender({ entries: [entry('newer', 3)] });
  unmount();
  act(() => jest.advanceTimersByTime(50));
  expect(jump).not.toHaveBeenCalled();
});

it('preserves a pending live-edge scroll across delivery-status renders', () => {
  const jump = jest.fn();
  const { rerender } = renderHook(
    ({ entries }: { entries: LiveMessageEntry[] }) =>
      useLiveMessageIndicator({ scope: 'a', entries, scrollToLatest: jump }),
    { initialProps: { entries: [entry('old', 1)] } },
  );
  rerender({ entries: [entry('new', 2), entry('old', 1)] });
  act(() => jest.advanceTimersByTime(25));
  rerender({ entries: [entry('new', 2), entry('old', 1)] });
  act(() => jest.advanceTimersByTime(25));
  expect(jump).toHaveBeenCalledTimes(1);
  expect(jump).toHaveBeenCalledWith(true);
});
it('cancels a pending scroll when the conversation changes during loading', () => {
  const jump = jest.fn();
  const { rerender } = renderHook(
    ({
      scope,
      entries,
      loading,
    }: {
      scope: string;
      entries: LiveMessageEntry[];
      loading: boolean;
    }) => useLiveMessageIndicator({ scope, entries, loading, scrollToLatest: jump }),
    { initialProps: { scope: 'a', entries: [entry('old', 1)], loading: false } },
  );
  rerender({ scope: 'a', entries: [entry('new', 2)], loading: false });
  rerender({ scope: 'b', entries: [], loading: true });
  act(() => jest.advanceTimersByTime(50));
  expect(jump).not.toHaveBeenCalled();
});

describe('a jump that lands (first unread / a mention)', () => {
  const setup = () => {
    const jump = jest.fn();
    const hook = renderHook(
      ({ entries }: { entries: LiveMessageEntry[] }) =>
        useLiveMessageIndicator({ scope: 'a', entries, scrollToLatest: jump }),
      { initialProps: { entries: [entry('old', 10)] } },
    );
    return { jump, ...hook };
  };

  it('lands at the live edge: no arrow once the hold ends, even without another scroll', () => {
    const { result } = setup();
    act(() => result.current.leaveEdge(500));
    expect(result.current.atEdge).toBe(false);
    act(() => result.current.onScroll(scroll(0))); // the jump landed at the edge
    expect(result.current.atEdge).toBe(false); // still holding
    act(() => jest.advanceTimersByTime(500));
    expect(result.current.atEdge).toBe(true);
  });

  it("opens at the edge and the jump doesn't move the list: no arrow once the hold ends", () => {
    const { result } = setup();
    act(() => result.current.leaveEdge(500)); // no scroll event at all
    act(() => jest.advanceTimersByTime(500));
    expect(result.current.atEdge).toBe(true);
  });

  it('a list whose edge is its end, with no scroll event yet, keeps the arrow', () => {
    const { result } = renderHook(() =>
      useLiveMessageIndicator({
        scope: 'a',
        entries: [entry('old', 10)],
        edge: 'end',
        scrollToLatest: jest.fn(),
      }),
    );
    act(() => result.current.leaveEdge(500));
    act(() => jest.advanceTimersByTime(500));
    expect(result.current.atEdge).toBe(false);
  });

  it('a message that arrives during the hold is scrolled into view when it lands at the edge', () => {
    const { result, rerender, jump } = setup();
    act(() => result.current.leaveEdge(500));
    act(() => result.current.onScroll(scroll(0)));
    rerender({ entries: [entry('new', 20), entry('old', 10)] });
    expect(result.current.hasNewMessages).toBe(true);
    act(() => jest.advanceTimersByTime(500));
    expect(result.current.hasNewMessages).toBe(false);
    expect(jump).toHaveBeenCalledWith(true);
  });

  it('landing at the edge with nothing new does not scroll', () => {
    const { result, jump } = setup();
    act(() => result.current.leaveEdge(500));
    act(() => result.current.onScroll(scroll(0)));
    act(() => jest.advanceTimersByTime(500));
    expect(jump).not.toHaveBeenCalled();
  });

  it('lands in history: the arrow stays', () => {
    const { result } = setup();
    act(() => result.current.leaveEdge(500));
    act(() => result.current.onScroll(scroll(500)));
    act(() => jest.advanceTimersByTime(500));
    expect(result.current.atEdge).toBe(false);
  });

  it('after landing at the edge, a new message is followed rather than flagged', () => {
    const { result, rerender, jump } = setup();
    act(() => result.current.leaveEdge(500));
    act(() => result.current.onScroll(scroll(0)));
    act(() => jest.advanceTimersByTime(500));
    rerender({ entries: [entry('new', 20), entry('old', 10)] });
    act(() => jest.advanceTimersByTime(100));
    expect(result.current.hasNewMessages).toBe(false);
    expect(jump).toHaveBeenCalledWith(true);
  });
});
