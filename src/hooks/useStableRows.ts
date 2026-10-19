import { useMemo, useRef } from 'react';
import { reuseUnchangedRows } from '../utils/reuseUnchangedRows';

/**
 * `rows`, with each unchanged row (and the whole array, when nothing changed)
 * kept as the object from the previous build — see `reuseUnchangedRows`. Lets
 * a chat list's memoised rows skip re-rendering on unrelated updates.
 */
export function useStableRows<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const prev = useRef<readonly T[]>([]);
  return useMemo(() => {
    const stable = reuseUnchangedRows(prev.current, rows, keyOf);
    prev.current = stable;
    return stable;
  }, [rows, keyOf]);
}
