// Stage timings for setting up a Marmot 1:1 (#1658), so a hang on a user's
// phone can be pinned to its stage from `adb logcat`:
//
//   adb logcat | grep MarmotDiag
//
// Marks go to every set-up in progress; each set-up ends with ONE
// `console.warn` line (kept in release builds) when it failed, timed out or
// took longer than SLOW_MS. Quick, successful ones log only in dev. Marks
// carry stage names, counts, event kinds and timings: never keys, event
// content or full pubkeys.

/** A set-up slower than this is logged even when it succeeds. */
export const DM_SETUP_SLOW_MS = 5_000;

interface Trace {
  peer: string;
  startedAt: number;
  marks: string[];
}

const active = new Set<Trace>();
const MAX_MARKS = 40;

export interface DmSetupTrace {
  end(outcome: string): void;
}

/** Start tracing a 1:1 set-up with `peer` (logged by its first 8 hex chars). */
export function beginDmSetupTrace(peer: string): DmSetupTrace {
  const trace: Trace = { peer: peer.slice(0, 8), startedAt: Date.now(), marks: [] };
  active.add(trace);
  let ended = false;
  return {
    end(outcome) {
      if (ended) return;
      ended = true;
      active.delete(trace);
      const ms = Date.now() - trace.startedAt;
      const line = `[MarmotDiag] dm set-up ${trace.peer} ${outcome} in ${ms}ms: ${trace.marks.join(' | ') || 'no stages'}`;
      if (outcome !== 'ok' || ms > DM_SETUP_SLOW_MS) console.warn(line);
      else if (__DEV__) console.log(line);
    },
  };
}

/** Record a stage on every set-up in progress (no-op when there is none). */
export function markDmSetup(stage: string): void {
  if (active.size === 0) return;
  const now = Date.now();
  for (const trace of active) {
    if (trace.marks.length < MAX_MARKS) trace.marks.push(`${stage} +${now - trace.startedAt}ms`);
  }
}
