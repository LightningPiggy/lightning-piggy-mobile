import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadPiggies, type HiddenPiggy } from '../services/piggyStorageService';

interface OwnedPiggies {
  owner: string | null;
  byId: Map<string, HiddenPiggy>;
}

const NONE: ReadonlyMap<string, HiddenPiggy> = new Map();

/**
 * The signed-in account's local `HiddenPiggy` records (LNURL bearer links,
 * tag PINs) keyed by id, for My Piglets (#1781). Every snapshot is stamped
 * with the account it was loaded for and only surfaces while that account
 * is still active, so after an account switch the previous account's
 * records are never rendered, not even for the frame before the reload
 * lands. Optimistic patches name their owner for the same reason: a
 * republish or delete finishing after a switch can't write into the next
 * account's list.
 */
export function useOwnedPiggies(owner: string | null) {
  const [state, setState] = useState<OwnedPiggies>({ owner: null, byId: new Map() });

  const reloadPiggies = useCallback(async () => {
    const list = await loadPiggies(owner);
    setState({ owner, byId: new Map(list.map((p) => [p.id, p])) });
  }, [owner]);

  useEffect(() => {
    let cancelled = false;
    loadPiggies(owner).then((list) => {
      if (!cancelled) setState({ owner, byId: new Map(list.map((p) => [p.id, p])) });
    });
    return () => {
      cancelled = true;
    };
  }, [owner]);

  const piggiesById = useMemo(
    () => (owner && state.owner === owner ? state.byId : NONE),
    [owner, state],
  );

  const patch = useCallback(
    (forOwner: string, update: (byId: Map<string, HiddenPiggy>) => void) =>
      setState((s) => {
        if (s.owner !== forOwner) return s;
        const byId = new Map(s.byId);
        update(byId);
        return { owner: s.owner, byId };
      }),
    [],
  );
  const upsertPiggy = useCallback(
    (forOwner: string, piggy: HiddenPiggy) => patch(forOwner, (m) => m.set(piggy.id, piggy)),
    [patch],
  );
  const dropPiggy = useCallback(
    (forOwner: string, id: string) => patch(forOwner, (m) => m.delete(id)),
    [patch],
  );

  return { piggiesById, reloadPiggies, upsertPiggy, dropPiggy };
}
