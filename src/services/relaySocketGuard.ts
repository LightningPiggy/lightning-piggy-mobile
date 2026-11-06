/**
 * Close the WebSockets nostr-tools gives up on.
 *
 * `AbstractRelay` (nostr-tools 2.23) abandons its socket without closing it
 * when `connect()` times out or is aborted, and its `close()` only closes a
 * socket that is already OPEN. A socket still CONNECTING at that point keeps
 * connecting, opens later and stays open for the life of the process: the
 * pool has dropped the relay, so nothing ever closes it.
 *
 * On Android that is fatal over time. React Native builds every WebSocket
 * from the shared OkHttp client, and OkHttp keeps one Dispatcher slot per open
 * WebSocket for as long as it stays open (64 in total, 5 per host, shared with
 * `fetch`). Each slow connect that outlives its timeout leaks a slot, so a
 * long-running app ratchets towards a state where one relay (5 orphans to its
 * host), then every relay and HTTP request, can never connect again, while
 * the phone's network is fine. Seen on a Pixel after 2.5 days: 67 established
 * sockets, 6 of them to a relay the app showed as disconnected.
 *
 * Every nostr-tools entry point (`pool`, `abstract-pool`, `nip46`, …) and the
 * Alby SDK bundle their own copy of `AbstractRelay`, so one prototype patch
 * can't reach them all. Instead each pool is guarded (`guardPool`), which
 * guards every relay it creates, whichever copy of the class it comes from.
 */

// WebSocket readyState values (the global isn't defined in every test env).
const CONNECTING = 0;
const OPEN = 1;

type Handler = ((ev: unknown) => void) | null;
type Socket = {
  readyState: number;
  close: () => void;
  onopen: Handler;
  onmessage: Handler;
  onerror: Handler;
  onclose: Handler;
};
/** The parts of any nostr-tools `AbstractRelay` copy this module touches. */
export type GuardableRelay = {
  connect: (opts?: { timeout?: number; abort?: AbortSignal }) => Promise<void>;
  close: () => void;
  readonly connected: boolean;
  /** Set by pools; the SDK pool's deletes the relay's URL unconditionally. */
  onclose: (() => void) | null;
};

/** `ws` is private in nostr-tools' typings but a plain field at runtime. */
const socketOf = (relay: GuardableRelay): Socket | undefined =>
  (relay as unknown as { ws?: Socket }).ws;

/**
 * Run one of nostr-tools' socket handlers so the relay resets its own state,
 * without its `onclose` callback. That callback already ran when the pool
 * dropped the relay, and the SDK pool's version deletes the relay's URL from
 * the pool unconditionally, which would evict a replacement relay by now.
 */
function resetQuietly(relay: GuardableRelay, handler: Handler, ev: unknown): void {
  const notify = relay.onclose;
  relay.onclose = null;
  try {
    handler?.(ev);
  } finally {
    relay.onclose = notify;
  }
}

/**
 * End a socket the relay has given up on, now or as soon as it opens, without
 * ever reporting it as connected. With `forward`, its close / error events
 * still reset the relay's connection state while it owns the socket (an abort
 * skips that reset). Never once the relay has moved on to a newer socket,
 * where they would tear that down.
 */
function retireSocket(relay: GuardableRelay, ws: Socket | undefined, forward = false): void {
  if (!ws || (ws.readyState !== CONNECTING && ws.readyState !== OPEN)) return;
  const owned = () => forward && socketOf(relay) === ws;
  const { onclose, onerror } = ws;
  ws.onmessage = null;
  ws.onerror = (ev) => {
    if (owned()) resetQuietly(relay, onerror, ev);
  };
  ws.onclose = (ev) => {
    if (owned()) resetQuietly(relay, onclose, ev);
  };
  // React Native ignores close() while CONNECTING (the native socket isn't
  // registered yet) and then still delivers `open`, so close again there.
  ws.onopen = () => ws.close();
  try {
    ws.close();
  } catch {
    // Already closing; the onopen above still ends it.
  }
}

const guardedRelays = new WeakSet<object>();

/** Make `relay` close the sockets it abandons. Idempotent. */
export function guardRelay<R extends GuardableRelay>(relay: R): R {
  if (guardedRelays.has(relay)) return relay;
  guardedRelays.add(relay);

  const connect = relay.connect;
  relay.connect = function (opts) {
    const pending = connect.call(relay, opts);
    // connect() creates the socket synchronously (or returns the attempt
    // already in flight), so this is the socket this promise is about.
    const ws = socketOf(relay);
    pending.catch((reason: unknown) => {
      if (socketOf(relay) === ws && relay.connected) return;
      // A timeout or error already ran nostr-tools' hard close. An abort only
      // rejected, so the socket's eventual close must still reset the relay.
      const hardClosed = reason === 'connection timed out' || reason === 'connection failed';
      retireSocket(relay, ws, !hardClosed);
    });
    return pending;
  };

  const close = relay.close;
  relay.close = function () {
    const ws = socketOf(relay);
    // Read the state first: older bundled copies (the Alby SDK's) call
    // ws.close() unconditionally, which React Native turns into CLOSING.
    const wasConnecting = ws?.readyState === CONNECTING;
    close.call(relay);
    if (!ws || !wasConnecting) return;
    // Closed mid-connect: let the open settle the pending connect() as before,
    // then reset the relay to closed and end the socket. If the relay has
    // started a newer socket meanwhile, just retire this one.
    const opened = ws.onopen;
    ws.onopen = (ev: unknown) => {
      if (socketOf(relay) !== ws) {
        retireSocket(relay, ws);
        return;
      }
      opened?.(ev);
      const closed = ws.onclose;
      retireSocket(relay, ws);
      // nostr-tools reads `.message` from the close event it is handed.
      resetQuietly(relay, closed, { code: 1000, reason: 'closed by us' });
    };
  };
  return relay;
}

type RelayMap = Map<string, GuardableRelay>;
const hookedMaps = new WeakSet<object>();
const guardedPools = new WeakSet<object>();

function hookRelayMap(relays: RelayMap): RelayMap {
  if (!relays || hookedMaps.has(relays)) return relays;
  hookedMaps.add(relays);
  relays.forEach((relay) => guardRelay(relay));
  const set = relays.set.bind(relays);
  relays.set = (url, relay) => set(url, guardRelay(relay));
  return relays;
}

/**
 * Guard every relay `pool` holds now or adds later. nostr-tools pools put a
 * new relay in `relays` before connecting it, so it is guarded in time.
 * `destroy()` swaps in a fresh map, so `relays` becomes an accessor that
 * hooks whichever map is assigned.
 */
export function guardPool<P extends object>(pool: P): P {
  if (guardedPools.has(pool)) return pool;
  guardedPools.add(pool);
  // Typed loosely: each bundled nostr-tools copy has its own AbstractRelay type.
  const maps = new WeakMap<object, RelayMap>();
  maps.set(pool, hookRelayMap((pool as unknown as { relays: RelayMap }).relays));
  Object.defineProperty(pool, 'relays', {
    configurable: true,
    enumerable: true,
    // Per receiver: resumablePool gives each connect attempt its own map on an
    // Object.create(pool) view, which must not replace the pool's map.
    get(this: object) {
      for (let o: object | null = this; o; o = Object.getPrototypeOf(o)) {
        const map = maps.get(o);
        if (map) return map;
      }
      return undefined;
    },
    set(this: object, next: RelayMap) {
      maps.set(this, hookRelayMap(next));
    },
  });
  return pool;
}
