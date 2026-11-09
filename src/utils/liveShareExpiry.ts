import type { LiveLocationMarker } from '../services/liveLocationService';
import { liveKey } from '../services/liveLocationUpdateStore';

/** The fields of a thread's live-location marker this decision reads. */
export interface LiveShareMarkerLike {
  sender: string;
  marker: Pick<LiveLocationMarker, 'phase' | 'sessionId' | 'startedAt' | 'durationMs'>;
}

/**
 * When the next still-running live share in a thread expires (#1792).
 *
 * A share is running while its `start` marker has no `end` marker from the
 * same sender for the same session, and `now` is before
 * `startedAt + durationMs`. Returns the earliest such expiry (epoch ms), or
 * `null` when nothing is running — the thread's 1 Hz countdown tick only
 * needs to run while this is non-null.
 */
export function nextLiveShareExpiry(markers: readonly LiveShareMarkerLike[], now: number) {
  const ended = new Set<string>();
  for (const m of markers) {
    if (m.marker.phase === 'end') ended.add(liveKey(m.sender, m.marker.sessionId));
  }
  let next: number | null = null;
  for (const m of markers) {
    if (m.marker.phase !== 'start') continue;
    if (ended.has(liveKey(m.sender, m.marker.sessionId))) continue;
    const expiresAt = m.marker.startedAt + m.marker.durationMs;
    if (now >= expiresAt) continue;
    if (next === null || expiresAt < next) next = expiresAt;
  }
  return next;
}
