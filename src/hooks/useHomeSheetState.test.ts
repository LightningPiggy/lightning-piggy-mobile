import { act, renderHook } from '@testing-library/react-native';
import { useHomeSheetState } from './useHomeSheetState';

describe('useHomeSheetState', () => {
  it('bumps the open key on every open, so re-opening a visible sheet re-runs its setup', () => {
    const { result } = renderHook(() => useHomeSheetState());
    expect(result.current.receive).toBeNull();
    act(() => result.current.actions.openReceive());
    expect(result.current.receive).toEqual({ visible: true, key: 1 });
    // A widget tap while Receive is still up.
    act(() => result.current.actions.openReceive());
    expect(result.current.receive).toEqual({ visible: true, key: 2 });
    act(() => result.current.closeReceive());
    expect(result.current.receive).toEqual({ visible: false, key: 2 });
  });

  it('carries the requested Send tab and bumps its key too', () => {
    const { result } = renderHook(() => useHomeSheetState());
    act(() => result.current.actions.openSend());
    expect(result.current.send).toEqual({ visible: true, key: 1 });
    act(() => result.current.actions.openSend({ mode: 'scan' }));
    expect(result.current.send).toEqual({ visible: true, key: 2, mode: 'scan' });
    act(() => result.current.closeSend());
    expect(result.current.send).toEqual({ visible: false, key: 2 });
    // A plain open after a scan open doesn't keep the old tab.
    act(() => result.current.actions.openSend());
    expect(result.current.send).toEqual({ visible: true, key: 3 });
  });
});
