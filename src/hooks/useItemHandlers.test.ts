import { renderHook } from '@testing-library/react-native';
import { useItemHandlers } from './useItemHandlers';

type Row = { id: string };

it('returns the same handlers for the same row until a builder changes', () => {
  const longPress = jest.fn((row: Row) => () => row.id);
  const toggle = jest.fn((row: Row) => (emoji: string) => `${row.id}:${emoji}`);
  const { result, rerender } = renderHook(
    ({ lp, tr }: { lp: typeof longPress; tr: typeof toggle }) => useItemHandlers(lp, tr),
    { initialProps: { lp: longPress, tr: toggle } },
  );
  const row = { id: 'a' };
  const first = result.current(row);
  expect(result.current(row)).toBe(first);
  expect(first.onLongPress()).toBe('a');
  expect(first.onToggleReaction('+')).toBe('a:+');
  expect(longPress).toHaveBeenCalledTimes(1);

  // Re-render with the same builders: still cached.
  rerender({ lp: longPress, tr: toggle });
  expect(result.current(row)).toBe(first);

  // A new row object (its data changed) gets fresh handlers.
  expect(result.current({ id: 'a' })).not.toBe(first);

  // A new builder (e.g. new reaction state) rebuilds.
  const longPress2 = jest.fn((r: Row) => () => `${r.id}!`);
  rerender({ lp: longPress2, tr: toggle });
  const next = result.current(row);
  expect(next).not.toBe(first);
  expect(next.onLongPress()).toBe('a!');
});
