import { PERF_LOGS_ENABLED } from '../utils/perfLog';

/** Receive-queue lanes (see `nostrRelayReceiveQueue`). */
export type ReceiveLane = 'inbox' | 'normal';

/** One `[Perf]` line per window at most, never one per event. */
export const RECEIVE_PERF_WINDOW_MS = 5_000;
const MAX_SAMPLES = 512;

type Series = { n: number; max: number; samples: number[] };
const series = (): Series => ({ n: 0, max: 0, samples: [] });
let wait: Record<ReceiveLane, Series> = { inbox: series(), normal: series() };
let inboxEose = series();
let gateMs = 0;
let windowStart = 0;

function add(s: Series, ms: number): void {
  s.n++;
  if (ms > s.max) s.max = ms;
  // Reservoir sample: bounded memory and an unbiased p50 for a long drain.
  if (s.samples.length < MAX_SAMPLES) s.samples.push(ms);
  else {
    const slot = Math.floor(Math.random() * s.n);
    if (slot < MAX_SAMPLES) s.samples[slot] = ms;
  }
  if (!windowStart) windowStart = Date.now();
}

const p50 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
};
const summary = (label: string, s: Series): string =>
  s.n ? `${label} n=${s.n} p50=${p50(s.samples)}ms max=${s.max}ms` : `${label} n=0`;

/** Time a job spent queued in `lane` before it ran. */
export function recordReceiveWait(lane: ReceiveLane, ms: number): void {
  if (PERF_LOGS_ENABLED) add(wait[lane], ms);
}

/** Wire EOSE (or EOSE timeout) of an inbox subscription to its `oneose` handler. */
export function recordInboxEoseLatency(ms: number): void {
  if (PERF_LOGS_ENABLED) add(inboxEose, ms);
}

/** Time a drain held ALL queued work waiting for verify-cache hydration (the
 * cold-start gate). Frames queued during the gate wait at least this long in
 * either lane, so a large lane wait can be told apart from lane scheduling. */
export function recordReceiveGate(ms: number): void {
  if (!PERF_LOGS_ENABLED || ms <= 0) return;
  gateMs += ms;
  if (!windowStart) windowStart = Date.now() - ms;
}

/** The window's `[Perf]` line, resetting it, once it is RECEIVE_PERF_WINDOW_MS
 * old; undefined (a cheap no-op) otherwise. */
export function takeReceiveWindow(now = Date.now()): string | undefined {
  if (!PERF_LOGS_ENABLED || !windowStart || now - windowStart < RECEIVE_PERF_WINDOW_MS) return;
  const line = `[Perf] relay receive window=${now - windowStart}ms wait ${summary('inbox', wait.inbox)} · ${summary('normal', wait.normal)} · inbox EOSE→handler ${summary('', inboxEose).trim()} · hydration gate=${gateMs}ms`;
  wait = { inbox: series(), normal: series() };
  inboxEose = series();
  gateMs = 0;
  windowStart = 0;
  return line;
}

/** Called by the drain loop per job: logs at most once per window. */
export function maybeLogReceiveWindow(now = Date.now()): void {
  const line = takeReceiveWindow(now);
  if (line) console.log(line);
}
