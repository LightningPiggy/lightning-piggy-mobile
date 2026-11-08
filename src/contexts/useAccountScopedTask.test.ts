import { act, renderHook } from '@testing-library/react-native';
import { useAccountScopedTask } from './useAccountScopedTask';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

/** Render the hook with a re-renderable active account. */
const renderFor = (pk: string | null) =>
  renderHook(({ pk: active }: { pk: string | null }) => useAccountScopedTask(active), {
    initialProps: { pk },
  });

describe('useAccountScopedTask', () => {
  it('keeps the task while its account stays active', () => {
    const cancel = jest.fn();
    const { result, rerender } = renderFor(A);
    act(() => result.current(A, cancel));
    rerender({ pk: A });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancels the task when the active account switches away', () => {
    const cancel = jest.fn();
    const { result, rerender } = renderFor(A);
    act(() => result.current(A, cancel));
    rerender({ pk: B });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on logout', () => {
    const cancel = jest.fn();
    const { result, rerender } = renderFor(A);
    act(() => result.current(A, cancel));
    rerender({ pk: null });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cold start: a task tracked before the account commits survives that commit', () => {
    const cancel = jest.fn();
    const { result, rerender } = renderFor(null);
    act(() => result.current(A, cancel));
    rerender({ pk: A });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a task tracked after the account already moved on is cancelled at once', () => {
    const cancel = jest.fn();
    const { result } = renderHook(() => useAccountScopedTask(B));
    act(() => result.current(A, cancel));
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('tracking a new task cancels the previous one', () => {
    const first = jest.fn();
    const second = jest.fn();
    const { result } = renderHook(() => useAccountScopedTask(A));
    act(() => result.current(A, first));
    act(() => result.current(A, second));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
