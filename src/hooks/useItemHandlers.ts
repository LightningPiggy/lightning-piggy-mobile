import { useMemo } from 'react';

/**
 * Per-row callbacks that keep their identity while the row (and the builders)
 * do. Building `onLongPress={build(item)}` inline in a FlatList `renderItem`
 * hands every row a new function on every render, which defeats the row's
 * `React.memo` — every bubble on screen re-renders whenever anything about the
 * screen changes. Cached by row object, so pair it with stable rows
 * (`useStableRows`).
 */
export function useItemHandlers<T extends object, A, B>(
  buildOnLongPress: (item: T) => A,
  buildOnToggleReaction: (item: T) => B,
): (item: T) => { onLongPress: A; onToggleReaction: B } {
  return useMemo(() => {
    const cache = new WeakMap<T, { onLongPress: A; onToggleReaction: B }>();
    return (item: T) => {
      let handlers = cache.get(item);
      if (!handlers) {
        handlers = {
          onLongPress: buildOnLongPress(item),
          onToggleReaction: buildOnToggleReaction(item),
        };
        cache.set(item, handlers);
      }
      return handlers;
    };
  }, [buildOnLongPress, buildOnToggleReaction]);
}
