import { useEffect, useState } from 'react';
import type { AudioRecorder, RecorderState } from 'expo-audio';

/** expo-audio's own change test: skip re-renders for sub-noise ticks. */
function hasChanged(prev: RecorderState, next: RecorderState): boolean {
  const meteringChanged =
    (prev.metering === undefined) !== (next.metering === undefined) ||
    (prev.metering !== undefined &&
      next.metering !== undefined &&
      Math.abs(prev.metering - next.metering) > 0.1);
  return (
    prev.canRecord !== next.canRecord ||
    prev.isRecording !== next.isRecording ||
    prev.mediaServicesDidReset !== next.mediaServicesDidReset ||
    prev.url !== next.url ||
    Math.abs(prev.durationMillis - next.durationMillis) > 50 ||
    meteringChanged
  );
}

/**
 * `useAudioRecorderState`, but it only polls while it matters. The stock hook
 * runs a `getStatus()` interval for as long as the recorder is mounted — every
 * 200 ms on the JS thread for the whole life of a chat screen, recording or
 * not. This one polls while `active` (the caller has started a recording) or
 * while the native side still reports one (a stop that hasn't landed yet),
 * and takes a fresh sample whenever `active` flips, so the final duration and
 * `isRecording: false` reach the UI as soon as the caller stops.
 */
export function useRecorderStatusWhileActive(
  recorder: Pick<AudioRecorder, 'getStatus'>,
  active: boolean,
  intervalMs = 200,
): RecorderState {
  const [state, setState] = useState<RecorderState>(() => recorder.getStatus());
  const polling = active || state.isRecording;
  useEffect(() => {
    const sample = () => {
      const next = recorder.getStatus();
      setState((prev) => (hasChanged(prev, next) ? next : prev));
    };
    sample();
    if (!polling) return;
    const id = setInterval(sample, intervalMs);
    return () => clearInterval(id);
    // `active` too: a stop is sampled at once, even while the last sample
    // still says recording (so `polling` itself hasn't changed).
  }, [recorder, active, polling, intervalMs]);
  return state;
}
