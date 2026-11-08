import { act, renderHook } from '@testing-library/react-native';
import type { RecorderState } from 'expo-audio';
import { useRecorderStatusWhileActive } from './useRecorderStatusWhileActive';

const idle: RecorderState = {
  canRecord: true,
  isRecording: false,
  durationMillis: 0,
  mediaServicesDidReset: false,
  url: null,
};

function fakeRecorder() {
  let status: RecorderState = idle;
  const getStatus = jest.fn(() => status);
  return {
    recorder: { getStatus },
    getStatus,
    set: (next: Partial<RecorderState>) => {
      status = { ...status, ...next };
    },
  };
}

describe('useRecorderStatusWhileActive', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does not poll while no recording is in progress', () => {
    const { recorder, getStatus } = fakeRecorder();
    renderHook(() => useRecorderStatusWhileActive(recorder, false, 200));
    const callsAfterMount = getStatus.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(getStatus).toHaveBeenCalledTimes(callsAfterMount);
  });

  it('polls while active and takes a final sample when it stops', () => {
    const fake = fakeRecorder();
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useRecorderStatusWhileActive(fake.recorder, active, 200),
      { initialProps: { active: false } },
    );
    fake.set({ isRecording: true });
    rerender({ active: true });
    expect(result.current.isRecording).toBe(true);
    fake.set({ durationMillis: 1_000 });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current.durationMillis).toBe(1_000);

    fake.set({ isRecording: false, durationMillis: 1_150 });
    rerender({ active: false });
    expect(result.current).toMatchObject({ isRecording: false, durationMillis: 1_150 });
    const callsAfterStop = fake.getStatus.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(fake.getStatus).toHaveBeenCalledTimes(callsAfterStop);
  });

  it('keeps polling until a stop that has not landed yet is reported', () => {
    const fake = fakeRecorder();
    fake.set({ isRecording: true });
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useRecorderStatusWhileActive(fake.recorder, active, 200),
      { initialProps: { active: true } },
    );
    rerender({ active: false });
    expect(result.current.isRecording).toBe(true);
    fake.set({ isRecording: false });
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(result.current.isRecording).toBe(false);
    const callsAfterStop = fake.getStatus.mock.calls.length;
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(fake.getStatus).toHaveBeenCalledTimes(callsAfterStop);
  });
});
