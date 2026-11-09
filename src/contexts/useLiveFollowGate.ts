import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import {
  createFollowGateStore,
  getFollowGateStore,
  replayFollowGateStore,
  subscribeFollowSet,
} from '../services/followSetEvents';
import type { DeferredFollowGateEntry } from './liveSubFollowGate';
import { notifyDroppedDeferred } from './liveDmAudienceNotify';

/** Canonical account state survives hook remounts and subscription re-opens. */
export function useLiveFollowGate(follows: Set<string>, hydrated: boolean, owner?: string | null) {
  const [unowned] = useState(createFollowGateStore);
  const store = owner ? getFollowGateStore(owner) : unowned;
  // A held message reconciliation turns away may still notify per the tier.
  const onDrop = useMemo(
    () =>
      owner ? (item: DeferredFollowGateEntry) => notifyDroppedDeferred(owner, item) : undefined,
    [owner],
  );
  useLayoutEffect(() => {
    if (!owner) return;
    return subscribeFollowSet(owner, () => replayFollowGateStore(store, onDrop));
  }, [owner, store, onDrop]);
  useEffect(() => {
    // Cache paints and delayed UI props must not roll back authoritative adoption.
    if (store.adopted) return;
    store.followPubkeysRef.current = follows;
    store.followHydratedRef.current = hydrated;
    if (hydrated) replayFollowGateStore(store, onDrop);
  }, [follows, hydrated, store, onDrop]);
  const setDeferredReplay = useCallback(
    (replay: ((item: DeferredFollowGateEntry) => void) | null) => {
      store.deferredReplayRef.current = replay;
      // Adoption may have completed while the subscription was closed.
      if (replay) replayFollowGateStore(store, onDrop);
    },
    [store, onDrop],
  );
  return { ...store, setDeferredReplay };
}
