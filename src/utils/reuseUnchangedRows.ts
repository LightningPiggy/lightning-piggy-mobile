/** Nesting depth past which rows stop being compared (and count as changed). */
const MAX_DEPTH = 8;

/**
 * Do two pieces of plain row data hold the same values? Primitives, arrays
 * and plain objects compare by value; anything else (a Map, a Date, a
 * function) only by reference — so a row is never wrongly treated as
 * unchanged.
 */
export function sameRowData(a: unknown, b: unknown, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameRowData(value, b[i], depth + 1));
  }
  const proto = Object.getPrototypeOf(a);
  if ((proto !== Object.prototype && proto !== null) || Object.getPrototypeOf(b) !== proto) {
    return false;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(right, key) &&
      sameRowData(left[key], right[key], depth + 1),
  );
}

/**
 * Chat timelines are rebuilt from scratch on every update (a relay event, a
 * delivery tick, a profile landing), so every row comes back as a new object
 * and every memoised bubble on screen re-renders. This keeps the previous
 * object for each row whose data didn't change — and the previous array when
 * nothing changed at all — so only the rows that really changed re-render.
 */
export function reuseUnchangedRows<T>(
  prev: readonly T[],
  next: T[],
  keyOf: (row: T) => string,
): T[] {
  if (prev.length === 0) return next;
  const byKey = new Map<string, T>();
  for (const row of prev) byKey.set(keyOf(row), row);
  let changed = prev.length !== next.length;
  const rows = next.map((row, i) => {
    const old = byKey.get(keyOf(row));
    const kept = old !== undefined && sameRowData(old, row) ? old : row;
    if (kept !== prev[i]) changed = true;
    return kept;
  });
  return changed ? rows : (prev as T[]);
}
