export type GeocacheRailState = 'loading' | 'ready' | 'empty' | 'error';

/** Visible cached/live content wins over backfill status, including on retry. */
export function deriveGeocacheRailState(
  visibleCount: number,
  hasPosition: boolean,
  completion: { allRelaysFailed: boolean } | null,
): GeocacheRailState {
  if (visibleCount > 0) return 'ready';
  if (!hasPosition) return 'empty';
  if (completion === null) return 'loading';
  return completion.allRelaysFailed ? 'error' : 'empty';
}
