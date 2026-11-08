import { PERF_LOGS_ENABLED, perfLog } from '../utils/perfLog';
import { relayListKey } from '../utils/relayListKey';

/**
 * Perf marker for live DM subscription arms. Every arm re-runs the wrap-id
 * seed queries and opens a fresh REQ per relay, so on-device runs count them:
 *
 *   [Perf] liveDmSub arm #3 reason=relays relays=8 +4120ms
 *
 * `reason` says what differs from the previous arm in this session: the
 * first arm, a new account, a new signer, a different relay set, or none of
 * those (`same-inputs`, e.g. the inbox was re-armed after a sign-in step).
 */
export type LiveDmSubArmReason = 'first' | 'account' | 'signer' | 'relays' | 'same-inputs';

interface ArmInputs {
  viewer: string;
  signer: string;
  relaysKey: string;
}

let armCount = 0;
let lastArm: ArmInputs | null = null;

/** What changed between two arms (pure; exported for tests). */
export function liveDmSubArmReason(prev: ArmInputs | null, next: ArmInputs): LiveDmSubArmReason {
  if (!prev) return 'first';
  if (prev.viewer !== next.viewer) return 'account';
  if (prev.signer !== next.signer) return 'signer';
  if (prev.relaysKey !== next.relaysKey) return 'relays';
  return 'same-inputs';
}

/** Count one arm and log it. No-op (no key work) when perf logs are off. */
export function noteLiveDmSubArm(viewer: string, signer: string, readRelays: readonly string[]) {
  if (!PERF_LOGS_ENABLED) return;
  armCount += 1;
  const next = { viewer, signer, relaysKey: relayListKey(readRelays) };
  const reason = liveDmSubArmReason(lastArm, next);
  lastArm = next;
  perfLog(`liveDmSub arm #${armCount} reason=${reason} relays=${readRelays.length}`);
}
