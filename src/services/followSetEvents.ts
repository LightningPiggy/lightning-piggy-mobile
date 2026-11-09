import type { NostrContact } from '../types/nostr';
import { buildFollowSet } from '../utils/followPubkeys';
import {
  createLiveSubFollowGateBuffer,
  type DeferredFollowGateEntry,
} from '../contexts/liveSubFollowGate';

/** One canonical gate per viewer, independent of React and relay subscription lifetimes. */
export function createFollowGateStore() {
  return {
    followPubkeysRef: { current: new Set<string>() },
    followHydratedRef: { current: false },
    followGateBufferRef: { current: createLiveSubFollowGateBuffer() },
    deferredReplayRef: { current: null as ((item: DeferredFollowGateEntry) => void) | null },
    adopted: false,
  };
}
type FollowGateStore = ReturnType<typeof createFollowGateStore>;
let sessionGeneration = 0;

/** Capture before asynchronous follow work, including a queued local write. */
export function captureFollowSession(): () => boolean {
  const generation = sessionGeneration;
  return () => generation === sessionGeneration;
}

const stores = new Map<string, FollowGateStore>();
type Listener = () => void;
const listeners = new Map<string, Set<Listener>>();

export function getFollowGateStore(owner: string): FollowGateStore {
  const key = owner.toLowerCase();
  let store = stores.get(key);
  if (!store) {
    store = createFollowGateStore();
    stores.set(key, store);
  }
  return store;
}

/** Account switch/sign-out only. Subscription teardown must never call this. */
export function clearFollowGateStores(): void {
  sessionGeneration++;
  for (const store of stores.values()) {
    store.followGateBufferRef.current.clear();
    store.followPubkeysRef.current = new Set();
    store.followHydratedRef.current = false;
    store.deferredReplayRef.current = null;
    store.adopted = false;
  }
  stores.clear();
}

/** `onDrop` gets each entry reconciliation turns away (not followed). */
export function replayFollowGateStore(
  store: FollowGateStore,
  onDrop?: (item: DeferredFollowGateEntry) => void,
): void {
  const replay = store.deferredReplayRef.current;
  if (!store.followHydratedRef.current || !replay) return;
  const buffer = store.followGateBufferRef.current;
  if (__DEV__) console.log(`[Nostr] follow-gate replay: start buffered=${buffer.size}`);
  let released = 0;
  buffer.reevaluate(store.followPubkeysRef.current, (item) => {
    released++;
    replay(item);
  });
  const dropped = buffer.size;
  buffer.clear(onDrop);
  if (__DEV__) console.log(`[Nostr] follow-gate replay: ${released} released, ${dropped} dropped`);
}

export function subscribeFollowSet(owner: string, listener: Listener): () => void {
  const key = owner.toLowerCase();
  const owned = listeners.get(key) ?? new Set<Listener>();
  owned.add(listener);
  listeners.set(key, owned);
  return () => {
    owned.delete(listener);
    if (owned.size === 0) listeners.delete(key);
  };
}

export function publishFollowSet(
  owner: string,
  contacts: NostrContact[],
  createdAt?: number,
): void {
  const store = getFollowGateStore(owner);
  store.followPubkeysRef.current = buildFollowSet(contacts.map((c) => c.pubkey));
  store.followHydratedRef.current = true;
  store.adopted = true;
  if (__DEV__)
    console.log(
      `[Nostr] follow set: ${store.followPubkeysRef.current.size} follows (kind-3 ${createdAt ?? 'unavailable'})`,
    );
  for (const listener of listeners.get(owner.toLowerCase()) ?? []) listener();
}
