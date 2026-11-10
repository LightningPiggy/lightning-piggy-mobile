/**
 * Unit tests for the relay-event coalescing hook.
 *
 * `useCoalescedMap` batches a burst of per-item `enqueue` calls into one React
 * state commit per flush window — the cold-start perf fix shared by HuntScreen
 * and EventsScreen (audit MED 3/4). The contract worth pinning down:
 *
 *   1. A burst under the threshold commits once, after the debounce window.
 *   2. Hitting the threshold flushes early (synchronously) without waiting.
 *   3. `shouldReplace` drops stale items both while staged AND against state
 *      already committed (a late stale event can't clobber a fresher one).
 *   4. `flush()` drains the pending buffer immediately (used on sub teardown).
 *   5. `setMap` replaces committed state outright (hydrate / clear paths).
 */
import { renderHook, act } from '@testing-library/react-native';
import { useCoalescedMap } from './useCoalescedMap';

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('useCoalescedMap', () => {
  it('coalesces a sub-threshold burst into one commit after the debounce', () => {
    const { result } = renderHook(() => useCoalescedMap<number>({ flushMs: 100 }));

    // Nothing committed yet immediately after enqueue.
    act(() => {
      result.current.enqueue('a', 1);
      result.current.enqueue('b', 2);
      result.current.enqueue('c', 3);
    });
    expect(result.current.map.size).toBe(0);

    // One commit once the window elapses, carrying the whole batch.
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.map.size).toBe(3);
    expect(result.current.map.get('b')).toBe(2);
  });

  it('flushes early (synchronously) once the threshold is reached', () => {
    const { result } = renderHook(() =>
      useCoalescedMap<number>({ flushMs: 1000, flushThreshold: 3 }),
    );
    act(() => {
      result.current.enqueue('a', 1);
      result.current.enqueue('b', 2);
      // Third enqueue hits threshold → flushes without advancing timers.
      result.current.enqueue('c', 3);
    });
    expect(result.current.map.size).toBe(3);
  });

  it('drops a stale item per shouldReplace — both staged and committed', () => {
    const { result } = renderHook(() =>
      useCoalescedMap<{ v: number; ts: number }>({
        flushMs: 100,
        // Newest timestamp wins.
        shouldReplace: (existing, incoming) => incoming.ts > existing.ts,
      }),
    );

    // Staged-buffer dedupe: the older ts must not overwrite the newer one
    // before the flush.
    act(() => {
      result.current.enqueue('x', { v: 2, ts: 200 });
      result.current.enqueue('x', { v: 1, ts: 100 });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.map.get('x')).toEqual({ v: 2, ts: 200 });

    // Committed-state dedupe: a late stale event arriving AFTER the newer one
    // was committed is dropped in the flush merge too.
    act(() => {
      result.current.enqueue('x', { v: 1, ts: 100 });
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    expect(result.current.map.get('x')).toEqual({ v: 2, ts: 200 });
  });

  it('keeps the committed Map identity when a replayed batch is all rejected', () => {
    const { result } = renderHook(() =>
      useCoalescedMap<{ ts: number }>({
        flushMs: 100,
        flushThreshold: 2,
        shouldReplace: (existing, incoming) => incoming.ts > existing.ts,
      }),
    );
    act(() => {
      result.current.enqueue('a', { ts: 1 });
      result.current.enqueue('b', { ts: 1 });
    });
    const committed = result.current.map;
    // A relay replaying the same events (e.g. MapScreen resubscribing on
    // refocus) hits the threshold but must not commit an identical clone —
    // returning `prev` lets React bail out and keeps consumers' memos
    // (MapScreen's useMapPins) cached. Repeat to cover successive batches.
    for (let i = 0; i < 3; i++) {
      act(() => {
        result.current.enqueue('a', { ts: 1 });
        result.current.enqueue('b', { ts: 0 });
      });
      expect(result.current.map).toBe(committed);
    }
    // A genuinely newer event in a later batch still commits.
    act(() => {
      result.current.enqueue('a', { ts: 2 });
      result.current.flush();
    });
    expect(result.current.map).not.toBe(committed);
    expect(result.current.map.get('a')).toEqual({ ts: 2 });
  });

  it('flush() drains the pending buffer immediately', () => {
    const { result } = renderHook(() => useCoalescedMap<number>({ flushMs: 5000 }));
    act(() => {
      result.current.enqueue('a', 1);
      result.current.flush();
    });
    expect(result.current.map.get('a')).toBe(1);
  });

  it('setMap replaces committed state outright', () => {
    const { result } = renderHook(() =>
      useCoalescedMap<number>({ initial: () => new Map([['seed', 9]]) }),
    );
    expect(result.current.map.get('seed')).toBe(9);
    act(() => {
      result.current.setMap(new Map([['fresh', 1]]));
    });
    expect(result.current.map.has('seed')).toBe(false);
    expect(result.current.map.get('fresh')).toBe(1);
  });

  it('reset() clears committed state AND discards the staged buffer (no late repopulate)', () => {
    const { result } = renderHook(() => useCoalescedMap<number>({ flushMs: 100 }));
    // Commit one item, then stage another that hasn't flushed yet.
    act(() => {
      result.current.enqueue('a', 1);
      jest.advanceTimersByTime(100);
    });
    expect(result.current.map.get('a')).toBe(1);
    act(() => {
      result.current.enqueue('b', 2); // staged, debounce not yet elapsed
      result.current.reset(); // clears committed 'a' AND drops staged 'b'
    });
    expect(result.current.map.size).toBe(0);
    // Advancing past the old debounce must NOT repopulate from the dropped buffer.
    act(() => {
      jest.advanceTimersByTime(500);
    });
    expect(result.current.map.size).toBe(0);
  });

  it('maxSize caps the committed Map, evicting oldest-inserted entries on flush', () => {
    const { result } = renderHook(() => useCoalescedMap<number>({ flushMs: 100, maxSize: 3 }));
    act(() => {
      result.current.enqueue('a', 1);
      result.current.enqueue('b', 2);
      result.current.enqueue('c', 3);
      result.current.enqueue('d', 4);
      result.current.enqueue('e', 5);
      result.current.flush();
    });
    // The two oldest-inserted (a, b) are evicted; the newest three remain.
    expect(result.current.map.size).toBe(3);
    expect(result.current.map.has('a')).toBe(false);
    expect(result.current.map.has('b')).toBe(false);
    expect([...result.current.map.keys()]).toEqual(['c', 'd', 'e']);
  });

  it('maxSize caps the initial seed too — not just flushes', () => {
    const { result } = renderHook(() =>
      useCoalescedMap<number>({
        maxSize: 2,
        initial: () =>
          new Map([
            ['a', 1],
            ['b', 2],
            ['c', 3],
          ]),
      }),
    );
    // Over-cap seed is trimmed oldest-first immediately, before any flush.
    expect(result.current.map.size).toBe(2);
    expect(result.current.map.has('a')).toBe(false);
    expect([...result.current.map.keys()]).toEqual(['b', 'c']);
  });

  it('evictBy keeps the highest-ranked entries, not the latest to arrive (#1789)', () => {
    // Two relays answering newest-first, interleaved: today's finds from the
    // first must survive older ones that arrive later.
    const { result } = renderHook(() =>
      useCoalescedMap<{ createdAt: number }>({
        maxSize: 2,
        evictBy: (v) => v.createdAt,
      }),
    );
    act(() => {
      result.current.enqueue('new1', { createdAt: 300 });
      result.current.enqueue('new2', { createdAt: 200 });
      result.current.flush();
    });
    act(() => {
      result.current.enqueue('old1', { createdAt: 50 });
      result.current.enqueue('mid', { createdAt: 250 });
      result.current.flush();
    });
    expect([...result.current.map.keys()].sort()).toEqual(['mid', 'new1']);
  });
});
