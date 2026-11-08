// The active Marmot session (one per signed-in account) and the per-owner
// drains a stopped session leaves behind. Split out of marmotSession.ts; the
// functions are re-exported from there, so importers are unchanged.
import type { MarmotSession } from './marmotSession';
import * as fence from './marmotSessionFence';

let active: MarmotSession | null = null;
const activeListeners = new Set<(s: MarmotSession | null) => void>();
/** Per-owner promise for a stopped session's push work to settle. */
export const pushDrains = new Map<string, Promise<void>>();

/**
 * Before wiping `owner`'s Marmot storage: stop their session if it is still
 * active and wait for its queued push-state writes to settle, so none lands
 * after the wipe.
 */
export async function quiesceMarmotSession(owner: string): Promise<void> {
  if (active?.pubkey === owner) active.stop();
  await pushDrains.get(owner)?.catch(() => undefined);
  pushDrains.delete(owner);
  // Anything still running past the bounded wait must not touch the wipe.
  fence.fenceStoppedSessions(owner);
}

export function getMarmotSession(): MarmotSession | null {
  return active;
}

export function setMarmotSession(session: MarmotSession | null): void {
  if (active && active !== session) active.stop();
  active = session;
  for (const l of activeListeners) l(session);
}

/** Listen for the active session; fires immediately with the current one. */
export function subscribeMarmotSession(listener: (s: MarmotSession | null) => void): () => void {
  activeListeners.add(listener);
  listener(active);
  return () => activeListeners.delete(listener);
}
